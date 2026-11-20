// The web app's read paths and flows against the local copy of QIE mainnet, with the real QUSDC. Nothing is sent to QIE: the fork is held in
// this process and every key is a throwaway made here. The risk check reads the public explorer with GET requests, and skips if it is down.
//
// With WRITE_FORK_SAMPLE=1 the run also writes apps/web/src/content/fork-sample.json: the events of the run below, for the landing
// page's proof strip, which shows them only with the label "Sample from a local fork — not mainnet" and with no explorer link.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { parseEther } from "ethers";
import { FacilitatorClient } from "@sluice/sdk/facilitator-client";
import { explorerClient, rpcFromProvider } from "@sluice/paid-tools/rpc";
import { USDC, signedIntent } from "../helpers";
import { MockWallet } from "../helpers/mock-wallet";
import { fundWallet, startStack, throwawayWallet } from "../helpers/stack";
import type { Stack } from "../helpers/stack";
import { QUSDC, QUSDC_ADMIN, QUSDC_VAULT, asAccount } from "../helpers/fork";
import { FlowSession, planAuthorize, planDeposit, planExit } from "../../apps/web/src/lib/flows";
import type { FlowDeps } from "../../apps/web/src/lib/flows";
import { openReader, readBuilder, readPayer } from "../../apps/web/src/lib/reads";
import { makeRiskHandler, QUSDC_EXAMPLE } from "../../apps/web/src/lib/risk-handler";
import { formatUsdc } from "../../apps/web/src/lib/format";

describe("Fork: the web app's read paths and flows on the real QUSDC", function () {
  this.timeout(300_000);
  let s: Stack;
  const sample: Array<{ event: string; amount: string; who: string; hash: string; block: number }> = [];

  before(async () => {
    s = await startStack({ feeBps: 100, fork: true });
  });
  after(async () => {
    await s.stop();
  });

  const reader = () => openReader(s.provider, { router: s.routerAddress, vault: s.vaultAddress });
  const record = async (event: string, amount: bigint, who: string, hash: string) => {
    const receipt = await s.provider.getTransactionReceipt(hash);
    sample.push({ event, amount: formatUsdc(amount), who, hash, block: receipt!.blockNumber });
  };

  it("the router uses the real QUSDC, and the reader finds that out from the chain", async () => {
    const r = await reader();
    expect(r.tokenAddress).to.equal(QUSDC);
    expect(QUSDC_EXAMPLE).to.equal(QUSDC);
  });

  it("a configured vault that is not the router's vault is refused before anything is shown", async () => {
    const err = await openReader(s.provider, { router: s.routerAddress, vault: throwawayWallet().address }).catch((e: Error) => e);
    expect((err as Error).message).to.contain("not the vault this router uses");
  });

  it("deposits real QUSDC from a wallet with QIE: approve exactly the amount, deposit, no allowance left", async () => {
    const mock = new MockWallet(s.provider);
    await fundWallet(s, mock.wallet, USDC("20"), parseEther("1"));
    const deps: FlowDeps = { wallet: mock, account: mock.address, chainId: 1990, reader: await reader(), now: s.clock };
    const planned = await planDeposit(deps, USDC("5"));
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.route).to.equal("wallet");
    expect(planned.plan.fields.find((f) => f.label === "Token")?.value).to.contain(QUSDC);
    const session = new FlowSession(planned.plan, deps);
    session.confirm();
    const result = await session.send();
    expect(await s.router.payerBalance(mock.address)).to.equal(USDC("5"));
    expect(await s.token.allowance(mock.address, s.routerAddress)).to.equal(0n);
    await record("Deposited", USDC("5"), mock.address, result.transactions[1]!);

    const view = await readPayer(await reader(), mock.address, { nowSeconds: s.clock() });
    expect(view.prepaid).to.equal(USDC("5"));
    expect(view.qusdcBalance).to.equal(USDC("15"));
    expect(view.allowance).to.equal(0n);
    expect(view.qieBalance > 0n).to.equal(true);
  });

  it("starts with no QIE on the real QUSDC: the wallet signs, the facilitator sends and tops up the gas", async () => {
    const mock = new MockWallet(s.provider);
    await fundWallet(s, mock.wallet, USDC("12"), 0n);
    const deps: FlowDeps = { wallet: mock, account: mock.address, chainId: 1990, reader: await reader(), facilitator: new FacilitatorClient({ url: s.facilitatorUrl }), facilitatorUrl: s.facilitatorUrl, now: s.clock };
    const planned = await planDeposit(deps, USDC("7"));
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.route).to.equal("facilitator");
    const session = new FlowSession(planned.plan, deps);
    session.confirm();
    await session.send();
    expect(await s.router.payerBalance(mock.address)).to.equal(USDC("7"));
    expect(mock.count("eth_sendTransaction")).to.equal(0);
  });

  it("the builder dashboard's read path: earnings, the fee in effect and the latest settlements, after paid calls", async () => {
    const builder = new MockWallet(s.provider);
    await fundWallet(s, builder.wallet, 0n, parseEther("1"));
    const payer = s.payer;
    await s.mint(payer.address, USDC("3"));
    await s.token.connect(payer).approve(s.routerAddress, USDC("3"));
    await s.router.connect(payer).deposit(USDC("3"));
    let settleHash = "";
    for (const amount of [USDC("0.01"), USDC("1")]) {
      const { intent, signature } = await signedIntent(s, payer, payer.address, builder.address, amount);
      const tx = await s.router.connect(s.stranger).settle(intent, signature);
      settleHash = tx.hash;
    }
    const view = await readBuilder(await reader(), builder.address, { startBlock: 0 });
    // 1% fee, taken from the builder's side: 0.0099 + 0.99.
    expect(view.feeBps).to.equal(100);
    expect(view.earnings).to.equal(USDC("0.0099") + USDC("0.99"));
    expect(view.settlements.map((x) => x.amount)).to.deep.equal([USDC("1"), USDC("0.01")]);
    expect(view.settlements[0]!.fee).to.equal(USDC("0.01"));
    expect(view.settlements[0]!.payer).to.equal(payer.address);
    await record("Settled", USDC("0.01"), payer.address, settleHash);

    // Withdraw through the wallet flow, to a throwaway address.
    const deps: FlowDeps = { wallet: builder, account: builder.address, chainId: 1990, reader: await reader(), now: s.clock };
    const to = throwawayWallet().address;
    const planned = await planExit(deps, "withdraw", USDC("0.5"), to);
    if (!planned.ok) throw new Error(planned.reason);
    const session = new FlowSession(planned.plan, deps);
    session.confirm();
    const result = await session.send();
    expect(await s.token.balanceOf(to)).to.equal(USDC("0.5"));
    await record("Withdrawn", USDC("0.5"), builder.address, result.transactions[0]!);
  });

  it("the payer screen's read path: agent keys with their limits, after an authorisation", async () => {
    const mock = new MockWallet(s.provider);
    await fundWallet(s, mock.wallet, USDC("1"), parseEther("1"));
    const deps: FlowDeps = { wallet: mock, account: mock.address, chainId: 1990, reader: await reader(), now: s.clock };
    const agent = throwawayWallet().address;
    const planned = await planAuthorize(deps, { agent, budget: USDC("2"), perCallCap: USDC("0.25"), expiry: s.clock() + 3600, tools: [{ payee: throwawayWallet().address, toolName: "token_risk_check" }] });
    if (!planned.ok) throw new Error(planned.reason);
    const session = new FlowSession(planned.plan, deps);
    session.confirm();
    await session.send();
    const view = await readPayer(await reader(), mock.address, { nowSeconds: s.clock(), startBlock: 0 });
    expect(view.sessions).to.have.length(1);
    expect(view.sessions[0]).to.deep.include({ agent, status: "active", budget: USDC("2"), perCallCap: USDC("0.25"), spent: 0n, remaining: USDC("2") });
  });

  describe("the risk check on the real QUSDC", () => {
    const post = () => new Request("http://localhost/api/risk", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" }, body: JSON.stringify({ address: QUSDC_EXAMPLE }) });

    before(async () => {
      // The fork is shared with the other fork tests; put the admin's role back the way the real chain has it.
      const token = s.token;
      const role = (await token.VAULT_ROLE()) as string;
      if ((await token.hasRole(role, QUSDC_ADMIN)) as boolean) {
        await asAccount(QUSDC_ADMIN, async (admin) => void (await (await token.connect(admin).revokeRole(role, QUSDC_ADMIN)).wait()));
      }
    });

    it("without the explorer: the bytecode facts and a note that roles are not listed", async () => {
      const res = await makeRiskHandler({ deps: () => ({ rpc: rpcFromProvider(s.provider) }) })(post());
      const body = (await res.json()) as { ok: boolean; result: { accessControl: { holdersSource: string }; flags: Array<{ code: string }>; functionsFound: Record<string, string[]> } };
      expect(body.ok).to.equal(true);
      expect(body.result.accessControl.holdersSource).to.equal("unavailable");
      expect(body.result.functionsFound.burnFromAnyHolder).to.include("burn(address,uint256)");
      expect(body.result.flags.map((f) => f.code)).to.include("roles_not_listed");
    });

    it("with the explorer: the VAULT_ROLE contract can burn, and the admin can grant that role", async function () {
      const explorer = explorerClient();
      let up = false;
      try {
        up = (await explorer("/api/v2/stats")).status === 200;
      } catch {
        up = false;
      }
      if (!up) this.skip();
      const res = await makeRiskHandler({ deps: () => ({ rpc: rpcFromProvider(s.provider), explorer }) })(post());
      const body = (await res.json()) as { ok: boolean; result: { accessControl: { holdersSource: string }; flags: Array<{ code: string }>; burn: { canBurnNow: Array<{ address: string }> } } };
      if (body.result.accessControl.holdersSource !== "explorer-logs") this.skip();
      expect(body.result.flags.map((f) => f.code)).to.include.members(["admin_can_burn_holders", "role_admin_can_grant_burn"]);
      expect(body.result.burn.canBurnNow.map((b) => b.address)).to.include(QUSDC_VAULT);
    });
  });

  it("writes the landing page's fork sample when asked", () => {
    if (process.env["WRITE_FORK_SAMPLE"] !== "1") return;
    expect(sample.map((x) => x.event)).to.include.members(["Deposited", "Settled", "Withdrawn"]);
    const file = join(__dirname, "..", "..", "apps", "web", "src", "content", "fork-sample.json");
    const content = {
      source: "local fork",
      note: "Written by test/fork/web.fork.test.ts: a deposit, a paid call settled, and a withdrawal, run on a local copy of QIE mainnet with the real QUSDC and throwaway wallets. Nothing was sent to QIE.",
      chainId: 1990,
      rows: sample.filter((x) => ["Deposited", "Settled", "Withdrawn"].includes(x.event)),
    };
    writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  });
});
