// The web app's wallet flows, driven through a mocked EIP-1193 wallet against a local chain with the real contracts and a real
// facilitator. Cases: connect, wrong network, a rejected signature, a wallet with no QIE, confirm-then-send, and cancel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { Interface, TypedDataEncoder, parseEther } from "ethers";
import { FacilitatorClient } from "@sluice/sdk/facilitator-client";
import { AUTHORIZE_TYPES, REVOKE_TYPES, vaultDomain } from "@sluice/sdk/authorize";
import { routerDomain } from "@sluice/sdk/protocol";
import { USDC, signedIntent } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { MockWallet } from "../../helpers/mock-wallet";
import { fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";
import { WalletError, connectWallet, networkState, switchChain, classifyWalletError } from "../../../apps/web/src/lib/eip1193";
import { DIRECT_ABI, FlowSession, NotConfirmedError, REFUND_TYPES, WITHDRAW_TYPES, directInterface, planAuthorize, planDeposit, planExit, planRevoke, validateAuthorize } from "../../../apps/web/src/lib/flows";
import type { FlowDeps } from "../../../apps/web/src/lib/flows";
import { throwawayWallet as makeWallet } from "../../helpers/stack";
import { openReader } from "../../../apps/web/src/lib/reads";
import { NETWORKS } from "../../../apps/web/src/lib/networks";

const root = join(__dirname, "..", "..", "..");
const vectors = JSON.parse(readFileSync(join(root, "docs", "spec-vectors.json"), "utf8"));

describe("Web: wallet flows", function () {
  this.timeout(120_000);
  let s: Stack;
  let counting: { onboard: number; relay: number };

  before(async () => {
    s = await startStack({ feeBps: 100 });
  });
  after(async () => {
    await s.stop();
  });

  const reader = () => openReader(s.provider, { router: s.routerAddress, vault: s.vaultAddress });

  async function setup(options: ConstructorParameters<typeof MockWallet>[1] = {}, balances: { qusdc?: bigint; qie?: bigint } = {}, withFacilitator = true) {
    const mock = new MockWallet(s.provider, options);
    await fundWallet(s, mock.wallet, balances.qusdc ?? USDC("20"), balances.qie ?? parseEther("1"));
    counting = { onboard: 0, relay: 0 };
    const client = new FacilitatorClient({ url: s.facilitatorUrl });
    const facilitator = {
      onboard: (r: Parameters<FacilitatorClient["onboard"]>[0]) => {
        counting.onboard += 1;
        return client.onboard(r);
      },
      relay: (r: Parameters<FacilitatorClient["relay"]>[0]) => {
        counting.relay += 1;
        return client.relay(r);
      },
    };
    const deps: FlowDeps = {
      wallet: mock,
      account: mock.address,
      chainId: 1990,
      reader: await reader(),
      facilitator: withFacilitator ? facilitator : undefined,
      facilitatorUrl: withFacilitator ? s.facilitatorUrl : null,
      now: s.clock,
    };
    return { mock, deps };
  }

  const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(`the plan was refused: ${(r as unknown as { reason: string }).reason}`);
    return r as Extract<T, { ok: true }>;
  };

  describe("connecting and the network", () => {
    it("connects and reports the account and the chain", async () => {
      const { mock } = await setup();
      const c = await connectWallet(mock);
      expect(c.account).to.equal(mock.address);
      expect(c.chainId).to.equal(1990);
      expect(networkState(c.chainId, 1990)).to.equal("ok");
    });

    it("reports a rejected connection as 'rejected' and sends nothing", async () => {
      const { mock } = await setup({ rejectConnect: true });
      const err = await rejection(connectWallet(mock));
      expect((err as WalletError).code).to.equal("rejected");
    });

    it("sees a wrong network, and switching adds the network with QIE's published settings when the wallet does not know it", async () => {
      const { mock } = await setup({ chainId: 1, knownChains: [1] });
      const c = await connectWallet(mock);
      expect(networkState(c.chainId, 1990)).to.equal("wrong");
      await switchChain(mock, NETWORKS.mainnet);
      expect(mock.chainId).to.equal(1990);
      const add = mock.calls.find((x) => x.method === "wallet_addEthereumChain");
      expect(add, "the wallet was asked to add the network").to.not.equal(undefined);
      expect((add!.params as unknown[])[0]).to.deep.equal({
        chainId: "0x7c6",
        chainName: "QIE mainnet",
        nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
        rpcUrls: ["https://rpc1mainnet.qie.digital/"],
        blockExplorerUrls: ["https://mainnet.qie.digital/"],
      });
    });

    it("switching to a network the wallet already knows does not add one", async () => {
      const { mock } = await setup({ chainId: 1, knownChains: [1, 1990] });
      await switchChain(mock, NETWORKS.mainnet);
      expect(mock.count("wallet_addEthereumChain")).to.equal(0);
      expect(mock.chainId).to.equal(1990);
    });

    it("refuses to send from the wrong network, and nothing reaches the wallet's send", async () => {
      const { mock, deps } = await setup();
      const plan = must(await planDeposit(deps, USDC("2"))).plan;
      mock.chainId = 1; // the person switched networks after the review opened
      const session = new FlowSession(plan, deps);
      session.confirm();
      const err = await rejection(session.send());
      expect((err as WalletError).code).to.equal("wrong_network");
      expect(mock.count("eth_sendTransaction")).to.equal(0);
      expect(session.state).to.equal("failed");
    });

    it("sorts the usual wallet error codes", () => {
      expect(classifyWalletError({ code: 4001 })).to.equal("rejected");
      expect(classifyWalletError({ code: "ACTION_REJECTED" })).to.equal("rejected");
      expect(classifyWalletError({ code: 4902 })).to.equal("unknown_chain");
      expect(classifyWalletError({ code: -32002 })).to.equal("request_pending");
      expect(classifyWalletError({ code: -32601 })).to.equal("unsupported_method");
      expect(classifyWalletError(new Error("boom"))).to.equal("failed");
    });
  });

  describe("opening the contracts", () => {
    it("refuses a vault that is not the one the router uses, and a router that is not a router", async () => {
      const wrongVault = await openReader(s.provider, { router: s.routerAddress, vault: makeWallet().address }).catch((e: Error) => e);
      expect((wrongVault as Error).message).to.contain("not the vault this router uses");
      const notRouter = await openReader(s.provider, { router: makeWallet().address, vault: s.vaultAddress }).catch((e: Error) => e);
      expect((notRouter as Error).message).to.contain("could not be read");
    });
  });

  describe("deposit, with QIE for gas", () => {
    it("plans in words: the amount, the router, the approval, the network and the fee", async () => {
      const { deps } = await setup();
      const { plan } = must(await planDeposit(deps, USDC("5")));
      expect(plan.route).to.equal("wallet");
      const field = (label: string) => plan.fields.find((f) => f.label === label)?.value;
      expect(field("Amount")).to.equal("5.000000 QUSDC");
      expect(field("Router")).to.equal(s.routerAddress);
      expect(field("Approval")).to.contain("exactly 5.000000 QUSDC");
      expect(field("Network")).to.equal("QIE mainnet, chain 1990 (real funds)");
      expect(field("Network fee")).to.match(/^up to [\d.]+ QIE \(\d+ gas at [\d.]+ gwei\)$/);
      expect(plan.steps).to.have.length(2);
    });

    it("names the network the site is set to, so a local copy of mainnet is never called real funds", async () => {
      const { deps } = await setup();
      const local = { ...deps, network: NETWORKS.local };
      const { plan } = must(await planDeposit(local, USDC("5")));
      const field = (label: string) => plan.fields.find((f) => f.label === label)?.value;
      expect(field("Network")).to.equal("Local node or fork, chain 1990 (no real funds)");
    });

    it("sends nothing before the person confirms", async () => {
      const { mock, deps } = await setup();
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      const err = await rejection(session.send());
      expect(err).to.be.instanceOf(NotConfirmedError);
      expect(mock.count("eth_sendTransaction")).to.equal(0);
      expect(await s.router.payerBalance(mock.address)).to.equal(0n);
      expect(session.state).to.equal("planned");
    });

    it("confirm then send approves exactly the amount, deposits it, and leaves no allowance", async () => {
      const { mock, deps } = await setup();
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      const result = await session.send();
      expect(result.via).to.equal("wallet");
      expect(result.transactions).to.have.length(2);
      expect(await s.router.payerBalance(mock.address)).to.equal(USDC("5"));
      expect(await s.token.allowance(mock.address, s.routerAddress)).to.equal(0n);
      expect(session.state).to.equal("done");
    });

    it("cancel ends the session and nothing can be sent afterwards", async () => {
      const { mock, deps } = await setup();
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.cancel();
      expect(session.state).to.equal("cancelled");
      expect(await rejection(session.send())).to.be.instanceOf(NotConfirmedError);
      expect(() => session.confirm()).to.throw(/cancelled/);
      expect(mock.count("eth_sendTransaction")).to.equal(0);
    });

    it("cannot be confirmed twice, and a confirmed session can still be cancelled before it sends", async () => {
      const { deps } = await setup();
      const { plan } = must(await planDeposit(deps, USDC("1")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      expect(() => session.confirm()).to.throw(/confirmed/);
      session.cancel();
      expect(await rejection(session.send())).to.be.instanceOf(NotConfirmedError);
    });

    it("a rejected transaction in the wallet is reported as rejected, and nothing moves", async () => {
      const { mock, deps } = await setup({ rejectSend: true });
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      const err = await rejection(session.send());
      expect((err as WalletError).code).to.equal("rejected");
      expect(session.state).to.equal("failed");
      expect(await s.router.payerBalance(mock.address)).to.equal(0n);
    });

    it("refuses an amount above the wallet's QUSDC, and an amount of zero", async () => {
      const { deps } = await setup({}, { qusdc: USDC("1") });
      const tooMuch = await planDeposit(deps, USDC("2"));
      expect(tooMuch.ok).to.equal(false);
      expect((await planDeposit(deps, 0n)).ok).to.equal(false);
    });
  });

  describe("deposit, with no QIE (the facilitator sends it)", () => {
    it("plans the start with no QIE and says the wallet signs without sending", async () => {
      const { deps } = await setup({}, { qie: 0n });
      const { plan } = must(await planDeposit(deps, USDC("5")));
      expect(plan.route).to.equal("facilitator");
      const text = plan.fields.map((f) => `${f.label} ${f.value}`).join("\n");
      expect(text).to.contain("Gas top-up");
      expect(text).to.contain("approve(router, 5.000000 QUSDC)");
      expect(plan.summary).to.contain("without sending");
    });

    it("signs the approval and the deposit, and the facilitator sends both and tops up the gas", async () => {
      const { mock, deps } = await setup({}, { qie: 0n });
      expect(await s.provider.getBalance(mock.address)).to.equal(0n);
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      const result = await session.send();
      expect(result.via).to.equal("facilitator");
      expect(counting.onboard).to.equal(1);
      expect(mock.count("eth_sendTransaction")).to.equal(0);
      expect(mock.count("eth_signTransaction")).to.equal(2);
      expect(await s.router.payerBalance(mock.address)).to.equal(USDC("5"));
    });

    it("a wallet that cannot sign without sending is told so, and nothing reaches the facilitator", async () => {
      const { deps } = await setup({ noSignTransaction: true }, { qie: 0n });
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      const err = (await rejection(session.send())) as WalletError;
      expect(err.code).to.equal("unsupported_method");
      expect(err.message).to.contain("Nothing was sent");
      expect(counting.onboard).to.equal(0);
    });

    it("a rejected signature sends nothing to the facilitator", async () => {
      const { deps } = await setup({ rejectSign: true }, { qie: 0n });
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      expect(((await rejection(session.send())) as WalletError).code).to.equal("rejected");
      expect(counting.onboard).to.equal(0);
    });

    it("is refused with a reason when no facilitator is set", async () => {
      const { deps } = await setup({}, { qie: 0n }, false);
      const planned = await planDeposit(deps, USDC("5"));
      expect(planned.ok).to.equal(false);
      expect((planned as { reason: string }).reason).to.contain("no QIE");
    });
  });

  describe("withdraw and refund", () => {
    async function earn(builder: string, amount: bigint) {
      const payer = s.payer;
      await s.mint(payer.address, amount);
      await s.token.connect(payer).approve(s.routerAddress, amount);
      await s.router.connect(payer).deposit(amount);
      const { intent, signature } = await signedIntent(s, payer, payer.address, builder, amount);
      await s.router.connect(s.stranger).settle(intent, signature);
    }

    it("withdraws earnings through the wallet when it has QIE", async () => {
      const { mock, deps } = await setup();
      await earn(mock.address, USDC("2"));
      const earned = (await s.router.earnings(mock.address)) as bigint;
      const { plan } = must(await planExit(deps, "withdraw", USDC("1"), mock.address));
      expect(plan.route).to.equal("wallet");
      expect(plan.fields.find((f) => f.label === "Recipient")?.value).to.equal(mock.address);
      const session = new FlowSession(plan, deps);
      session.confirm();
      await session.send();
      expect(await s.router.earnings(mock.address)).to.equal(earned - USDC("1"));
    });

    it("withdraws with no QIE by signing a request the facilitator sends, with a relayer fee of zero", async () => {
      const { mock, deps } = await setup({}, { qie: 0n, qusdc: 0n });
      await earn(mock.address, USDC("2"));
      const before = (await s.token.balanceOf(mock.address)) as bigint;
      const { plan } = must(await planExit(deps, "withdraw", USDC("1"), mock.address));
      expect(plan.route).to.equal("facilitator");
      expect(plan.fields.find((f) => f.label === "Relayer fee")?.value).to.contain("0 QUSDC");
      const session = new FlowSession(plan, deps);
      session.confirm();
      await session.send();
      expect(counting.relay).to.equal(1);
      expect(((await s.token.balanceOf(mock.address)) as bigint) - before).to.equal(USDC("1"));
    });

    it("a rejected signature sends nothing to the relayer", async () => {
      const { deps } = await setup({ rejectSign: true }, { qie: 0n, qusdc: 0n });
      await earn(deps.account, USDC("2"));
      const { plan } = must(await planExit(deps, "withdraw", USDC("1"), deps.account));
      const session = new FlowSession(plan, deps);
      session.confirm();
      expect(((await rejection(session.send())) as WalletError).code).to.equal("rejected");
      expect(counting.relay).to.equal(0);
    });

    it("refunds prepaid balance to another address, and warns that the recipient differs", async () => {
      const { mock, deps } = await setup();
      await s.mint(mock.address, USDC("3"));
      await s.token.connect(mock.wallet.connect(s.provider)).approve(s.routerAddress, USDC("3"));
      await s.router.connect(mock.wallet.connect(s.provider)).deposit(USDC("3"));
      const to = throwawayWallet().address;
      const { plan } = must(await planExit(deps, "refund", USDC("1"), to));
      expect(plan.warnings.join(" ")).to.contain("different address");
      const session = new FlowSession(plan, deps);
      session.confirm();
      await session.send();
      expect(await s.token.balanceOf(to)).to.equal(USDC("1"));
    });

    it("refuses an amount above what is available, a zero amount and a bad recipient", async () => {
      const { deps } = await setup();
      expect((await planExit(deps, "withdraw", USDC("1"), deps.account)).ok).to.equal(false);
      expect((await planExit(deps, "withdraw", 0n, deps.account)).ok).to.equal(false);
      expect((await planExit(deps, "refund", USDC("1"), "0x123")).ok).to.equal(false);
      expect((await planExit(deps, "refund", USDC("1"), "0x0000000000000000000000000000000000000000")).ok).to.equal(false);
    });
  });

  describe("what a wallet hands back is checked before it goes anywhere", () => {
    it("refuses a signature made by a different account than the one connected, and relays nothing", async () => {
      const { deps } = await setup({ signAs: makeWallet() }, { qie: 0n, qusdc: 0n });
      await s.mint(s.payer.address, USDC("2"));
      await s.token.connect(s.payer).approve(s.routerAddress, USDC("2"));
      await s.router.connect(s.payer).deposit(USDC("2"));
      const { intent, signature } = await signedIntent(s, s.payer, s.payer.address, deps.account, USDC("2"));
      await s.router.connect(s.stranger).settle(intent, signature);
      const { plan } = must(await planExit(deps, "withdraw", USDC("1"), deps.account));
      const session = new FlowSession(plan, deps);
      session.confirm();
      const err = (await rejection(session.send())) as WalletError;
      expect(err.message).to.contain("different account");
      expect(counting.relay).to.equal(0);
    });

    it("refuses a signed transaction whose call was changed by the wallet, and sends nothing to the facilitator", async () => {
      const { deps } = await setup({ swapSignedTx: true }, { qie: 0n });
      const { plan } = must(await planDeposit(deps, USDC("5")));
      const session = new FlowSession(plan, deps);
      session.confirm();
      const err = (await rejection(session.send())) as WalletError;
      expect(err.message).to.contain("signed something different");
      expect(counting.onboard).to.equal(0);
    });
  });

  describe("agent keys", () => {
    const grant = (agent: string, over: Record<string, unknown> = {}) => ({
      agent,
      budget: USDC("2"),
      perCallCap: USDC("0.5"),
      expiry: s.clock() + 86_400,
      tools: [{ payee: throwawayWallet().address, toolName: "token_risk_check" }],
      ...over,
    });

    it("authorises through the wallet and shows every limit in words", async () => {
      const { deps } = await setup();
      const agent = throwawayWallet().address;
      const { plan } = must(await planAuthorize(deps, grant(agent)));
      const text = plan.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
      expect(text).to.contain(`Agent key: ${agent}`);
      expect(text).to.contain("Budget: 2.000000 QUSDC");
      expect(text).to.contain("Cap per call: 0.500000 QUSDC");
      expect(text).to.match(/Expires: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
      expect(text).to.contain("token_risk_check from");
      const session = new FlowSession(plan, deps);
      session.confirm();
      await session.send();
      const stored = await s.vault.sessionOf(deps.account, agent);
      expect(stored.budget).to.equal(USDC("2"));
      expect(stored.perCallCap).to.equal(USDC("0.5"));
    });

    it("authorises and then revokes with no QIE, by signatures the facilitator sends", async () => {
      const { mock, deps } = await setup({}, { qie: 0n });
      const agent = throwawayWallet().address;
      const planned = must(await planAuthorize(deps, grant(agent)));
      expect(planned.plan.route).to.equal("facilitator");
      const auth = new FlowSession(planned.plan, deps);
      auth.confirm();
      await auth.send();
      expect((await s.vault.sessionOf(mock.address, agent)).budget).to.equal(USDC("2"));

      const revoke = new FlowSession(must(await planRevoke(deps, agent)).plan, deps);
      revoke.confirm();
      await revoke.send();
      expect((await s.vault.sessionOf(mock.address, agent)).id).to.equal(0n);
      expect(counting.relay).to.equal(2);
    });

    it("revokes through the wallet, and says what it does", async () => {
      const { mock, deps } = await setup();
      const agent = throwawayWallet().address;
      const auth = new FlowSession(must(await planAuthorize(deps, grant(agent))).plan, deps);
      auth.confirm();
      await auth.send();
      const { plan } = must(await planRevoke(deps, agent));
      expect(plan.warnings.join(" ")).to.contain("the block this lands in");
      const revoke = new FlowSession(plan, deps);
      revoke.confirm();
      await revoke.send();
      expect((await s.vault.sessionOf(mock.address, agent)).id).to.equal(0n);
    });

    it("refuses to revoke an agent with no session", async () => {
      const { deps } = await setup();
      expect((await planRevoke(deps, throwawayWallet().address)).ok).to.equal(false);
    });

    it("validates the limits before anything is planned", async () => {
      const now = s.clock();
      const base = grant(throwawayWallet().address);
      expect(validateAuthorize(base, now)).to.equal(undefined);
      expect(validateAuthorize({ ...base, agent: "0x12" }, now)).to.contain("agent address");
      expect(validateAuthorize({ ...base, budget: 0n }, now)).to.contain("budget");
      expect(validateAuthorize({ ...base, perCallCap: 0n }, now)).to.contain("cap per call");
      expect(validateAuthorize({ ...base, perCallCap: USDC("3") }, now)).to.contain("cannot be more than the budget");
      expect(validateAuthorize({ ...base, expiry: now - 1 }, now)).to.contain("future");
      expect(validateAuthorize({ ...base, tools: [] }, now)).to.contain("at least one");
      expect(validateAuthorize({ ...base, tools: Array.from({ length: 33 }, () => base.tools[0]!) }, now)).to.contain("at most 32");
      expect(validateAuthorize({ ...base, tools: [{ payee: "nope", toolName: "x" }] }, now)).to.contain("payee");
      expect(validateAuthorize({ ...base, tools: [{ payee: base.tools[0]!.payee, toolName: " " }] }, now)).to.contain("name");
      expect(validateAuthorize({ ...base, tools: [{ payee: base.tools[0]!.payee, toolName: "", anyTool: true }] }, now)).to.equal(undefined);
    });

    it("will not authorise the connected wallet's own address as the agent", async () => {
      const { deps } = await setup();
      const planned = await planAuthorize(deps, grant(deps.account));
      expect(planned.ok).to.equal(false);
    });
  });

  describe("the typed messages match the spec and the contracts", () => {
    it("Withdraw and Refund hash to the spec's digests", () => {
      for (const [name, types] of [["withdraw", WITHDRAW_TYPES], ["refund", REFUND_TYPES]] as const) {
        const v = vectors[name];
        expect(TypedDataEncoder.hash(v.domain, types, v.message), name).to.equal(v.digest);
      }
    });

    it("Authorize and Revoke hash to the spec's digests", () => {
      expect(TypedDataEncoder.hash(vectors.authorize.domain, AUTHORIZE_TYPES, vectors.authorize.message)).to.equal(vectors.authorize.digest);
      expect(TypedDataEncoder.hash(vectors.revoke.domain, REVOKE_TYPES, vectors.revoke.message)).to.equal(vectors.revoke.digest);
    });

    it("the domains are bound to the router and the vault on chain 1990", () => {
      const d = routerDomain("0x51cE000000000000000000000000000000000001");
      expect(d).to.deep.equal(vectors.withdraw.domain);
      expect(vaultDomain("0x51ce0000000000000000000000000000000000a1")).to.deep.equal(vectors.authorize.domain);
    });

    it("the direct-call fragments are the compiled contracts' functions", () => {
      const abi = (file: string) => (JSON.parse(readFileSync(join(root, "artifacts", "contracts", file), "utf8")) as { abi: unknown[] }).abi;
      const router = new Interface(abi("PaymentRouter.sol/PaymentRouter.json") as never);
      const vault = new Interface(abi("AgentVault.sol/AgentVault.json") as never);
      for (const [fn, compiled] of [["withdraw", router], ["refund", router], ["authorize", vault], ["revoke", vault]] as const) {
        expect(directInterface.getFunction(fn)?.selector, fn).to.equal(compiled.getFunction(fn)?.selector);
      }
      expect(DIRECT_ABI).to.have.length(4);
    });
  });

  it("a wallet's key never appears in what the app asked it to do", async () => {
    const { mock, deps } = await setup();
    const key = mock.wallet.privateKey.slice(2).toLowerCase();
    const { plan } = must(await planDeposit(deps, USDC("1")));
    const session = new FlowSession(plan, deps);
    session.confirm();
    await session.send();
    expect(JSON.stringify(mock.calls).toLowerCase()).to.not.contain(key);
  });
});
