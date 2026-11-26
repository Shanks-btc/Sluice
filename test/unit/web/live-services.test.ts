// The live pages' paid-call and history code run against the real thing: a local chain with the real contracts, a real facilitator and a real
// hosted tool server, served over HTTP, with a mocked wallet that signs with a throwaway key. It is a test of the code, run on this machine
// with no value; nothing in it is a record of anything live. The fast, mocked version of the same cases is live-logic.test.ts.
//
// Cases: read the tool server, pay for a call end to end and follow it to a receipt built from the chain, then the failures that need a real
// service to produce: a kill switch that is turned on after the quote, a facilitator that goes down, a payment used twice, a balance that
// was taken out between the quote and the payment, and the activity list and its file read from real events.
import type { Server } from "node:http";
import { expect } from "chai";
import { Wallet, hexlify, parseEther, randomBytes } from "ethers";
import { ERRORS, createLogger } from "@sluice/sdk";
import { Facilitator, KillSwitch, createServer, listen } from "@sluice/facilitator";
import { createToolServer, readToolServerEnv } from "../../../examples/paid-tools/src";
import type { ToolServer } from "../../../examples/paid-tools/src";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { fakeExplorer } from "../../helpers/explorer";
import { MockWallet } from "../../helpers/mock-wallet";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";
import { explain } from "../../../apps/web/src/lib/errors";
import { FlowSession, planDeposit } from "../../../apps/web/src/lib/flows";
import type { FlowDeps } from "../../../apps/web/src/lib/flows";
import { attachTimestamps, readHistory, toCsv } from "../../../apps/web/src/lib/history";
import { MAINNET } from "../../../apps/web/src/lib/networks";
import { PaidCallSession, planPaidCall, readToolServer, trackSettlement } from "../../../apps/web/src/lib/paid-call";
import type { PaidCallDeps, ToolServerInfo } from "../../../apps/web/src/lib/paid-call";
import { openReader } from "../../../apps/web/src/lib/reads";

describe("Live pages against a real tool server, facilitator and chain", function () {
  this.timeout(240_000);
  let s: Stack;
  let tools: ToolServer;
  let toolsUrl: string;
  let builder: string;
  let payer: Wallet;
  let mock: MockWallet;
  const extra: Array<() => Promise<void>> = [];

  const startTools = async (facilitatorUrl: string): Promise<{ tools: ToolServer; url: string }> => {
    const t = await createToolServer({
      env: readToolServerEnv({ SLUICE_NETWORK: "local", SLUICE_ROUTER: s.routerAddress, SLUICE_PAYEE: builder, SLUICE_FACILITATOR_URL: facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, SLUICE_TOOLS_PORT: "0" }),
      logger: createLogger({ write: () => undefined }),
      explorer: fakeExplorer(s.provider),
    });
    extra.push(() => t.close());
    return { tools: t, url: `http://127.0.0.1:${await t.listen()}` };
  };

  const depsFor = async (over: Partial<PaidCallDeps> = {}): Promise<PaidCallDeps> => ({
    wallet: mock,
    account: mock.address,
    chainId: 1990,
    reader: await openReader(s.provider, { router: s.routerAddress, vault: s.vaultAddress }),
    facilitatorUrl: s.facilitatorUrl,
    now: s.clock,
    toolsUrl,
    sessionCapUnits: 1_000_000,
    network: MAINNET,
    ...over,
  });

  const serverInfo = async (deps: PaidCallDeps): Promise<ToolServerInfo> => {
    const read = await readToolServer(deps.toolsUrl, { chainId: 1990, router: s.routerAddress });
    if (!read.ok) throw new Error(`the tool server was not read: ${read.reason}`);
    return read.info;
  };

  const pay = async (deps: PaidCallDeps, tool = "contract_lookup", args: Record<string, unknown> = { address: s.tokenAddress }) => {
    const planned = await planPaidCall(deps, await serverInfo(deps), tool, args);
    if (!planned.ok) throw new Error(`the plan was refused: ${planned.reason}`);
    const session = new PaidCallSession(planned.plan, deps);
    session.confirm();
    return { session, plan: planned.plan, result: await session.send() };
  };

  beforeEach(async () => {
    await freshChain(); // the tool server reads the wall clock
    s = await startStack({ feeBps: 100 });
    builder = throwawayWallet().address;
    ({ tools, url: toolsUrl } = await startTools(s.facilitatorUrl));
    void tools;
    payer = throwawayWallet();
    mock = new MockWallet(s.provider, { chainId: 1990 }, payer);
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("1"));
  });
  afterEach(async () => {
    for (const close of extra.splice(0)) await close();
    await s.stop();
  });

  it("reads the real tool server: its router, its payee and its tools with their prices", async () => {
    const read = await readToolServer(toolsUrl, { chainId: 1990, router: s.routerAddress });
    expect(read.ok).to.equal(true);
    if (read.ok) {
      expect(read.info.payee).to.equal(builder);
      expect(read.info.router).to.equal(s.routerAddress);
      expect(read.info.tools.map((t) => t.name).sort()).to.deep.equal(["contract_lookup", "dex_quote", "token_risk_check"]);
    }
    const other = await readToolServer(toolsUrl, { chainId: 1983, router: s.routerAddress });
    expect(other.ok).to.equal(false);
    await tools.close();
    expect(await readToolServer(toolsUrl, { chainId: 1990, router: s.routerAddress })).to.deep.include({ ok: false, down: true });
  });

  it("pays for a real call: one signature, the tool's own answer, and a receipt built from the router's event once the facilitator settles it", async function () {
    const deps = await depsFor();
    const before = (await s.router.payerBalance(payer.address)) as bigint;
    const { plan, result } = await pay(deps);
    expect(mock.count("eth_signTypedData_v4")).to.equal(1);
    expect(mock.count("eth_sendTransaction"), "the payer sent no transaction: the facilitator does that").to.equal(0);
    expect((result.output as { address: string }).address).to.equal(s.tokenAddress);
    expect(result.status).to.equal("queued");
    expect(result.intentId).to.match(/^0x[0-9a-f]{64}$/);

    // Nothing is settled yet: the tracker says so, and does not invent a receipt.
    const pending = await trackSettlement(deps, result.intentId as string, plan.intent.nonce, payer.address, { timeoutMs: 0, sleep: async () => undefined });
    expect(pending.state).to.equal("pending");

    await s.facilitator.flush();
    const view = await trackSettlement(deps, result.intentId as string, plan.intent.nonce, payer.address, { sleep: async () => undefined });
    expect(view.state).to.equal("settled");
    if (view.state !== "settled") return;
    expect(view.receipt).to.deep.include({ payer: payer.address, payee: builder, amount: USDC("0.005"), toolId: plan.quote.toolId, nonce: plan.intent.nonce });
    expect(view.receipt.fee).to.equal(USDC("0.005") / 100n); // 1%, from the builder's side
    expect(view.receipt.explorerUrl).to.equal(`https://mainnet.qie.digital/tx/${view.receipt.transaction}`);
    expect(view.receipt.blockNumber).to.be.greaterThan(0);

    expect(await s.router.payerBalance(payer.address)).to.equal(before - USDC("0.005"));
    expect(await s.router.earnings(builder)).to.equal(USDC("0.005") - USDC("0.005") / 100n);
  });

  it("deposits through the same review the wallet page uses, then pays for a call from what was deposited", async () => {
    const wallet = throwawayWallet();
    const second = new MockWallet(s.provider, { chainId: 1990 }, wallet);
    await fundWallet(s, wallet, USDC("3"), parseEther("1"));
    const base: FlowDeps = { wallet: second, account: second.address, chainId: 1990, reader: await openReader(s.provider, { router: s.routerAddress, vault: s.vaultAddress }), now: s.clock };
    const planned = await planDeposit(base, USDC("0.1"));
    expect(planned.ok).to.equal(true);
    if (!planned.ok) return;
    const progress: string[] = [];
    const session = new FlowSession(planned.plan, base);
    session.watch((p) => progress.push(p.stage));
    session.confirm();
    const done = await session.send();
    expect(done.transactions).to.have.length(2); // approve, then deposit
    expect(progress).to.include("wallet").and.to.include("network");
    expect(await s.router.payerBalance(wallet.address)).to.equal(USDC("0.1"));
    const deps = await depsFor({ wallet: second, account: second.address });
    const { result } = await pay(deps, "token_risk_check");
    expect(result.amount).to.equal(USDC("0.01"));
    expect(await s.router.payerBalance(wallet.address)).to.equal(USDC("0.1")); // not yet settled: the balance moves when the facilitator settles
  });

  it("will not plan a call the prepaid balance cannot cover, and signs nothing", async () => {
    const poor = throwawayWallet();
    const m = new MockWallet(s.provider, { chainId: 1990 }, poor);
    await fundWallet(s, poor, USDC("1"), parseEther("1"));
    const deps = await depsFor({ wallet: m, account: m.address });
    const planned = await planPaidCall(deps, await serverInfo(deps), "contract_lookup", { address: s.tokenAddress });
    expect(planned).to.deep.include({ ok: false, kind: "insufficient_prepaid" });
    expect(m.count("eth_signTypedData_v4")).to.equal(0);
  });

  it("a payment submitted twice for the same call is answered twice and charged once, and for another call is refused as a duplicate", async () => {
    const deps = await depsFor();
    const planned = await planPaidCall(deps, await serverInfo(deps), "contract_lookup", { address: s.tokenAddress });
    if (!planned.ok) throw new Error(planned.reason);
    const first = new PaidCallSession(planned.plan, deps);
    first.confirm();
    const one = await first.send();
    // A retry of the same payment for the same call (a refresh, a double tap): the tool server returns what it already has.
    const again = new PaidCallSession(planned.plan, deps);
    again.confirm();
    const two = await again.send();
    expect(two.intentId).to.equal(one.intentId);
    expect(two.output).to.deep.equal(one.output);
    // The same payment offered for a different call is refused: a payment buys one call.
    const other = new PaidCallSession({ ...planned.plan, args: { address: builder } }, deps);
    other.confirm();
    const error = await rejection(other.send());
    expect(explain(error)).to.deep.include({ kind: "duplicate", retry: "no" });
    await s.facilitator.flush();
    expect(await s.router.earnings(builder)).to.equal(USDC("0.005") - USDC("0.005") / 100n); // charged once
  });

  it("a balance taken out between the quote and the payment is caught, and the person is told to deposit", async () => {
    const deps = await depsFor();
    const planned = await planPaidCall(deps, await serverInfo(deps), "contract_lookup", { address: s.tokenAddress });
    if (!planned.ok) throw new Error(planned.reason);
    const router = s.router.connect(payer.connect(s.provider)) as unknown as { refund: (a: bigint, to: string) => Promise<{ wait: () => Promise<unknown> }> };
    await (await router.refund(USDC("1"), payer.address)).wait();
    const session = new PaidCallSession(planned.plan, deps);
    session.confirm();
    const error = await rejection(session.send());
    expect(explain(error)).to.deep.include({ kind: "insufficient_prepaid", retry: "change" });
  });

  it("a kill switch turned on after the quote refuses the payment with a clear message and charges nothing", async () => {
    const killSwitch = new KillSwitch(false);
    const relayerKey = hexlify(randomBytes(32));
    await setQie(new Wallet(relayerKey).address, parseEther("1"));
    const fac = await Facilitator.create({ provider: s.provider, router: s.routerAddress, relayerKey, now: s.clock, killSwitch });
    const server: Server = createServer(fac, {});
    const facUrl = `http://127.0.0.1:${await listen(server, 0)}`;
    extra.push(async () => {
      fac.stop();
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    });
    const second = await startTools(facUrl);
    const deps = await depsFor({ toolsUrl: second.url, facilitatorUrl: facUrl });
    const planned = await planPaidCall(deps, await serverInfo(deps), "contract_lookup", { address: s.tokenAddress });
    if (!planned.ok) throw new Error(planned.reason);
    killSwitch.engage();
    const session = new PaidCallSession(planned.plan, deps);
    session.confirm();
    const error = await rejection(session.send());
    const said = explain(error);
    expect(said).to.deep.include({ kind: "kill_switch", retry: "later" });
    expect(said.advice).to.match(/refund/);
    expect(said.funds).to.match(/not charged/);
    expect(await s.router.payerBalance(payer.address)).to.equal(USDC("1"));
    expect((error as unknown as { code: string }).code).to.equal(ERRORS.killSwitch);
  });

  it("a facilitator that has gone away is reported as the facilitator, with the balance untouched", async () => {
    const relayerKey = hexlify(randomBytes(32));
    await setQie(new Wallet(relayerKey).address, parseEther("1"));
    const fac = await Facilitator.create({ provider: s.provider, router: s.routerAddress, relayerKey, now: s.clock });
    const server: Server = createServer(fac, {});
    const facUrl = `http://127.0.0.1:${await listen(server, 0)}`;
    const second = await startTools(facUrl);
    extra.push(async () => fac.stop());
    const deps = await depsFor({ toolsUrl: second.url, facilitatorUrl: facUrl });
    const planned = await planPaidCall(deps, await serverInfo(deps), "contract_lookup", { address: s.tokenAddress });
    if (!planned.ok) throw new Error(planned.reason);
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    const session = new PaidCallSession(planned.plan, deps);
    session.confirm();
    const error = await rejection(session.send());
    expect(explain(error).kind).to.equal("facilitator_down");
    expect(await s.router.payerBalance(payer.address)).to.equal(USDC("1"));
  });

  it("a tool server that has gone away is reported as the tool server, and the wallet is asked for nothing", async () => {
    const deps = await depsFor();
    const planned = await planPaidCall(deps, await serverInfo(deps), "contract_lookup", { address: s.tokenAddress });
    if (!planned.ok) throw new Error(planned.reason);
    await tools.close();
    const session = new PaidCallSession(planned.plan, deps);
    session.confirm();
    const error = await rejection(session.send());
    expect(explain(error).kind).to.equal("tool_down");
  });

  it("lists a wallet's own activity from the router's and the vault's events, newest first, with times and explorer-ready hashes, and writes it as a file", async () => {
    const deps = await depsFor();
    await pay(deps, "contract_lookup");
    await s.facilitator.flush();
    // An agent key authorised and revoked, directly from the wallet, so the vault's events are there too.
    const agent = throwawayWallet().address;
    const vault = s.vault.connect(payer.connect(s.provider)) as unknown as { authorize: (g: unknown, t: unknown[]) => Promise<{ wait: () => Promise<unknown> }>; revoke: (a: string) => Promise<{ wait: () => Promise<unknown> }> };
    await (await vault.authorize({ agent, budget: USDC("0.5"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 3600) }, [{ payee: builder, toolId: `0x${"00".repeat(32)}` }])).wait();
    await (await vault.revoke(agent)).wait();

    const reader = deps.reader;
    const mine = await readHistory(reader, payer.address, { startBlock: 0 });
    expect(mine.rows.map((r) => r.kind)).to.deep.equal(["agent_revoked", "agent_authorised", "payment", "deposit"]);
    expect(mine.scan.reachedStart).to.equal(true);
    expect(mine.scan.cursor).to.equal(null);
    expect(mine.rows[3]).to.deep.include({ label: "Deposit", amount: USDC("1") });
    expect(mine.rows[2]).to.deep.include({ amount: USDC("0.005"), counterparty: builder });
    expect(mine.rows[1]).to.deep.include({ amount: USDC("0.5"), counterparty: agent });
    for (let i = 1; i < mine.rows.length; i++) expect(mine.rows[i - 1]!.blockNumber).to.be.at.least(mine.rows[i]!.blockNumber);
    const timed = await attachTimestamps(reader.provider, mine.rows);
    expect(timed.every((r) => typeof r.timestamp === "number")).to.equal(true);

    const csv = toCsv(timed);
    expect(csv.split("\r\n")).to.have.length(mine.rows.length + 2); // header, the rows and the trailing break
    expect(csv).to.contain(mine.rows[3]!.txHash);
    expect(csv).to.contain("1.000000");

    // The builder sees what it earned, and the payer's rows are not in its list.
    const theirs = await readHistory(reader, builder, { startBlock: 0 });
    expect(theirs.rows.map((r) => r.kind)).to.deep.equal(["earning"]);
    expect(theirs.rows[0]?.counterparty).to.equal(payer.address);
    // A stranger has nothing, and the list says it looked all the way back.
    const nobody = await readHistory(reader, throwawayWallet().address, { startBlock: 0 });
    expect(nobody.rows).to.deep.equal([]);
    expect(nobody.scan.reachedStart).to.equal(true);
  });

  it("looks back from a cursor: a second read continues below the first and finds the older events", async () => {
    const deps = await depsFor();
    await pay(deps, "contract_lookup");
    await s.facilitator.flush();
    const reader = deps.reader;
    const latest = await reader.provider.getBlockNumber();
    const newest = await readHistory(reader, payer.address, { startBlock: 0, window: 100, maxWindows: 1, want: 1 });
    expect(newest.scan.toBlock).to.equal(latest);
    expect(newest.rows.length).to.be.greaterThan(0);
    if (!newest.scan.reachedStart) {
      const older = await readHistory(reader, payer.address, { startBlock: 0, before: newest.scan.cursor, window: 100, maxWindows: 25 });
      expect(older.scan.toBlock).to.equal(newest.scan.cursor);
      expect(older.rows.some((r) => r.kind === "deposit")).to.equal(true);
    }
  });
});
