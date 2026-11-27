// The live pages' logic, with a mocked wallet, a mocked reader, a fake tool server and a fake facilitator, so every case runs in
// milliseconds and nothing needs a chain. The chain-backed run of the same code is test/unit/web/live-services.test.ts.
//
// Cases: the settings, every way a flow can fail and what the person is told, the cap on a deposit, the arguments of a call, the price a
// tool server asks (checked against the page's own settings), confirm-then-sign gating, a duplicate or expired or stale payment, a
// refused or unreachable service, following a payment to its receipt, payments kept across a reload, the activity list and its CSV file,
// and the status page's verdicts.
import { Interface, Wallet, getAddress, hexlify, randomBytes, verifyTypedData } from "ethers";
import { expect } from "chai";
import {
  ERRORS, PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY, PAYMENT_TYPES, SCHEME, X402_VERSION, buildPaymentRequired, buildRequirements, errorResult, fromWire, intentDigest, paymentRequiredResult,
  resourceFor, routerDomain, toolIdOf, withSettlement,
} from "@sluice/sdk";
import { FacilitatorUnavailable, ROUTER_ABI, VAULT_ABI } from "@sluice/sdk";
import { DEFAULT_CAPS, HARD_CAPS } from "../../../packages/facilitator/src/caps";
import { MockWallet } from "../../helpers/mock-wallet";
import { rejection } from "../../helpers/assert";
import { DEFAULT_SESSION_CAP_UNITS, MAX_SESSION_CAP_UNITS, liveMissing, readConfig } from "../../../apps/web/src/lib/config";
import { WalletError, classifyWalletError, connectWallet, describeWalletError } from "../../../apps/web/src/lib/eip1193";
import { SluiceCallError, costLine, explain, explainLine } from "../../../apps/web/src/lib/errors";
import type { ErrorKind } from "../../../apps/web/src/lib/errors";
import { NotConfirmedError } from "../../../apps/web/src/lib/flows";
import { CSV_HEADER, csvCell, csvFilename, paginate, readHistory, rowFromLog, toCsv } from "../../../apps/web/src/lib/history";
import type { HistoryRow } from "../../../apps/web/src/lib/history";
import { checkDepositCap, defaultArgs, parseToolArgs, showOutput } from "../../../apps/web/src/lib/live";
import { PaidCallSession, checkRequirements, checkSettlement, parseToolServerHealth, planPaidCall, readReceipt, readToolServer, trackSettlement } from "../../../apps/web/src/lib/paid-call";
import type { PaidCallDeps, ToolServerInfo } from "../../../apps/web/src/lib/paid-call";
import { INFLIGHT_KEY, INFLIGHT_MAX_AGE_SECONDS, addInflight, loadInflight, looksDuplicate, parseInflight, removeInflight } from "../../../apps/web/src/lib/resume";
import type { Inflight } from "../../../apps/web/src/lib/resume";
import { readEndpoints } from "../../../apps/web/src/lib/rpc-endpoints";
import type { ChainReader } from "../../../apps/web/src/lib/reads";
import { RateLimiter } from "../../../apps/web/src/lib/rate-limit";
import { cachedStatusReader, judge, makeStatusHandler, probeTargets, readFacilitatorHealth, readServiceStatus } from "../../../apps/web/src/lib/service-status";
import type { ServiceStatus } from "../../../apps/web/src/lib/service-status";
import { cachedLiquidity, readQusdcLiquidity } from "../../../apps/web/src/lib/liquidity";
import { QIE_RPC_ORIGINS, buildCsp } from "../../../apps/web/src/lib/csp";
import { FACILITATOR_LIMITS, OWNER_POWERS, liveLimits } from "../../../apps/web/src/content/copy";

// ------------------------------------------------------------------------------------------------------- fixtures

const ROUTER = getAddress(`0x${"12".repeat(20)}`);
const VAULT = getAddress(`0x${"34".repeat(20)}`);
const TOKEN = getAddress(`0x${"56".repeat(20)}`);
const BUILDER = getAddress(`0x${"78".repeat(20)}`);
const FACILITATOR = "https://facilitator.test";
const TOOLS = "https://tools.test";
const NOW = 1_800_000_000;
const NONCE = `0x${"ab".repeat(32)}`;
const CHAIN = 1990;
const USDC = (n: string): bigint => BigInt(Math.round(Number(n) * 1_000_000));

const routerIface = new Interface(ROUTER_ABI as unknown as string[]);
const vaultIface = new Interface(VAULT_ABI as unknown as string[]);

type Reply = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const readerWith = (prepaid: bigint, extra: { receipts?: Record<string, unknown> } = {}): ChainReader =>
  ({
    provider: {
      getTransactionReceipt: async (hash: string) => (extra.receipts ?? {})[hash] ?? null,
      getBlock: async () => ({ timestamp: NOW }),
    },
    router: { getFunction: (name: string) => async () => (name === "payerBalance" ? prepaid : 0n) },
    vault: {},
    token: {},
    routerAddress: ROUTER,
    vaultAddress: VAULT,
    tokenAddress: TOKEN,
  }) as unknown as ChainReader;

const TOOL_HEALTH = { ok: true, service: "sluice-paid-tools", network: "mainnet", chainId: CHAIN, router: ROUTER, payee: BUILDER, tools: [{ name: "token_risk_check", price: "0.01" }, { name: "contract_lookup", price: "0.005" }] };
const info = (): ToolServerInfo => parseToolServerHealth(TOOL_HEALTH) as ToolServerInfo;

type ServerOptions = {
  price?: string;
  /** The price the server asks again after a payment arrives (a quote that went stale). */
  laterPrice?: string;
  down?: boolean;
  /** A Sluice error code the server answers a payment with. */
  refuse?: string;
  /** Settle with success: false and this reason. */
  noSettle?: string;
  rpcError?: boolean;
  junk?: boolean;
  tooLarge?: boolean;
  requirements?: Partial<ReturnType<typeof buildRequirements>>;
  /** How many times a payment is answered "not yet settled" before it is answered. */
  pending?: number;
  pendingCode?: string;
  /** Nothing comes back for a request that carries a payment. */
  silentPay?: boolean;
};

/** A tool server that answers like the real one, in memory: a price for a call with no payment, and a result for one that carries a valid signature. */
function fakeToolServer(options: ServerOptions = {}) {
  const seen: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  let waiting = options.pending ?? 0;
  const requirements = (tool: string, price: string) => ({
    ...buildRequirements({ toolName: tool, amount: USDC(price), payTo: BUILDER, router: ROUTER, vault: VAULT, chainId: CHAIN, asset: TOKEN }),
    ...options.requirements,
  });
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Reply> => {
    if (options.down) throw new TypeError("fetch failed");
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    seen.push({ method: init.method, url, body });
    if (options.junk) return reply(200, "<html>not json</html>");
    if (options.tooLarge) return reply(200, "x".repeat(300_000));
    if (url.endsWith("/health")) return reply(200, TOOL_HEALTH);
    const params = (body?.params ?? {}) as { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
    const tool = String(params.name);
    if (options.rpcError) return reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } });
    const payment = params._meta?.[PAYMENT_META_KEY] as { payload: { signature: string; authorization: Record<string, string> } } | undefined;
    if (!payment) {
      const result = paymentRequiredResult(buildPaymentRequired(resourceFor(tool), [requirements(tool, options.price ?? "0.01")]));
      return reply(200, { jsonrpc: "2.0", id: 1, result }, { "x-request-id": "req-price-0001" });
    }
    if (options.silentPay) throw new TypeError("fetch failed");
    if (waiting > 0) {
      waiting -= 1;
      return reply(200, { jsonrpc: "2.0", id: 2, result: errorResult(options.pendingCode ?? ERRORS.paymentPending, "not yet") }, { "x-request-id": "req-pay-0001" });
    }
    if (options.refuse) {
      const required = buildPaymentRequired(resourceFor(tool), [requirements(tool, options.laterPrice ?? options.price ?? "0.01")], options.refuse);
      return reply(200, { jsonrpc: "2.0", id: 2, result: paymentRequiredResult(required) }, { "x-request-id": "req-pay-0001" });
    }
    const intent = fromWire(payment.payload.authorization);
    if (!intent) return reply(200, { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad payment" } });
    // What a real server's facilitator does: the signature must be the payer's, over exactly this intent.
    const signer = verifyTypedData(routerDomain(ROUTER, CHAIN), PAYMENT_TYPES, payment.payload.authorization, payment.payload.signature);
    const digest = intentDigest(ROUTER, intent, CHAIN);
    const settle = options.noSettle
      ? { success: false, errorReason: options.noSettle, transaction: "", network: `eip155:${CHAIN}` }
      : { success: true, transaction: "", network: `eip155:${CHAIN}`, payer: signer, amount: intent.amount.toString(), extensions: { sluice: { id: digest, status: "queued", statusUrl: `${FACILITATOR}/status/${digest}` } } };
    const result = withSettlement({ content: [{ type: "text", text: JSON.stringify({ answer: "ok", tool }) }], structuredContent: { answer: "ok", tool } }, settle);
    return reply(200, { jsonrpc: "2.0", id: 2, result }, { "x-request-id": "req-pay-0001" });
  };
  return { fetchImpl, seen };
}

async function setup(options: { server?: ServerOptions; prepaid?: bigint; wallet?: ConstructorParameters<typeof MockWallet>[1]; now?: () => number; receipts?: Record<string, unknown>; cap?: number } = {}) {
  const mock = new MockWallet(null as never, { chainId: CHAIN, ...options.wallet });
  const server = fakeToolServer(options.server);
  const deps: PaidCallDeps = {
    wallet: mock,
    account: mock.address,
    chainId: CHAIN,
    reader: readerWith(options.prepaid ?? USDC("1"), { receipts: options.receipts }),
    facilitatorUrl: FACILITATOR,
    now: options.now ?? (() => NOW),
    random: () => NONCE,
    toolsUrl: TOOLS,
    sessionCapUnits: options.cap ?? 1_000_000,
    network: { id: "mainnet", label: "QIE mainnet", chainId: CHAIN, rpcUrl: "https://rpc1mainnet.qie.digital/", explorerUrl: "https://mainnet.qie.digital", realFunds: true, note: "" },
    fetchImpl: server.fetchImpl,
  };
  return { mock, server, deps };
}

const planned = async (deps: PaidCallDeps, tool = "token_risk_check", args: Record<string, unknown> = { address: TOKEN }) => {
  const result = await planPaidCall(deps, info(), tool, args);
  if (!result.ok) throw new Error(`the plan was refused: ${result.reason}`);
  return result.plan;
};

// ------------------------------------------------------------------------------------------------------- settings

describe("Live pages: settings", () => {
  it("reads the tool server's address and the session cap, with a default of 1 QUSDC and a ceiling of 10", () => {
    const base = readConfig({});
    expect(base.toolsUrl).to.equal(null);
    expect(base.sessionCapUnits).to.equal(DEFAULT_SESSION_CAP_UNITS);
    expect(DEFAULT_SESSION_CAP_UNITS).to.equal(1_000_000);
    expect(readConfig({ NEXT_PUBLIC_TOOLS_URL: "https://tools.example/" }).toolsUrl).to.equal("https://tools.example");
    expect(readConfig({ NEXT_PUBLIC_SESSION_CAP_QUSDC: "2.5" }).sessionCapUnits).to.equal(2_500_000);
    expect(readConfig({ NEXT_PUBLIC_SESSION_CAP_QUSDC: "10" }).sessionCapUnits).to.equal(MAX_SESSION_CAP_UNITS);
    expect(readConfig({ NEXT_PUBLIC_SESSION_CAP_QUSDC: "0.000001" }).sessionCapUnits).to.equal(1);
  });

  it("ignores a cap above 10, a cap of zero and a cap that is not a number, and says so", () => {
    for (const bad of ["10.000001", "11", "0", "0.0", "-1", "lots", "1e3", "1,5", "1.1234567"]) {
      const c = readConfig({ NEXT_PUBLIC_SESSION_CAP_QUSDC: bad });
      expect(c.sessionCapUnits, bad).to.equal(DEFAULT_SESSION_CAP_UNITS);
      expect(c.problems.join(" "), bad).to.match(/NEXT_PUBLIC_SESSION_CAP_QUSDC/);
    }
    expect(readConfig({ NEXT_PUBLIC_TOOLS_URL: "http://tools.example" }).toolsUrl).to.equal(null); // plain http away from this machine
    expect(readConfig({ NEXT_PUBLIC_TOOLS_URL: "http://127.0.0.1:8403" }).toolsUrl).to.equal("http://127.0.0.1:8403");
  });

  it("says what the live pages still need, in words, and nothing when they have it all", () => {
    expect(liveMissing(readConfig({}))).to.have.length(3);
    const have = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: ROUTER, NEXT_PUBLIC_VAULT_ADDRESS: VAULT, NEXT_PUBLIC_FACILITATOR_URL: FACILITATOR, NEXT_PUBLIC_TOOLS_URL: TOOLS });
    expect(liveMissing(have)).to.deep.equal([]);
    expect(liveMissing({ ...have, toolsUrl: null }).join(" ")).to.contain("NEXT_PUBLIC_TOOLS_URL");
    expect(liveMissing({ ...have, facilitatorUrl: null }).join(" ")).to.contain("NEXT_PUBLIC_FACILITATOR_URL");
    expect(liveMissing({ ...have, vault: null }).join(" ")).to.contain("NEXT_PUBLIC_VAULT_ADDRESS");
  });

  it("reads through QIE's endpoints in order with the others behind, and through a named or local endpoint alone", () => {
    const own = readEndpoints({ chainId: 1990, rpcUrl: "https://rpc1mainnet.qie.digital/" });
    expect(own).to.have.length(5);
    expect(own[0]).to.equal("https://rpc1mainnet.qie.digital/");
    expect(readEndpoints({ chainId: 1990, rpcUrl: "https://rpc3mainnet.qie.digital/" })[0]).to.equal("https://rpc3mainnet.qie.digital/");
    expect(readEndpoints({ chainId: 1990, rpcUrl: "https://node.example/" })).to.deep.equal(["https://node.example/"]);
    expect(readEndpoints({ chainId: 1990, rpcUrl: "http://127.0.0.1:8545" })).to.deep.equal(["http://127.0.0.1:8545"]);
    expect(readEndpoints({ chainId: 1983, rpcUrl: "https://rpc1testnet.qie.digital/" })[1]).to.equal("https://rpc2testnet.qie.digital/");
    expect(readEndpoints({ chainId: 7, rpcUrl: "https://rpc1mainnet.qie.digital/" })).to.deep.equal(["https://rpc1mainnet.qie.digital/"]);
  });

  it("lets a page reach every QIE endpoint it may fall back to, and the tool server it pays, and no other address", () => {
    expect(QIE_RPC_ORIGINS).to.have.length(10);
    const csp = buildCsp({ nonce: "A".repeat(24), path: "/builder", extraConnect: ["https://tools.example"] });
    const connect = /connect-src ([^;]*)/.exec(csp)?.[1] ?? "";
    for (const o of QIE_RPC_ORIGINS) expect(connect, o).to.contain(o);
    expect(connect).to.contain("https://tools.example");
    expect(connect).to.not.match(/\bhttps:(?!\/\/)/); // no blanket https: on a page that does not take an address from a person
    expect(csp).to.not.contain("unsafe-inline").and.to.not.contain("unsafe-eval");
  });
});

// ---------------------------------------------------------------------------------------------- what went wrong

describe("Live pages: what a failure says", () => {
  const rpcError = (code: number | string, message: string) => Object.assign(new Error(message), { code });

  const cases: Array<[string, unknown, ErrorKind]> = [
    ["a rejected signature", rpcError(4001, "User rejected the request."), "rejected"],
    ["a locked wallet (its own wording)", rpcError(-32603, "Wallet is locked. Please unlock it."), "locked"],
    ["a request already waiting in the wallet", rpcError(-32002, "Request of type 'wallet_requestPermissions' already pending"), "wallet_busy"],
    ["a wallet on another network", new WalletError("wrong_network", "x"), "wrong_network"],
    ["a network the wallet does not know", rpcError(4902, "Unrecognized chain ID"), "wrong_network"],
    ["a wallet without the method", rpcError(-32601, "The method eth_signTransaction does not exist"), "unsupported_wallet"],
    ["too little QIE for the fee", rpcError(-32000, "insufficient funds for gas * price + value"), "insufficient_gas"],
    ["a nonce that is too low", rpcError(-32000, "nonce too low: next nonce 7, tx nonce 6"), "nonce"],
    ["a nonce already used (ethers)", rpcError("NONCE_EXPIRED", "nonce has already been used"), "nonce"],
    ["a transaction that is already waiting", rpcError(-32000, "replacement transaction underpriced"), "underpriced"],
    ["a fee below the network's", rpcError(-32000, "max fee per gas less than block base fee"), "underpriced"],
    ["a call that would revert", rpcError(3, "execution reverted"), "reverted"],
    ["a node that does not answer", rpcError("TIMEOUT", "the node did not answer in time"), "rpc_down"],
    ["a node that cannot be reached", new TypeError("fetch failed"), "rpc_down"],
    ["a transaction that failed on the network", new WalletError("failed", "the transaction was sent and failed on the network"), "reverted"],
    ["a transaction that is not confirmed yet", new WalletError("failed", "the transaction was sent but is not confirmed yet; check the explorer"), "unknown"],
    ["a facilitator that refused", new WalletError("failed", "the facilitator refused the deposit: no reason given"), "refused"],
    ["a wallet that signed something else", new WalletError("failed", "the wallet signed something different from what was shown, so nothing was sent"), "refused"],
    ["an allowance that is too small", new Error("ERC20: insufficient allowance"), "insufficient_allowance"],
    ["a balance that is too small", new Error("transfer amount exceeds balance"), "insufficient_qusdc"],
    ["an unreachable facilitator", new FacilitatorUnavailable("the facilitator could not be reached"), "facilitator_down"],
    ["something nobody expected", new Error("boom"), "unknown"],
    ["a thrown string", "boom", "unknown"],
  ];
  for (const [name, err, kind] of cases) {
    it(`${name}: says what happened, what to do, and whether money moved`, () => {
      const e = explain(err);
      expect(e.kind).to.equal(kind);
      expect(e.headline.length, "a headline").to.be.greaterThan(10);
      expect(e.advice.length, "advice").to.be.greaterThan(10);
      expect(e.funds.length, "a word about the money").to.be.greaterThan(10);
      expect(`${e.headline} ${e.advice} ${e.funds}`, "never the raw message").to.not.match(/0x[0-9a-fA-F]{8}|https?:\/\/|rpc[1-5]|-32\d{3}|ethers|stack/);
    });
  }

  const sluice: Array<[string, ErrorKind, string]> = [
    [ERRORS.insufficientFunds, "insufficient_prepaid", "change"],
    [ERRORS.sessionNotFound, "session_missing", "change"],
    [ERRORS.sessionExpired, "session_expired", "change"],
    [ERRORS.perCallCap, "session_limit", "change"],
    [ERRORS.budgetExceeded, "session_limit", "change"],
    [ERRORS.toolNotAllowed, "tool_not_allowed", "change"],
    [ERRORS.killSwitch, "kill_switch", "later"],
    [ERRORS.facilitatorUnavailable, "facilitator_down", "later"],
    [ERRORS.storeUnavailable, "facilitator_down", "later"],
    [ERRORS.capGlobalDaily, "daily_limit", "later"],
    [ERRORS.capBudget, "daily_limit", "later"],
    [ERRORS.rateLimited, "rate_limited", "later"],
    [ERRORS.amountTooLow, "stale_quote", "change"],
    [ERRORS.acceptedMismatch, "stale_quote", "change"],
    [ERRORS.expired, "payment_expired", "now"],
    [ERRORS.deadlineTooFar, "payment_expired", "now"],
    [ERRORS.nonceUsed, "duplicate", "no"],
    [ERRORS.intentReplayed, "duplicate", "no"],
    [ERRORS.invalidNetwork, "refused", "no"],
  ];
  for (const [code, kind, retry] of sluice) {
    it(`the Sluice code ${code}: ${kind}, and retrying is "${retry}"`, () => {
      const e = explain(new SluiceCallError(code, "the tool server did not accept the payment", "tool_server"));
      expect(e.kind).to.equal(kind);
      expect(e.retry).to.equal(retry);
      expect(e.funds).to.match(/not charged|unchanged|settled once|no money|Nothing was sent/i);
    });
  }

  it("tells a tool server that is down from a facilitator that is down, and neither from a refusal", () => {
    expect(explain(new SluiceCallError("unreachable", "x", "tool_server")).kind).to.equal("tool_down");
    expect(explain(new SluiceCallError("unreachable", "x", "facilitator")).kind).to.equal("facilitator_down");
    expect(explain(new SluiceCallError("some_other_code", "x", "wallet")).kind).to.equal("refused");
    expect(explain(new SluiceCallError("unreachable", "x", "tool_server")).advice).to.contain("Status page");
  });

  it("describes a kill switch as a pause with reading still working, and offers the way out: a refund from a wallet with QIE", () => {
    const e = explain(new SluiceCallError(ERRORS.killSwitch, "x", "tool_server"));
    expect(e.headline).to.match(/paused/);
    expect(e.advice).to.match(/refund/);
    expect(e.advice).to.match(/Reading still works/);
  });

  it("says one line for a place with room for one, and prices a transaction from the live gas price", () => {
    expect(explainLine(new Error("boom"))).to.match(/^Something went wrong.*Check your wallet/);
    expect(costLine(160_000n, 1_125_000_000n, true)).to.equal("Up to 0.00018 QIE in network fees (160000 gas at 1.125 gwei, read just now).");
    expect(costLine(21_000n, 1n, false)).to.match(/^About less than 0\.000001 QIE/);
  });

  it("classifies a wallet's wording wherever it put it, and describes each case in plain words", () => {
    expect(classifyWalletError({ info: { error: { message: "nonce too low" } } })).to.equal("nonce");
    expect(classifyWalletError({ data: { message: "insufficient funds" } })).to.equal("insufficient_gas");
    expect(classifyWalletError({ shortMessage: "replacement transaction underpriced" })).to.equal("underpriced");
    expect(classifyWalletError({ code: "CALL_EXCEPTION" })).to.equal("reverted");
    expect(classifyWalletError({ code: "SERVER_ERROR" })).to.equal("node_down");
    expect(classifyWalletError({})).to.equal("failed");
    for (const code of ["locked", "nonce", "underpriced", "insufficient_gas", "reverted", "node_down"] as const) {
      expect(describeWalletError(new WalletError(code, "x")), code).to.not.contain("could not complete");
    }
  });

  it("names a locked wallet when it answers a connect with no account", async () => {
    const locked = { request: async () => [] } as never;
    const error = await rejection(connectWallet(locked));
    expect(error).to.be.instanceOf(WalletError);
    expect(classifyWalletError(error)).to.equal("locked");
    expect(explain(error).kind).to.equal("locked");
  });
});

// ------------------------------------------------------------------------------------------- deposit and arguments

describe("Live pages: the deposit cap and a call's arguments", () => {
  it("holds a deposit to the cap, and the prepaid balance after it to the cap too", () => {
    const cap = 1_000_000;
    expect(checkDepositCap(100_000n, 0n, cap)).to.equal(undefined);
    expect(checkDepositCap(1_000_000n, 0n, cap)).to.equal(undefined); // exactly the cap
    expect(checkDepositCap(1_000_001n, 0n, cap)).to.match(/at most 1\.000000 QUSDC/);
    expect(checkDepositCap(100_000n, 900_000n, cap)).to.equal(undefined); // exactly the cap after it
    expect(checkDepositCap(100_001n, 900_000n, cap)).to.match(/you can add up to 0\.100000 more/);
    expect(checkDepositCap(1n, 1_000_000n, cap)).to.match(/Use it, or take some back/);
    expect(checkDepositCap(1n, 5_000_000n, cap)).to.match(/and yours is 5\.000000/); // a balance already above the cap leaves no room
  });

  it("starts a tool's arguments from something that works, and takes only one flat object of short values", () => {
    expect(JSON.parse(defaultArgs("token_risk_check", TOKEN))).to.deep.equal({ address: TOKEN });
    expect(JSON.parse(defaultArgs("contract_lookup", TOKEN))).to.deep.equal({ address: TOKEN });
    expect(JSON.parse(defaultArgs("dex_quote", TOKEN))).to.deep.equal({ tokenIn: "QIE", tokenOut: TOKEN, amountIn: "1" });
    expect(parseToolArgs("")).to.deep.equal({ ok: true, args: {} });
    expect(parseToolArgs('{"address":"0x1","n":2,"flag":true}')).to.deep.equal({ ok: true, args: { address: "0x1", n: 2, flag: true } });
    for (const bad of ["not json", "[1,2]", "null", '"text"', '{"a":{"b":1}}', '{"a":[1]}', '{"a":null}', '{"1bad":1}', `{"a":"${"x".repeat(201)}"}`, `{"${"k".repeat(45)}":1}`, JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]))), `{"a":"${"x".repeat(2_000)}"}`]) {
      expect(parseToolArgs(bad).ok, bad.slice(0, 30)).to.equal(false);
    }
  });

  it("shows a tool's answer as text, cut at a length, never as markup", () => {
    expect(showOutput({ a: 1 })).to.equal('{\n  "a": 1\n}');
    expect(showOutput("<b>x</b>")).to.equal("<b>x</b>");
    expect(showOutput({ n: 5n })).to.contain('"5"');
    const long = showOutput("y".repeat(5_000), 100);
    expect(long.startsWith("y".repeat(100))).to.equal(true);
    expect(long).to.contain("4900 more characters not shown");
  });
});

// ---------------------------------------------------------------------------------------------- the tool server

describe("Live pages: reading a tool server", () => {
  const expected = { chainId: CHAIN, router: ROUTER };

  it("reads a tool server's health strictly: each field checked, anything else dropped", () => {
    expect(parseToolServerHealth(TOOL_HEALTH)).to.deep.equal({ chainId: CHAIN, router: ROUTER, payee: BUILDER, tools: TOOL_HEALTH.tools });
    expect(parseToolServerHealth({ ...TOOL_HEALTH, extra: "x" })).to.not.have.property("extra");
    for (const bad of [null, "x", {}, { ...TOOL_HEALTH, ok: false }, { ...TOOL_HEALTH, chainId: "1990" }, { ...TOOL_HEALTH, router: "0x1" }, { ...TOOL_HEALTH, payee: "nope" }, { ...TOOL_HEALTH, tools: "none" }]) {
      expect(parseToolServerHealth(bad), JSON.stringify(bad)?.slice(0, 40)).to.equal(undefined);
    }
    const tools = parseToolServerHealth({ ...TOOL_HEALTH, tools: [{ name: "ok_tool", price: "0.5" }, { name: "Bad Name", price: "1" }, { name: "x", price: "1e3" }, { name: "free", price: "-1" }] });
    expect(tools?.tools).to.deep.equal([{ name: "ok_tool", price: "0.5" }]);
  });

  it("accepts the tool server this page is set up for", async () => {
    const s = fakeToolServer();
    const read = await readToolServer(TOOLS, expected, s.fetchImpl);
    expect(read.ok).to.equal(true);
  });

  it("refuses a tool server on another chain or another router, so nothing is paid to the wrong place", async () => {
    const chain = await readToolServer(TOOLS, { chainId: 1983, router: ROUTER }, fakeToolServer().fetchImpl);
    expect(chain).to.deep.include({ ok: false, down: false });
    expect(chain.ok === false && chain.reason).to.match(/chain 1990.*chain 1983/);
    const router = await readToolServer(TOOLS, { chainId: CHAIN, router: getAddress(`0x${"99".repeat(20)}`) }, fakeToolServer().fetchImpl);
    expect(router).to.deep.include({ ok: false, down: false });
    expect(router.ok === false && router.reason).to.match(/different router/);
  });

  it("says a tool server is down when it cannot be reached or answers with something that is not JSON, and when it is too large or the wrong kind of server", async () => {
    const down = await readToolServer(TOOLS, expected, fakeToolServer({ down: true }).fetchImpl);
    expect(down).to.deep.include({ ok: false, down: true });
    const junk = await readToolServer(TOOLS, expected, fakeToolServer({ junk: true }).fetchImpl);
    expect(junk).to.deep.include({ ok: false, down: true });
    const huge = await readToolServer(TOOLS, expected, fakeToolServer({ tooLarge: true }).fetchImpl);
    expect(huge.ok).to.equal(false);
    const other = await readToolServer(TOOLS, expected, (async () => reply(200, { ok: true, hello: "world" })) as never);
    expect(other).to.deep.include({ ok: false, down: false });
  });
});

describe("Live pages: the price a tool server asks is checked before it is shown", () => {
  const deps = { chainId: CHAIN, reader: readerWith(USDC("1")), sessionCapUnits: 1_000_000 };
  const good = () => buildRequirements({ toolName: "token_risk_check", amount: USDC("0.01"), payTo: BUILDER, router: ROUTER, vault: VAULT, chainId: CHAIN, asset: TOKEN });
  const check = (over: Record<string, unknown>, extra: Record<string, unknown> = {}) => checkRequirements(deps, { payee: BUILDER }, "token_risk_check", { ...good(), ...over, extra: { ...good().extra, ...extra } } as never);

  it("passes a price for this chain, this token, this router, this tool and the payee the server declared", () => {
    expect(check({})).to.equal(undefined);
  });

  it("refuses a price for another network", () => expect(check({ network: "eip155:1983" })?.code).to.equal("invalid_network"));
  it("refuses a price in another token than the router holds", () => expect(check({ asset: getAddress(`0x${"aa".repeat(20)}`) })?.code).to.equal("invalid_sluice_asset"));
  it("refuses a price that names another router", () => expect(check({}, { router: getAddress(`0x${"bb".repeat(20)}`) })?.code).to.equal("invalid_sluice_router"));
  it("refuses a price for another tool", () => expect(check({}, { toolId: toolIdOf("something_else") })?.code).to.equal("sluice_tool_mismatch"));
  it("refuses a price that pays someone other than the payee the server declared", () => expect(check({ payTo: getAddress(`0x${"cc".repeat(20)}`) })?.code).to.equal("sluice_payee_mismatch"));
  it("refuses a price that is not a positive whole number of units, and one with too little time to pay", () => {
    for (const amount of ["0", "-1", "1.5", "abc", "1".repeat(19)]) expect(check({ amount })?.code, amount).to.equal("invalid_payment_requirements");
    expect(check({ maxTimeoutSeconds: 19 })?.code).to.equal("invalid_payment_requirements");
    expect(check({ maxTimeoutSeconds: 20 })).to.equal(undefined);
  });

  it("refuses a price above the cap, and accepts one exactly at it", () => {
    expect(check({ amount: "1000001" })?.code).to.equal("over_cap");
    expect(check({ amount: "1000000" })).to.equal(undefined);
  });
});

// ---------------------------------------------------------------------------------------------- confirm, then sign

describe("Live pages: a paid call", () => {
  it("plans a call from the server's own price, and says in words everything the wallet will sign", async () => {
    const { deps } = await setup();
    const plan = await planned(deps);
    const text = plan.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
    expect(text).to.contain("Price: 0.010000 QUSDC");
    expect(text).to.contain(`Paid to: ${BUILDER}`);
    expect(text).to.contain(`Router: ${ROUTER}`);
    expect(text).to.contain(`Token: ${TOKEN}`);
    expect(text).to.contain(`Tool id: ${toolIdOf("token_risk_check")}`);
    expect(text).to.contain("Prepaid balance: 1.000000 QUSDC now, 0.990000 QUSDC after");
    expect(text).to.contain("Valid until:");
    expect(text).to.contain("(real funds)");
    expect(plan.warnings.join(" ")).to.contain("real QUSDC");
    expect(plan.intent).to.deep.include({ payer: getAddress(deps.account), payee: BUILDER, amount: USDC("0.01"), nonce: NONCE });
    expect(plan.intent.deadline).to.equal(BigInt(NOW + 300));
    expect(plan.prepaid).to.deep.equal({ before: USDC("1"), after: USDC("0.99") });
  });

  it("names the network the site is set to: a local copy of mainnet has mainnet's chain id and is never called real funds", async () => {
    const { deps } = await setup();
    const local = { ...deps, network: { id: "local" as const, label: "Local node or fork", chainId: CHAIN, rpcUrl: "http://127.0.0.1:8545", explorerUrl: undefined, realFunds: false, note: "" } };
    const plan = await planned(local);
    const text = plan.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
    expect(text).to.contain("Network: Local node or fork, chain 1990 (no real funds)");
    expect(text).to.not.contain("(real funds)");
    expect(plan.warnings.join(" ")).to.not.contain("real QUSDC");
  });

  it("asks the server for the price once, with no payment, and does not ask the wallet for anything", async () => {
    const { deps, server, mock } = await setup();
    await planned(deps);
    const calls = server.seen.filter((c) => c.method === "POST");
    expect(calls).to.have.length(1);
    expect(JSON.stringify(calls[0]?.body)).to.not.contain(PAYMENT_META_KEY);
    expect(mock.calls.filter((c) => c.method.startsWith("eth_sign"))).to.have.length(0);
  });

  it("refuses to plan with too little prepaid balance, saying how much is there, and accepts a balance exactly equal to the price", async () => {
    const short = await setup({ prepaid: USDC("0.005") });
    const refused = await planPaidCall(short.deps, info(), "token_risk_check", {});
    expect(refused).to.deep.include({ ok: false, kind: "insufficient_prepaid" });
    expect(refused.ok === false && refused.reason).to.match(/0\.005000 QUSDC.*less than this call's 0\.010000/);
    const exact = await setup({ prepaid: USDC("0.01") });
    expect((await planPaidCall(exact.deps, info(), "token_risk_check", {})).ok).to.equal(true);
  });

  it("refuses a tool the server does not offer, a server that is down, and a price above the cap, each without signing", async () => {
    const a = await setup();
    expect(await planPaidCall(a.deps, info(), "nope", {})).to.deep.include({ ok: false, kind: "refused" });
    const down = await setup({ server: { down: true } });
    const gone = await planPaidCall(down.deps, info(), "token_risk_check", {});
    expect(gone).to.deep.include({ ok: false, kind: "tool_down" });
    expect(gone.ok === false && gone.reason).to.contain("Nothing was signed");
    const dear = await setup({ server: { price: "2" } });
    const capped = await planPaidCall(dear.deps, info(), "token_risk_check", {});
    expect(capped.ok === false && capped.reason).to.match(/above the 1\.000000 QUSDC this page allows for one call/);
    const rpc = await setup({ server: { rpcError: true } });
    expect((await planPaidCall(rpc.deps, info(), "token_risk_check", {})).ok).to.equal(false);
    const free = await setup({ server: { requirements: { scheme: "other" } } });
    expect(await planPaidCall(free.deps, info(), "token_risk_check", {})).to.deep.include({ ok: false });
  });

  it("will not ask the wallet to sign until the plan is confirmed, and a second confirm is refused", async () => {
    const { deps, mock } = await setup();
    const session = new PaidCallSession(await planned(deps), deps);
    expect(session.state).to.equal("planned");
    const early = await rejection(session.send());
    expect(early).to.be.instanceOf(NotConfirmedError);
    expect(mock.calls.filter((c) => c.method === "eth_signTypedData_v4"), "the wallet was never asked").to.have.length(0);
    session.confirm();
    expect(session.state).to.equal("confirmed");
    expect(() => session.confirm()).to.throw(/cannot confirm a payment that is confirmed/);
  });

  it("will not send a cancelled plan, whether it was cancelled before or after the confirm", async () => {
    for (const confirmFirst of [false, true]) {
      const { deps, mock } = await setup();
      const session = new PaidCallSession(await planned(deps), deps);
      if (confirmFirst) session.confirm();
      session.cancel();
      expect(session.state).to.equal("cancelled");
      expect(await rejection(session.send())).to.be.instanceOf(NotConfirmedError);
      expect(mock.count("eth_signTypedData_v4")).to.equal(0);
    }
  });

  it("signs one payment, sends it, and returns the answer, the signed intent and the facilitator's id for it", async () => {
    const { deps, mock, server } = await setup();
    const plan = await planned(deps);
    const session = new PaidCallSession(plan, deps);
    session.confirm();
    const result = await session.send();
    expect(session.state).to.equal("paid");
    expect(mock.count("eth_signTypedData_v4")).to.equal(1);
    expect(result.output).to.deep.equal({ answer: "ok", tool: "token_risk_check" });
    expect(result.intentId).to.equal(intentDigest(ROUTER, plan.intent, CHAIN));
    expect(result.status).to.equal("queued");
    expect(result.requestId).to.equal("req-pay-0001");
    expect(result.signature).to.match(/^0x[0-9a-f]{130}$/);
    // The message the wallet was asked to sign is the plan's: the same payee, amount, tool, nonce and deadline.
    const typed = JSON.parse(String((mock.calls.find((c) => c.method === "eth_signTypedData_v4")?.params as unknown[])[1]));
    expect(typed.primaryType).to.equal("Payment");
    expect(typed.message).to.deep.include({ payer: getAddress(deps.account), payee: BUILDER, amount: "10000", nonce: NONCE, toolId: toolIdOf("token_risk_check") });
    expect(typed.domain).to.deep.include({ name: "SluiceRouter", chainId: CHAIN, verifyingContract: ROUTER });
    // And the server was sent a payment carrying that signature.
    const paid = server.seen.filter((c) => c.method === "POST").pop();
    expect(JSON.stringify(paid?.body)).to.contain(result.signature);
  });

  it("a second press cannot make a second payment: after one send the session will not send again", async () => {
    const { deps, mock } = await setup();
    const session = new PaidCallSession(await planned(deps), deps);
    session.confirm();
    await session.send();
    expect(await rejection(session.send())).to.be.instanceOf(NotConfirmedError);
    expect(mock.count("eth_signTypedData_v4")).to.equal(1);
  });

  it("stops a wallet on another network before it is asked to sign", async () => {
    const { deps, mock } = await setup({ wallet: { chainId: 1983 } });
    const session = new PaidCallSession(await planned(deps), deps);
    session.confirm();
    const error = await rejection(session.send());
    expect(explain(error).kind).to.equal("wrong_network");
    expect(session.state).to.equal("failed");
    expect(mock.count("eth_signTypedData_v4")).to.equal(0);
  });

  it("stops a quote that ran out of time while it was on screen, before the wallet is asked", async () => {
    let clock = NOW;
    const { deps, mock } = await setup({ now: () => clock });
    const session = new PaidCallSession(await planned(deps), deps);
    session.confirm();
    clock = NOW + 300; // the intent's deadline
    const error = await rejection(session.send());
    expect(explain(error).kind).to.equal("payment_expired");
    expect(mock.count("eth_signTypedData_v4")).to.equal(0);
  });

  it("a rejected signature sends nothing to the tool server", async () => {
    const { deps, server } = await setup({ wallet: { rejectSign: true } });
    const session = new PaidCallSession(await planned(deps), deps);
    session.confirm();
    const error = await rejection(session.send());
    expect(explain(error)).to.deep.include({ kind: "rejected", retry: "now" });
    expect(server.seen.filter((c) => c.method === "POST")).to.have.length(1); // the price question, and no payment
  });

  it("a wallet that signs as another account is caught before anything is sent", async () => {
    const { deps, server } = await setup({ wallet: { signAs: new Wallet(hexlify(randomBytes(32))) } });
    const session = new PaidCallSession(await planned(deps), deps);
    session.confirm();
    await rejection(session.send());
    expect(server.seen.filter((c) => c.method === "POST")).to.have.length(1);
  });

  const failing: Array<[string, ServerOptions, ErrorKind]> = [
    ["the kill switch on", { refuse: ERRORS.killSwitch }, "kill_switch"],
    ["the facilitator down", { refuse: ERRORS.facilitatorUnavailable }, "facilitator_down"],
    ["an expired agent session", { refuse: ERRORS.sessionExpired }, "session_expired"],
    ["a revoked agent session", { refuse: ERRORS.sessionNotFound }, "session_missing"],
    ["too little prepaid balance at the facilitator", { refuse: ERRORS.insufficientFunds }, "insufficient_prepaid"],
    ["a payment already used (a duplicate)", { refuse: ERRORS.nonceUsed }, "duplicate"],
    ["a price that changed after the quote (stale)", { refuse: ERRORS.amountTooLow, laterPrice: "0.02" }, "stale_quote"],
    ["a rate limit", { refuse: ERRORS.rateLimited }, "rate_limited"],
    ["a settlement the facilitator refused", { noSettle: ERRORS.insufficientFunds }, "insufficient_prepaid"],
    ["a tool server error", { rpcError: false, refuse: "tool_error" }, "refused"],
  ];
  for (const [name, server, kind] of failing) {
    it(`${name}: the person is told ${kind}, the session fails once, and nothing is left half done`, async () => {
      const { deps } = await setup({ server: { ...server } });
      // The plan is made with an ordinary server; the refusal comes when the payment arrives.
      const okPlan = await setup();
      const plan = await planned(okPlan.deps);
      const session = new PaidCallSession(plan, deps);
      session.confirm();
      const error = await rejection(session.send());
      expect(session.state).to.equal("failed");
      expect(session.error).to.equal(error);
      expect(explain(error).kind).to.equal(kind);
    });
  }

  it("says the tool server is down when the payment cannot be delivered, and does not call it a refusal", async () => {
    const good = await setup();
    const plan = await planned(good.deps);
    const dead = await setup({ server: { down: true } });
    const session = new PaidCallSession(plan, dead.deps);
    session.confirm();
    expect(explain(await rejection(session.send())).kind).to.equal("tool_down");
  });

  /** A payment sent to a server that answers it as `server` says, with the price read from an ordinary one. */
  const sendTo = async (server: ServerOptions) => {
    const plan = await planned((await setup()).deps);
    const other = await setup({ server });
    const session = new PaidCallSession(plan, { ...other.deps, resendDelayMs: 1 });
    session.confirm();
    const sent = () =>
      other.server.seen
        .map((s) => (s.body?.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.[PAYMENT_META_KEY] as { payload: { signature: string } } | undefined)
        .filter((p): p is { payload: { signature: string } } => p !== undefined);
    return { session, sent };
  };

  for (const pendingCode of [ERRORS.paymentPending, "payment_in_progress"]) {
    it(`sends the same signed payment again while the server answers ${pendingCode}, and takes the answer when it comes`, async () => {
      const { session, sent } = await sendTo({ pending: 3, pendingCode });
      await session.send();
      expect(session.state).to.equal("paid");
      expect(sent()).to.have.length(4);
      expect(new Set(sent().map((p) => p.payload.signature)).size, "one signature, never a second").to.equal(1);
    });
  }

  it("stops after three resends and says the payment may still settle, not that nothing was charged", async () => {
    const { session, sent } = await sendTo({ pending: 100 });
    const told = explain(await rejection(session.send()));
    expect(sent()).to.have.length(4);
    expect(told.retry).to.equal("no");
    expect(told.funds).to.contain("may still settle");
    expect(told.advice).to.contain("Do not sign a new payment");
  });

  it("says nothing was charged only when the server says the payment was not taken", async () => {
    const { session, sent } = await sendTo({ refuse: ERRORS.paymentNotTaken });
    const told = explain(await rejection(session.send()));
    expect(sent()).to.have.length(1);
    expect(told.funds).to.contain("not charged");
  });

  it("does not claim that nothing was charged when no answer comes back for a signed payment", async () => {
    const { session } = await sendTo({ silentPay: true });
    const told = explain(await rejection(session.send()));
    expect(told.kind).to.equal("tool_down");
    expect(told.funds).to.contain("may have reached it");
  });

  it("builds the details panel from the intent that was signed", async () => {
    const { deps } = await setup();
    const plan = await planned(deps);
    const text = (await import("../../../apps/web/src/lib/paid-call")).describeIntent(plan.intent).map((f) => `${f.label}=${f.value}`).join("|");
    expect(text).to.contain(`Payer=${getAddress(deps.account)}`);
    expect(text).to.contain("Amount=0.010000 QUSDC");
    expect(text).to.contain(`Nonce=${NONCE}`);
  });
});

// -------------------------------------------------------------------------------------------------- settlement

describe("Live pages: following a payment to its receipt", () => {
  const TX = `0x${"c1".repeat(32)}`;
  const nonce = NONCE;
  const payer = getAddress(`0x${"21".repeat(20)}`);

  const settledLog = (over: { nonce?: string; payer?: string; address?: string } = {}) => {
    const enc = routerIface.encodeEventLog(routerIface.getEvent("Settled") as never, [over.payer ?? payer, BUILDER, toolIdOf("token_risk_check"), 10_000n, 100n, over.nonce ?? nonce, payer]);
    return { address: over.address ?? ROUTER, topics: enc.topics, data: enc.data };
  };
  const receipt = (logs: unknown[], status = 1) => ({ status, blockNumber: 77, logs });
  const facilitator = (status: object | { error: string }) => async (_url: string) => ({ status: 200, text: async () => JSON.stringify(status) });
  const depsWith = (receipts: Record<string, unknown>) => ({ reader: readerWith(0n, { receipts }), network: { id: "mainnet" as const, label: "QIE mainnet", chainId: CHAIN, rpcUrl: "", explorerUrl: "https://mainnet.qie.digital", realFunds: true, note: "" }, facilitatorUrl: FACILITATOR as string | null });

  it("builds a receipt from the router's own Settled event, with an explorer link and the block's time", async () => {
    const r = await readReceipt(depsWith({ [TX]: receipt([settledLog()]) }), TX, nonce, payer);
    expect(r).to.deep.include({ transaction: TX, blockNumber: 77, timestamp: NOW, payer, payee: BUILDER, amount: 10_000n, fee: 100n, nonce, explorerUrl: `https://mainnet.qie.digital/tx/${TX}` });
  });

  it("does not take another payment's event, another payer's, another contract's or a failed transaction's for this one", async () => {
    expect(await readReceipt(depsWith({ [TX]: receipt([settledLog({ nonce: `0x${"01".repeat(32)}` })]) }), TX, nonce, payer)).to.equal(undefined);
    expect(await readReceipt(depsWith({ [TX]: receipt([settledLog({ payer: getAddress(`0x${"22".repeat(20)}`) })]) }), TX, nonce, payer)).to.equal(undefined);
    expect(await readReceipt(depsWith({ [TX]: receipt([settledLog({ address: VAULT })]) }), TX, nonce, payer)).to.equal(undefined);
    expect(await readReceipt(depsWith({ [TX]: receipt([settledLog()], 0) }), TX, nonce, payer)).to.equal(undefined);
    expect(await readReceipt(depsWith({}), TX, nonce, payer)).to.equal(undefined);
    expect(await readReceipt(depsWith({ [TX]: receipt([{ address: ROUTER, topics: [`0x${"00".repeat(32)}`], data: "0x" }, settledLog()]) }), TX, nonce, payer)).to.include({ blockNumber: 77 }); // a log it cannot read is skipped
  });

  it("says settled only when the chain shows it: the facilitator's word alone leaves it pending", async () => {
    const view = await checkSettlement(depsWith({ [TX]: receipt([settledLog()]) }), "0x" + "d1".repeat(32), nonce, payer, facilitator({ status: "settled", transaction: TX, blockNumber: 77 }) as never);
    expect(view.state).to.equal("settled");
    const unseen = await checkSettlement(depsWith({}), "0x" + "d1".repeat(32), nonce, payer, facilitator({ status: "settled", transaction: TX }) as never);
    expect(unseen).to.deep.include({ state: "pending" });
  });

  it("reports queued and submitted as pending, skipped, expired and failed as not settled, and a facilitator that is not there as not known", async () => {
    const idv = "0x" + "d1".repeat(32);
    for (const status of ["queued", "submitted"]) expect(await checkSettlement(depsWith({}), idv, nonce, payer, facilitator({ status }) as never), status).to.deep.equal({ state: "pending", status });
    for (const status of ["skipped", "expired", "failed"]) expect((await checkSettlement(depsWith({}), idv, nonce, payer, facilitator({ status, reason: "no" }) as never)).state, status).to.equal("not_settled");
    expect((await checkSettlement({ ...depsWith({}), facilitatorUrl: null }, idv, nonce, payer)).state).to.equal("unknown");
    expect((await checkSettlement(depsWith({}), idv, nonce, payer, (async () => { throw new TypeError("fetch failed"); }) as never)).state).to.equal("unknown");
    expect((await checkSettlement(depsWith({}), "not an id", nonce, payer, facilitator({ status: "queued" }) as never)).state).to.equal("unknown");
  });

  it("keeps looking until it settles, and gives up with the last state after the time is up", async () => {
    const idv = "0x" + "d1".repeat(32);
    const states = ["queued", "submitted", "settled"];
    let i = 0;
    const deps = depsWith({ [TX]: receipt([settledLog()]) });
    const slept: number[] = [];
    const seen: string[] = [];
    const done = await trackSettlement(deps, idv, nonce, payer, {
      sleep: async (ms) => void slept.push(ms),
      fetchImpl: (async () => ({ status: 200, text: async () => JSON.stringify({ status: states[Math.min(i++, 2)], transaction: TX }) })) as never,
      onUpdate: (v) => seen.push(v.state),
    });
    expect(done.state).to.equal("settled");
    expect(slept).to.deep.equal([3_000, 3_000]);
    expect(seen).to.deep.equal(["pending", "pending", "settled"]);
    const waited: number[] = [];
    const stuck = await trackSettlement(depsWith({}), idv, nonce, payer, { pollMs: 1_000, timeoutMs: 3_000, sleep: async (ms) => void waited.push(ms), fetchImpl: facilitator({ status: "queued" }) as never });
    expect(stuck).to.deep.equal({ state: "pending", status: "queued" });
    expect(waited).to.have.length(3);
    const bad = await trackSettlement(depsWith({}), idv, nonce, payer, { sleep: async () => undefined, fetchImpl: facilitator({ status: "failed" }) as never });
    expect(bad.state).to.equal("not_settled");
  });
});

// ------------------------------------------------------------------------------------------- a reload mid-flow

describe("Live pages: payments kept across a reload", () => {
  const mem = () => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  const rec = (over: Partial<Inflight> = {}): Inflight => ({ id: `0x${"aa".repeat(32)}`, tool: "token_risk_check", amount: "10000", payer: getAddress(`0x${"21".repeat(20)}`), nonce: NONCE, createdAt: NOW, ...over });

  it("keeps a record, gives it back, forgets it once settled, and keeps one record per payment", () => {
    const s = mem();
    addInflight(s, rec(), NOW);
    addInflight(s, rec(), NOW + 1);
    expect(loadInflight(s, NOW + 2)).to.deep.equal([rec()]);
    addInflight(s, rec({ id: `0x${"bb".repeat(32)}`, createdAt: NOW + 5 }), NOW + 5);
    expect(loadInflight(s, NOW + 6).map((r) => r.id[2])).to.deep.equal(["b", "a"]); // newest first
    removeInflight(s, `0x${"AA".repeat(32)}`, NOW + 6);
    expect(loadInflight(s, NOW + 6).map((r) => r.id[2])).to.deep.equal(["b"]);
  });

  it("drops a record a day old, and one for another payer when asked for one payer", () => {
    const s = mem();
    addInflight(s, rec(), NOW);
    expect(loadInflight(s, NOW + INFLIGHT_MAX_AGE_SECONDS)).to.have.length(1); // exactly a day old is still kept
    expect(loadInflight(s, NOW + INFLIGHT_MAX_AGE_SECONDS + 1)).to.have.length(0);
    expect(loadInflight(s, NOW, getAddress(`0x${"21".repeat(20)}`).toLowerCase())).to.have.length(1);
    expect(loadInflight(s, NOW, getAddress(`0x${"22".repeat(20)}`))).to.have.length(0);
  });

  it("keeps no key, no signature and no answer: a record read back holds the six fields and nothing else", () => {
    const s = mem();
    addInflight(s, { ...rec(), signature: "0xsecret", output: "answer", privateKey: "0xkey" } as never, NOW);
    const raw = s.data.get(INFLIGHT_KEY) ?? "";
    expect(raw).to.not.match(/secret|answer|privateKey|0xkey/);
    expect(Object.keys(JSON.parse(raw)[0]).sort()).to.deep.equal(["amount", "createdAt", "id", "nonce", "payer", "tool"]);
    expect(Object.keys(parseInflight({ ...rec(), signature: "x" }) as object).sort()).to.deep.equal(["amount", "createdAt", "id", "nonce", "payer", "tool"]);
  });

  it("reads back only what fits: a changed or damaged value is dropped, never trusted", () => {
    for (const bad of [null, "x", {}, rec({ id: "0x12" }), rec({ tool: "Bad Tool" }), rec({ amount: "-1" }), rec({ payer: "nope" }), rec({ nonce: "0x1" }), rec({ createdAt: 0 }), rec({ createdAt: 1.5 })]) {
      expect(parseInflight(bad), JSON.stringify(bad)?.slice(0, 40)).to.equal(undefined);
    }
    const s = mem();
    s.setItem(INFLIGHT_KEY, "{ not json");
    expect(loadInflight(s, NOW)).to.deep.equal([]);
    s.setItem(INFLIGHT_KEY, JSON.stringify({ not: "a list" }));
    expect(loadInflight(s, NOW)).to.deep.equal([]);
    s.setItem(INFLIGHT_KEY, `[${JSON.stringify(rec())},{"bad":1}]`);
    expect(loadInflight(s, NOW)).to.have.length(1);
    s.setItem(INFLIGHT_KEY, "x".repeat(30_000));
    expect(loadInflight(s, NOW)).to.deep.equal([]);
  });

  it("works with no storage, and with storage that throws", () => {
    expect(loadInflight(undefined, NOW)).to.deep.equal([]);
    addInflight(undefined, rec(), NOW);
    removeInflight(undefined, rec().id, NOW);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(loadInflight(broken, NOW)).to.deep.equal([]);
    expect(() => addInflight(broken, rec(), NOW)).to.not.throw();
  });

  it("warns of a second payment for the same tool from the same payer within a minute, and not after", () => {
    const records = [rec()];
    expect(looksDuplicate(records, "token_risk_check", rec().payer, NOW + 60)).to.equal(true);
    expect(looksDuplicate(records, "token_risk_check", rec().payer, NOW + 61)).to.equal(false);
    expect(looksDuplicate(records, "contract_lookup", rec().payer, NOW + 1)).to.equal(false);
    expect(looksDuplicate(records, "token_risk_check", getAddress(`0x${"22".repeat(20)}`), NOW + 1)).to.equal(false);
    expect(looksDuplicate(records, "token_risk_check", rec().payer.toLowerCase(), NOW + 1)).to.equal(true);
  });
});

// ------------------------------------------------------------------------------------------------ the activity list

describe("Live pages: a wallet's activity", () => {
  const me = getAddress(`0x${"21".repeat(20)}`);
  const other = getAddress(`0x${"22".repeat(20)}`);
  const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const log = (iface: Interface, name: string, values: unknown[], over: { block?: number; index?: number; tx?: number } = {}) => {
    const enc = iface.encodeEventLog(iface.getEvent(name) as never, values);
    return { blockNumber: over.block ?? 100, transactionHash: TX(over.tx ?? 1), topics: enc.topics, data: enc.data, index: over.index ?? 0 };
  };
  const tool = toolIdOf("token_risk_check");

  it("turns each event into a row that says what happened, in plain words", () => {
    const dep = rowFromLog(log(routerIface, "Deposited", [me, me, 300_000n]), me, "router");
    expect(dep).to.deep.include({ kind: "deposit", label: "Deposit", amount: 300_000n, counterparty: me, detail: "From your wallet" });
    expect(rowFromLog(log(routerIface, "Deposited", [me, other, 1n]), me, "router")?.detail).to.match(/^Sent by 0x/);
    expect(rowFromLog(log(routerIface, "Withdrawn", [me, other, 5n, other, 0n]), me, "router")).to.deep.include({ kind: "withdrawal", counterparty: other });
    expect(rowFromLog(log(routerIface, "Refunded", [me, me, 7n, other, 0n]), me, "router")).to.deep.include({ kind: "refund", amount: 7n });
    const paid = rowFromLog(log(routerIface, "Settled", [me, other, tool, 10_000n, 100n, NONCE, me]), me, "router");
    expect(paid).to.deep.include({ kind: "payment", label: "Paid for a tool call", amount: 10_000n, counterparty: other });
    const earned = rowFromLog(log(routerIface, "Settled", [other, me, tool, 10_000n, 100n, NONCE, other]), me, "router");
    expect(earned).to.deep.include({ kind: "earning", counterparty: other });
    expect(earned?.detail).to.contain("fee 0.000100 QUSDC");
    const auth = rowFromLog(log(vaultIface, "SessionAuthorized", [me, other, 1n, 500_000n, 20_000n, BigInt(NOW), `0x${"00".repeat(32)}`]), me, "vault");
    expect(auth).to.deep.include({ kind: "agent_authorised", amount: 500_000n, counterparty: other });
    expect(auth?.detail).to.contain("Budget 0.500000").and.to.contain("0.020000 a call");
    expect(rowFromLog(log(vaultIface, "SessionRevoked", [me, other, 1n]), me, "vault")).to.deep.include({ kind: "agent_revoked", counterparty: other });
  });

  it("leaves out an event about another account, and a log it cannot read", () => {
    expect(rowFromLog(log(routerIface, "Deposited", [other, other, 1n]), me, "router")).to.equal(undefined);
    expect(rowFromLog(log(routerIface, "Withdrawn", [other, me, 1n, other, 0n]), me, "router")).to.equal(undefined);
    expect(rowFromLog(log(routerIface, "Refunded", [other, me, 1n, other, 0n]), me, "router")).to.equal(undefined);
    expect(rowFromLog(log(routerIface, "Settled", [other, other, tool, 1n, 0n, NONCE, other]), me, "router")).to.equal(undefined);
    expect(rowFromLog(log(vaultIface, "SessionAuthorized", [other, me, 1n, 1n, 1n, 1n, `0x${"00".repeat(32)}`]), me, "vault")).to.equal(undefined);
    expect(rowFromLog(log(vaultIface, "SessionRevoked", [other, me, 1n]), me, "vault")).to.equal(undefined);
    expect(rowFromLog({ blockNumber: 1, transactionHash: TX(1), topics: [`0x${"00".repeat(32)}`], data: "0x", index: 0 }, me, "router")).to.equal(undefined);
    expect(rowFromLog(log(routerIface, "SettleSkipped", [1n, me, NONCE, "0x12345678"]), me, "router")).to.equal(undefined);
  });

  it("pages a list in tens, brings a page number back into range, and says how many pages there are", () => {
    const list = Array.from({ length: 25 }, (_, i) => i);
    expect(paginate(list, 1, 10)).to.deep.equal({ items: list.slice(0, 10), page: 1, pages: 3, total: 25 });
    expect(paginate(list, 3, 10).items).to.deep.equal([20, 21, 22, 23, 24]);
    expect(paginate(list, 99, 10).page).to.equal(3);
    expect(paginate(list, 0, 10).page).to.equal(1);
    expect(paginate(list, -4, 10).page).to.equal(1);
    expect(paginate(list, Number.NaN, 10).page).to.equal(1);
    expect(paginate(list, 2.9, 10).page).to.equal(2);
    expect(paginate([], 1, 10)).to.deep.equal({ items: [], page: 1, pages: 1, total: 0 });
  });

  describe("reading the chain's events back from the latest block", () => {
    type Filter = { address: string; fromBlock: number; toBlock: number; topics: unknown[] };
    /** A node that refuses a block range wider than `maxRange`, as the public endpoint does, and holds one deposit of `me` at each block in `deposits`. */
    const node = (latest: number, maxRange: number, deposits: number[]) => {
      const asked: Array<{ from: number; to: number }> = [];
      const provider = {
        getBlockNumber: async () => latest,
        getLogs: async (f: Filter) => {
          asked.push({ from: f.fromBlock, to: f.toBlock });
          if (f.toBlock - f.fromBlock + 1 > maxRange) throw new Error("block range too large");
          // Only the router's first query (events of this account in the router) finds the deposits.
          if (f.address !== ROUTER || !Array.isArray(f.topics[0])) return [];
          return deposits.filter((b) => b >= f.fromBlock && b <= f.toBlock).map((b) => log(routerIface, "Deposited", [me, me, BigInt(b)], { block: b, tx: b }));
        },
      };
      return { asked, reader: { provider, routerAddress: ROUTER, vaultAddress: VAULT } as unknown as ChainReader };
    };

    it("asks for a narrower range when the node refuses one, and still finds every event", async () => {
      const { asked, reader } = node(5_000, 500, [4_900, 20]);
      const read = await readHistory(reader, me, { startBlock: 0 });
      expect(read.rows.map((r) => r.blockNumber)).to.deep.equal([4_900, 20]);
      expect(read.scan).to.deep.include({ reachedStart: true, cursor: null });
      expect(asked[0]).to.deep.equal({ from: 3_001, to: 5_000 }); // the first try is the full window, and it was refused
      expect(Math.max(...asked.filter((a) => a.to - a.from + 1 <= 500).map((a) => a.to - a.from + 1))).to.equal(500);
      expect(asked.some((a) => a.to - a.from + 1 === 1_000)).to.equal(true); // it halves one step at a time
    });

    it("gives up with the node's own error when even the narrowest range is refused", async () => {
      const { asked, reader } = node(5_000, 50, [4_900]);
      const error = await rejection(readHistory(reader, me, { startBlock: 0 }));
      expect(error.message).to.equal("block range too large");
      expect(Math.min(...asked.map((a) => a.to - a.from + 1))).to.equal(100); // never narrower than 100 blocks
    });

    it("stops once it has enough rows and says where to carry on, and carries on from there", async () => {
      const { reader } = node(5_000, 10_000, [4_900, 2_500, 20]);
      const first = await readHistory(reader, me, { startBlock: 0, window: 2_000, want: 1 });
      expect(first.rows.map((r) => r.blockNumber)).to.deep.equal([4_900]);
      expect(first.scan).to.deep.include({ reachedStart: false, cursor: 3_000, toBlock: 5_000, fromBlock: 3_001 });
      const second = await readHistory(reader, me, { startBlock: 0, window: 2_000, want: 1, before: first.scan.cursor });
      expect(second.rows.map((r) => r.blockNumber)).to.deep.equal([2_500]);
      expect(second.scan.cursor).to.equal(1_000);
    });

    it("stops at the router's first block and does not look below it, and at the window limit and says it did not reach the start", async () => {
      const { asked, reader } = node(5_000, 10_000, [4_900]);
      const bounded = await readHistory(reader, me, { startBlock: 4_000, window: 2_000 });
      expect(bounded.scan).to.deep.include({ reachedStart: true, cursor: null, fromBlock: 4_000 });
      expect(Math.min(...asked.map((a) => a.from))).to.equal(4_000);
      const limited = await readHistory(node(50_000, 10_000, []).reader, me, { startBlock: 0, window: 1_000, maxWindows: 3 });
      expect(limited.scan.reachedStart).to.equal(false);
      expect(limited.scan.cursor).to.equal(50_000 - 3_000);
    });

    it("keeps a row once when an event is found in two queries", async () => {
      const { reader } = node(100, 10_000, [60, 60]);
      expect((await readHistory(reader, me, { startBlock: 0 })).rows).to.have.length(1);
    });
  });

  it("makes a cell safe for a spreadsheet: formulas are shown as text and never run, and commas, quotes and breaks are quoted", () => {
    expect(csvCell("plain")).to.equal("plain");
    for (const cell of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(cell), JSON.stringify(cell)).to.match(/^"?'/);
    expect(csvCell("=HYPERLINK(\"http://x\")")).to.equal('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("a,b")).to.equal('"a,b"');
    expect(csvCell('say "hi"')).to.equal('"say ""hi"""');
    expect(csvCell("line\nbreak")).to.equal('"line\nbreak"');
    expect(csvCell("0.100000")).to.equal("0.100000");
  });

  it("writes a file with a header and a line for each row, newest first, with exact amounts and ISO times, and is safe when a detail looks like a formula", () => {
    const rows: HistoryRow[] = [
      { key: "a", kind: "payment", label: "Paid for a tool call", blockNumber: 12, logIndex: 0, txHash: TX(2), amount: 10_000n, counterparty: other, detail: "To 0x2222…2222, tool 0xabc", timestamp: 1_700_000_000 },
      { key: "b", kind: "deposit", label: "=Deposit", blockNumber: 11, logIndex: 0, txHash: TX(1), amount: 300_000n, detail: "From your wallet" },
    ];
    const csv = toCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).to.equal(CSV_HEADER.join(","));
    expect(lines[1]).to.equal(`2023-11-14T22:13:20Z,12,${TX(2)},Paid for a tool call,0.010000,${other},"To 0x2222…2222, tool 0xabc"`);
    expect(lines[2]).to.equal(`,11,${TX(1)},'=Deposit,0.300000,,From your wallet`);
    expect(lines[3]).to.equal("");
    expect(toCsv([])).to.equal(`${CSV_HEADER.join(",")}\r\n`);
    expect(csvFilename(me, Date.UTC(2026, 11, 1))).to.equal(`sluice-history-${me.toLowerCase().slice(0, 6)}${me.toLowerCase().slice(-4)}-2026-12-01.csv`);
  });
});

// ----------------------------------------------------------------------------------------------- the status page

describe("Live pages: the status page", () => {
  const FAC_OK = { ok: true, killSwitch: false, draining: false, store: { healthy: true }, lowBalance: false, inFlight: { count: 0, oldestAgeSeconds: 0 }, chainId: CHAIN, router: ROUTER, relayerBalanceWei: "500000000000000000", queued: 2, alerts: [], lastSettled: { transaction: `0x${"ee".repeat(32)}`, blockNumber: 99, at: NOW - 90 } };
  const config = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: ROUTER, NEXT_PUBLIC_VAULT_ADDRESS: VAULT, NEXT_PUBLIC_FACILITATOR_URL: FACILITATOR, NEXT_PUBLIC_TOOLS_URL: TOOLS });
  const probeOk = (async () => ({ ok: true, status: 200, json: async () => ({ result: "0x7c6" }) })) as unknown as typeof fetch;
  const reads = (map: Record<string, unknown>) => (async (url: string) => {
    for (const [k, v] of Object.entries(map)) if (url.startsWith(k)) return { status: typeof v === "number" ? v : 200, text: async () => (typeof v === "string" ? v : JSON.stringify(v)) };
    throw new TypeError("fetch failed");
  }) as never;

  it("reads a facilitator's health, including one that says it is not ok, and the age of its last batch", () => {
    const f = readFacilitatorHealth({ ...FAC_OK, ok: false, killSwitch: true, lowBalance: true, draining: true, store: { healthy: false }, inFlight: { count: 3, oldestAgeSeconds: 700 }, alerts: [{ kind: "low_balance", message: "x" }, "stuck"] }, { chainId: CHAIN, router: ROUTER }, NOW);
    expect(f).to.deep.include({ reachable: true, ok: false, killSwitch: true, lowBalance: true, draining: true, storeHealthy: false, inFlight: 3, oldestInFlightAgeSeconds: 700, chainMatches: true, routerMatches: true, queued: 2 });
    const up = (s: ReturnType<typeof readFacilitatorHealth>) => {
      if (!s.configured || !s.reachable) throw new Error("the facilitator was not read");
      return s;
    };
    expect(up(f).alerts).to.deep.equal(["low_balance", "stuck"]);
    expect(up(f).lastSettled).to.deep.equal({ blockNumber: 99, at: NOW - 90, ageSeconds: 90 });
    const none = readFacilitatorHealth({ ...FAC_OK, lastSettled: null }, { chainId: CHAIN, router: ROUTER }, NOW);
    expect(up(none).lastSettled).to.equal(null);
    expect(readFacilitatorHealth({ ...FAC_OK, chainId: 1983 }, { chainId: CHAIN, router: ROUTER }, NOW)).to.deep.include({ chainMatches: false });
    expect(readFacilitatorHealth({ ...FAC_OK, router: getAddress(`0x${"99".repeat(20)}`) }, { chainId: CHAIN, router: ROUTER }, NOW)).to.deep.include({ routerMatches: false });
    for (const junk of [null, "x", {}, { ok: "yes", chainId: 1 }, { ok: true }]) expect(readFacilitatorHealth(junk, { chainId: CHAIN, router: ROUTER }, NOW)).to.deep.include({ reachable: false });
  });

  it("says working when everything is as it should be, and lists what is wrong when it is not", async () => {
    const good = await readServiceStatus(config, { fetchImpl: reads({ [FACILITATOR]: FAC_OK, [TOOLS]: TOOL_HEALTH }), probeFetch: probeOk, now: () => NOW * 1000 });
    expect(good.overall).to.equal("operational");
    expect(good.problems).to.deep.equal([]);
    expect(good.rpc.healthy).to.equal(5);
    expect(good.tools).to.deep.include({ reachable: true, chainMatches: true, routerMatches: true });
  });

  const withFac = (over: object) => readServiceStatus(config, { fetchImpl: reads({ [FACILITATOR]: { ...FAC_OK, ...over }, [TOOLS]: TOOL_HEALTH }), probeFetch: probeOk, now: () => NOW * 1000 });
  it("names the kill switch, a low relayer, an unhealthy journal, a stuck batch, an open alert, and a different chain or router, each as a problem", async () => {
    expect((await withFac({ killSwitch: true })).problems.join(" ")).to.match(/kill switch is on/);
    expect((await withFac({ lowBalance: true })).problems.join(" ")).to.match(/relayer's QIE balance is low/);
    expect((await withFac({ store: { healthy: false } })).problems.join(" ")).to.match(/journal is not healthy/);
    expect((await withFac({ inFlight: { count: 1, oldestAgeSeconds: 601 } })).problems.join(" ")).to.match(/more than ten minutes/);
    expect((await withFac({ inFlight: { count: 1, oldestAgeSeconds: 600 } })).problems).to.deep.equal([]);
    expect((await withFac({ alerts: ["low_balance"] })).problems.join(" ")).to.match(/1 open alert\b/);
    expect((await withFac({ ok: false })).problems.join(" ")).to.match(/reports itself unwell/);
    expect((await withFac({ chainId: 1983 })).problems.join(" ")).to.match(/different chain/);
    expect((await withFac({ router: getAddress(`0x${"99".repeat(20)}`) })).problems.join(" ")).to.match(/different router/);
    const s = await withFac({ killSwitch: true });
    expect(s.overall).to.equal("degraded");
  });

  it("says not working when the facilitator or the tool server does not answer, or no QIE endpoint does", async () => {
    const noFac = await readServiceStatus(config, { fetchImpl: reads({ [TOOLS]: TOOL_HEALTH }), probeFetch: probeOk, now: () => NOW * 1000 });
    expect(noFac.overall).to.equal("down");
    expect(noFac.facilitator).to.deep.include({ configured: true, reachable: false });
    const noTools = await readServiceStatus(config, { fetchImpl: reads({ [FACILITATOR]: FAC_OK }), probeFetch: probeOk, now: () => NOW * 1000 });
    expect(noTools.overall).to.equal("down");
    expect(noTools.problems.join(" ")).to.match(/tool server is not answering/);
    const noRpc = await readServiceStatus(config, { fetchImpl: reads({ [FACILITATOR]: FAC_OK, [TOOLS]: TOOL_HEALTH }), probeFetch: (async () => { throw new TypeError("fetch failed"); }) as never, now: () => NOW * 1000 });
    expect(noRpc.overall).to.equal("down");
    expect(noRpc.rpc.healthy).to.equal(0);
    expect(noRpc.problems[0]).to.match(/No QIE endpoint answered/);
    const wrongTools = await readServiceStatus(config, { fetchImpl: reads({ [FACILITATOR]: FAC_OK, [TOOLS]: { ...TOOL_HEALTH, router: getAddress(`0x${"99".repeat(20)}`) } }), probeFetch: probeOk, now: () => NOW * 1000 });
    expect(wrongTools.tools).to.deep.include({ routerMatches: false });
    expect(wrongTools.overall).to.equal("degraded");
  });

  it("has nothing to check when no facilitator and no tool server are set, and does not call that working", async () => {
    const empty = await readServiceStatus(readConfig({}), { fetchImpl: reads({}), probeFetch: probeOk, now: () => NOW * 1000 });
    expect(empty.overall).to.equal("not_configured");
    expect(judge({ facilitator: { configured: false }, tools: { configured: false }, rpc: { endpoints: [], healthy: 5 } }).overall).to.equal("not_configured");
  });

  it("probes QIE's five endpoints for a QIE network, and the one it is set to otherwise", () => {
    expect(probeTargets(readConfig({}))).to.have.length(5);
    expect(probeTargets(readConfig({ NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545" }))).to.deep.equal(["http://127.0.0.1:8545/"]);
    expect(probeTargets(readConfig({ NEXT_PUBLIC_RPC_URL: "https://node.example/" }))).to.deep.equal(["https://node.example/"]);
    expect(probeTargets(readConfig({ NEXT_PUBLIC_CHAIN_ID: "1983" }))[0]).to.equal("https://rpc1testnet.qie.digital/");
  });

  it("holds an answer for the time it was given, shares one read between readers that ask together, and reads again after", async () => {
    let reads = 0;
    let clock = 1_000;
    const fake = (): Promise<ServiceStatus> => Promise.resolve({ checkedAt: ++reads } as never);
    const cached = cachedStatusReader(fake, 10_000, () => clock);
    const [a, b] = await Promise.all([cached(), cached()]);
    expect(a).to.equal(b);
    expect(reads).to.equal(1);
    clock += 9_999;
    expect((await cached()).checkedAt).to.equal(1);
    clock += 1;
    expect((await cached()).checkedAt).to.equal(2);
  });

  it("answers GET only, limits each caller, and says nothing of why when a read fails", async () => {
    const status = { overall: "operational" } as unknown as ServiceStatus;
    const now = 0;
    const handler = makeStatusHandler({ read: async () => status, perCaller: new RateLimiter({ limit: 2, windowMs: 60_000, now: () => now }), global: new RateLimiter({ limit: 100, windowMs: 60_000, maxKeys: 1, now: () => now }) });
    const get = (ip = "1.1.1.1") => handler(new Request("http://x/api/status", { headers: { "x-forwarded-for": ip } }));
    expect((await get()).status).to.equal(200);
    expect(await (await get()).json()).to.deep.equal({ ok: true, status });
    const limited = await get();
    expect(limited.status).to.equal(429);
    expect(limited.headers.get("retry-after")).to.match(/^\d+$/);
    expect((await get("2.2.2.2")).status, "another caller has its own allowance").to.equal(200);
    const post = await handler(new Request("http://x/api/status", { method: "POST" }));
    expect(post.status).to.equal(405);
    const broken = makeStatusHandler({ read: async () => { throw new Error("secret detail rpc.internal"); } });
    const failed = await broken(new Request("http://x/api/status"));
    expect(failed.status).to.equal(502);
    expect(await failed.text()).to.not.contain("secret");
  });

  it("by default lets a caller read thirty times a minute and the whole server six hundred, and says when to come back", async () => {
    const status = { overall: "operational" } as unknown as ServiceStatus;
    const handler = makeStatusHandler({ read: async () => status });
    const get = (ip: string) => handler(new Request("http://x/api/status", { headers: { "x-forwarded-for": ip } }));
    for (let i = 0; i < 30; i++) expect((await get("9.9.9.9")).status, `request ${i + 1}`).to.equal(200);
    const thirtyFirst = await get("9.9.9.9");
    expect(thirtyFirst.status).to.equal(429);
    expect(Number(thirtyFirst.headers.get("retry-after"))).to.be.within(1, 60);
    // A caller that keeps asking after it is refused does not use up the allowance of the others.
    for (let i = 0; i < 200; i++) expect((await get("9.9.9.9")).status).to.equal(429);
    // Many callers, each within their own allowance, are still held to the whole server's.
    let served = 30;
    let refused = 0;
    for (let i = 0; served < 700 && refused === 0; i++) {
      const r = await get(`10.${Math.floor(i / 250)}.${i % 250}.1`);
      if (r.status === 429) refused = served;
      else served += 1;
    }
    expect(refused, "the whole server's allowance ran out after 600 answered requests").to.equal(600);
  });
});

describe("Live pages: the QUSDC liquidity reading", () => {
  it("says it could not read the pool, rather than guess a number", async () => {
    const dead = await readQusdcLiquidity((async () => { throw new Error("down"); }) as never);
    expect(dead).to.deep.equal({ ok: false, reason: "The pool could not be read just now." });
  });

  it("keeps a good reading for the time it was given, and never keeps a failure", async () => {
    let clock = 0;
    let reads = 0;
    const results = [{ ok: false, reason: "no" }, { ok: true, qusdcUnits: 5n, qusdc: "0.000005", pair: ROUTER, readAt: 0 }, { ok: true, qusdcUnits: 6n, qusdc: "0.000006", pair: ROUTER, readAt: 0 }];
    const cached = cachedLiquidity(async () => results[reads++] as never, 300_000, () => clock);
    expect((await cached()).ok).to.equal(false);
    expect((await cached()).ok).to.equal(true);
    expect(reads).to.equal(2);
    clock = 299_999;
    expect(await cached()).to.include({ qusdc: "0.000005" });
    clock = 300_000;
    expect(await cached()).to.include({ qusdc: "0.000006" });
  });
});

// ------------------------------------------------------------------------------------------------ what the pages say

describe("Live pages: what the pages say is what the code does", () => {
  it("lists the facilitator's limits exactly as the code holds them, default and ceiling", () => {
    const qie = (wei: bigint) => `${Number(wei) / 1e18} QIE`;
    const usdc = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-US")} QUSDC`;
    const gwei = (w: bigint) => `${Number(w) / 1e9} gwei`;
    const D = DEFAULT_CAPS;
    const H = HARD_CAPS;
    const expected = [
      ["QIE the relayer may spend in a day, gas and top-ups together", qie(D.dailyBudgetWei), qie(H.dailyBudgetWei)],
      ["Highest gas price the relayer pays", gwei(D.maxGasPriceWei), gwei(H.maxGasPriceWei)],
      ["QIE one top-up may carry", qie(D.maxTopUpWei), qie(H.maxTopUpWei)],
      ["QIE sent to one address in a day", qie(D.topUpPerAddressDailyWei), qie(H.topUpPerAddressDailyWei)],
      ["QUSDC one zero-QIE start may deposit", usdc(D.maxOnboardAmount), usdc(H.maxOnboardAmount)],
      ["Zero-QIE starts per payer in a day", String(D.onboardPerPayerPerDay), String(H.onboardPerPayerPerDay)],
      ["Relayed withdrawals or refunds per account in a day", String(D.relayPerAccountPerDay), String(H.relayPerAccountPerDay)],
      ["QUSDC one payer may have queued in a day", usdc(D.payerDailyAmount), usdc(H.payerDailyAmount)],
      ["QUSDC all payers together may have queued in a day", usdc(D.globalDailyAmount), usdc(H.globalDailyAmount)],
      ["Payments in one batch", String(D.maxBatchSize), String(H.maxBatchSize)],
    ];
    expect(FACILITATOR_LIMITS.map((r) => [...r])).to.deep.equal(expected);
  });

  it("lists the owner's powers exactly as the README's table does", () => {
    const readme = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "..", "README.md"), "utf8").replace(/\r\n/g, "\n") as string;
    const section = readme.split("## What the owner can and cannot do")[1]?.split("\n## ")[0] ?? "";
    const rows = [...section.matchAll(/^\| (Can|Cannot) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => [m[1], m[2]?.trim(), m[3]?.trim()]);
    expect(rows.map((r) => [r[0], r[1]])).to.deep.equal(OWNER_POWERS.map((r) => [r[0], r[1]]));
  });

  it("states the cap this site is set to, and the other limits that apply, and says no outside review has been done", () => {
    const lines = liveLimits(2_500_000).join("\n");
    expect(lines).to.contain("at most 2.5 QUSDC");
    expect(lines).to.contain("2% (200 basis points)");
    expect(lines).to.contain("No outside security review");
    expect(liveLimits(1_000_000)[0]).to.contain("at most 1 QUSDC");
    expect(liveLimits(100_000)[0]).to.contain("at most 0.1 QUSDC");
  });
});

export { VAULT, PAYMENT_RESPONSE_META_KEY, SCHEME, X402_VERSION };
