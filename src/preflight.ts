// The pre-flight check for a live run: read-only questions to QIE's public RPC, and a verdict, GO or NO-GO.
//
// It asks only what a founder would check by hand before spending anything: are we on the chain we mean to be on, do several RPC endpoints
// answer and agree, is QUSDC what it should be, is the gas price sane, do the deployer and the relayer hold enough, and (after a deploy)
// does the router at SLUICE_ROUTER answer like a Sluice router and hold the code that was recorded when it was deployed. It holds no key,
// signs nothing and sends nothing: the client it uses can call seven read-only methods and no others.
import { Interface, TypedDataEncoder, formatUnits, getAddress, keccak256 } from "ethers";
import { NetworkError, NETWORKS } from "./evidence";
import type { Network, Rpc } from "./evidence";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, costWei } from "./gas-figures";
import { MAX_GAS_PRICE_WEI, QUSDC_ADDRESS } from "./guard";
import { RpcRefused, readOnlyRpc } from "./readrpc";
import { formatQusdc } from "./units";

/** Every method the pre-flight check may call. */
export const PREFLIGHT_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getCode",
  "eth_call",
]);

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";
export type Check = { name: string; status: CheckStatus; detail: string };

export type PreflightInput = {
  network: Network;
  /** The endpoints to ask, in order. */
  rpcUrls: string[];
  phase: "pre-deploy" | "post-deploy";
  deployer?: string;
  relayer?: string;
  router?: string;
  /** The token a testnet router holds. On mainnet it is QUSDC and this is ignored. */
  token?: string;
  /** What scripts/live/deploy.ts recorded about the deployment: the keccak256 of each contract's runtime code. */
  deployment?: { routerCodeHash?: string; vaultCodeHash?: string; router?: string; vault?: string };
  /** The relayer's daily QIE budget (SLUICE_MAX_QIE). Default 0.5 QIE. */
  relayerBudgetWei?: bigint;
  /** The QUSDC the funded run may move (SLUICE_MAX_QUSDC). Default 10. */
  maxQusdc?: bigint;
};

export type PreflightDeps = {
  fetchImpl?: typeof fetch;
  /** For tests: a node to ask instead of one made from the URLs. */
  rpc?: Rpc;
  /** Reads an explorer address with a GET, for the reachability check. */
  explorerReachable?: () => Promise<boolean>;
};

export type PreflightResult = { checks: Check[]; go: boolean; failed: string[]; warned: string[] };

const erc20 = new Interface(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const routerViews = new Interface([
  "function domainSeparator() view returns (bytes32)",
  "function token() view returns (address)",
  "function vault() view returns (address)",
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint16)",
]);
const vaultViews = new Interface(["function router() view returns (address)"]);

const QIE = 10n ** 18n;
const GWEI = 1_000_000_000n;
export const DEFAULT_RELAYER_BUDGET_WEI = QIE / 2n;
export const DEFAULT_MAX_QUSDC_UNITS = 10_000_000n;
/** The most the facilitator will pay per unit of gas (packages/facilitator/src/caps.ts, the hard ceiling). Above it the relayer waits. */
export const FACILITATOR_GAS_PRICE_CEILING_WEI = 5n * GWEI;

const qie = (wei: bigint): string => `${formatUnits(wei, 18)} QIE`;

const pass = (name: string, detail: string): Check => ({ name, status: "PASS", detail });
const warn = (name: string, detail: string): Check => ({ name, status: "WARN", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "FAIL", detail });
const skip = (name: string, detail: string): Check => ({ name, status: "SKIP", detail });

async function ethCall(rpc: Rpc, to: string, data: string): Promise<string | undefined> {
  try {
    const out = await rpc("eth_call", [{ to, data }, "latest"]);
    return typeof out === "string" && out !== "0x" ? out : undefined;
  } catch (err) {
    if (err instanceof RpcRefused) return undefined;
    throw err;
  }
}

export async function preflight(input: PreflightInput, deps: PreflightDeps = {}): Promise<PreflightResult> {
  const checks: Check[] = [];
  const expectedChain = NETWORKS[input.network].chainId;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rpc = deps.rpc ?? readOnlyRpc(input.rpcUrls, PREFLIGHT_READ_ONLY_METHODS, fetchImpl);

  // 1. Each endpoint on its own: does it answer, is it on the right chain, and how far along is it.
  if (!deps.rpc) {
    const heights: number[] = [];
    const wrong: string[] = [];
    let reachable = 0;
    for (const url of input.rpcUrls) {
      try {
        const one = readOnlyRpc([url], PREFLIGHT_READ_ONLY_METHODS, fetchImpl);
        const chain = BigInt((await one("eth_chainId", [])) as string);
        const height = Number(BigInt((await one("eth_blockNumber", [])) as string));
        reachable += 1;
        heights.push(height);
        if (chain !== BigInt(expectedChain)) wrong.push(new URL(url).host);
      } catch {
        // counted as not reachable
      }
    }
    const total = input.rpcUrls.length;
    if (wrong.length > 0) checks.push(fail("RPC endpoints", `${wrong.join(", ")} report a chain other than ${expectedChain}`));
    else if (reachable === 0) checks.push(fail("RPC endpoints", `none of ${total} endpoints answered`));
    else if (reachable < 2 && total > 1) checks.push(warn("RPC endpoints", `only ${reachable} of ${total} endpoints answered, so there is no fallback`));
    else checks.push(pass("RPC endpoints", `${reachable} of ${total} endpoints answered, all on chain ${expectedChain}`));
    if (heights.length >= 2) {
      const spread = Math.max(...heights) - Math.min(...heights);
      checks.push(spread <= 50 ? pass("Endpoints agree on the chain's height", `blocks ${Math.min(...heights)} to ${Math.max(...heights)}`) : warn("Endpoints agree on the chain's height", `the endpoints are ${spread} blocks apart: one may be behind`));
    }
  }

  // 2. The chain, through the fallback client.
  try {
    const chain = BigInt((await rpc("eth_chainId", [])) as string);
    checks.push(chain === BigInt(expectedChain) ? pass("Chain id", `${chain} (${input.network})`) : fail("Chain id", `${input.network} is chain ${expectedChain}, but the RPC says ${chain}`));
  } catch {
    checks.push(fail("Chain id", "no RPC endpoint could be read"));
    return finish(checks);
  }

  // 3. The gas price.
  let gasPrice = 0n;
  try {
    gasPrice = BigInt((await rpc("eth_gasPrice", [])) as string);
    if (gasPrice > MAX_GAS_PRICE_WEI) checks.push(fail("Gas price", `${formatUnits(gasPrice, 9)} gwei is above the ${MAX_GAS_PRICE_WEI / GWEI} gwei the live scripts stop at`));
    else if (gasPrice > FACILITATOR_GAS_PRICE_CEILING_WEI) checks.push(warn("Gas price", `${formatUnits(gasPrice, 9)} gwei is above the facilitator's ceiling of ${FACILITATOR_GAS_PRICE_CEILING_WEI / GWEI} gwei, so it would wait`));
    else checks.push(pass("Gas price", `${formatUnits(gasPrice, 9)} gwei`));
  } catch {
    checks.push(fail("Gas price", "the gas price could not be read"));
  }

  // 4. The token.
  const token = input.network === "mainnet" ? QUSDC_ADDRESS : input.token;
  if (!token) {
    checks.push(input.phase === "pre-deploy" ? warn("Token", "no token is named (SLUICE_TOKEN): a testnet router needs one, see docs/REHEARSAL.md") : fail("Token", "no token is named (SLUICE_TOKEN)"));
  } else {
    try {
      const code = (await rpc("eth_getCode", [getAddress(token), "latest"])) as string;
      if (code === "0x") {
        checks.push(fail(input.network === "mainnet" ? "QUSDC" : "Token", `there is no contract at ${getAddress(token)}`));
      } else {
        const out = await ethCall(rpc, getAddress(token), erc20.encodeFunctionData("decimals"));
        const decimals = out ? Number(erc20.decodeFunctionResult("decimals", out)[0]) : undefined;
        checks.push(decimals === 6 ? pass(input.network === "mainnet" ? "QUSDC" : "Token", `${getAddress(token)} has code and 6 decimals`) : fail(input.network === "mainnet" ? "QUSDC" : "Token", `it reports ${decimals ?? "no"} decimals, not 6`));
      }
    } catch {
      checks.push(fail("Token", "the token could not be read"));
    }
  }

  // 5. Balances.
  const balance = async (address: string): Promise<bigint> => BigInt((await rpc("eth_getBalance", [getAddress(address), "latest"])) as string);
  if (input.deployer && input.relayer && getAddress(input.deployer) === getAddress(input.relayer)) {
    checks.push(fail("Deployer and relayer", "they are the same address: the relayer is a hot key that must hold only gas money, so it needs a key of its own"));
  }
  if (input.deployer) {
    try {
      const need = costWei(MEASURED_GAS.deployRouter + SMOKE_GAS_TOTAL, gasPrice, 50n);
      const have = await balance(input.deployer);
      checks.push(have >= need ? pass("Deployer QIE", `${qie(have)}; a deploy and the smoke run cost about ${qie(costWei(MEASURED_GAS.deployRouter + SMOKE_GAS_TOTAL, gasPrice))} at this price (docs/GAS.md)`) : fail("Deployer QIE", `${qie(have)} is below ${qie(need)}, the measured cost of a deploy and the smoke run at this price with a margin of half again`));
      if (token) {
        const out = await ethCall(rpc, getAddress(token), erc20.encodeFunctionData("balanceOf", [getAddress(input.deployer)]));
        const units = out ? (erc20.decodeFunctionResult("balanceOf", out)[0] as bigint) : 0n;
        const want = input.maxQusdc ?? DEFAULT_MAX_QUSDC_UNITS;
        if (units >= want) checks.push(pass("Deployer QUSDC", `${formatQusdc(units)} QUSDC, enough for a funded run of up to ${formatQusdc(want)}`));
        else if (units >= 300_000n) checks.push(warn("Deployer QUSDC", `${formatQusdc(units)} QUSDC covers the smoke run (0.3) but not a funded run of up to ${formatQusdc(want)}`));
        else checks.push(fail("Deployer QUSDC", `${formatQusdc(units)} QUSDC is below the 0.300000 the smoke run deposits`));
      }
    } catch {
      checks.push(fail("Deployer QIE", "the deployer's balance could not be read"));
    }
  } else {
    checks.push(skip("Deployer", "no deployer address given (--deployer, or SLUICE_KEY in the environment)"));
  }
  if (input.relayer) {
    try {
      const have = await balance(input.relayer);
      const budget = input.relayerBudgetWei ?? DEFAULT_RELAYER_BUDGET_WEI;
      const floor = costWei(MEASURED_GAS.batch50Worst * 5n, gasPrice);
      if (have < floor) checks.push(fail("Relayer QIE", `${qie(have)} is below ${qie(floor)}, five of the largest batches measured`));
      else if (have < budget) checks.push(warn("Relayer QIE", `${qie(have)} is below one day's budget of ${qie(budget)}, which /health reports as low`));
      else checks.push(pass("Relayer QIE", `${qie(have)}, at least one day's budget of ${qie(budget)}`));
    } catch {
      checks.push(fail("Relayer QIE", "the relayer's balance could not be read"));
    }
  } else {
    checks.push(skip("Relayer", "no relayer address given (--relayer, or SLUICE_RELAYER_KEY in the environment)"));
  }

  // 6. The router.
  if (!input.router) {
    checks.push(input.phase === "pre-deploy" ? skip("Router", "nothing is deployed yet") : fail("Router", "SLUICE_ROUTER is not set"));
  } else {
    await checkRouter(checks, rpc, input);
  }

  // 7. The explorer, only to say whether it can be reached (it answers 502 at times).
  if (deps.explorerReachable) {
    checks.push((await deps.explorerReachable()) ? pass("Explorer", "answers") : warn("Explorer", "did not answer. It is used only for links and for verifying source; try again later, or use the manual steps in docs/MAINNET-RUNBOOK.md"));
  }

  return finish(checks);
}

async function checkRouter(checks: Check[], rpc: Rpc, input: PreflightInput): Promise<void> {
  const name = "Router";
  let router: string;
  try {
    router = getAddress(input.router as string);
  } catch {
    checks.push(fail(name, "SLUICE_ROUTER is not an address"));
    return;
  }
  try {
    const code = (await rpc("eth_getCode", [router, "latest"])) as string;
    if (code === "0x") {
      checks.push(fail(name, `there is no contract at ${router} on ${input.network}`));
      return;
    }
    const chainId = NETWORKS[input.network].chainId;
    const sep = await ethCall(rpc, router, routerViews.encodeFunctionData("domainSeparator"));
    const expected = TypedDataEncoder.hashDomain({ name: "SluiceRouter", version: "1", chainId, verifyingContract: router });
    if (!sep || routerViews.decodeFunctionResult("domainSeparator", sep)[0] !== expected) {
      checks.push(fail(name, `${router} does not answer like a Sluice router on chain ${chainId}`));
      return;
    }
    const read = async (fn: string): Promise<string> => {
      const out = await ethCall(rpc, router, routerViews.encodeFunctionData(fn));
      if (!out) throw new Error("no answer");
      return String(routerViews.decodeFunctionResult(fn, out)[0]);
    };
    const [token, vault, owner, feeRecipient, feeBps] = await Promise.all([read("token"), read("vault"), read("owner"), read("feeRecipient"), read("feeBps")]);
    const problems: string[] = [];
    if (input.network === "mainnet" && getAddress(token) !== getAddress(QUSDC_ADDRESS)) problems.push(`it holds ${getAddress(token)}, not QUSDC`);
    if (input.network === "testnet" && input.token && getAddress(token) !== getAddress(input.token)) problems.push(`it holds ${getAddress(token)}, not SLUICE_TOKEN`);
    if (Number(feeBps) > 200) problems.push(`its fee is ${feeBps} basis points, above the 200 the contract allows`);
    if (input.relayer && [owner, feeRecipient].some((a) => getAddress(a) === getAddress(input.relayer as string))) problems.push("the relayer is its owner or its fee recipient, which the facilitator refuses");
    const vaultCode = (await rpc("eth_getCode", [getAddress(vault), "latest"])) as string;
    const back = vaultCode === "0x" ? undefined : await ethCall(rpc, getAddress(vault), vaultViews.encodeFunctionData("router"));
    if (!back || getAddress(String(vaultViews.decodeFunctionResult("router", back)[0])) !== router) problems.push("its vault does not point back at it");
    checks.push(problems.length ? fail(name, `${router}: ${problems.join("; ")}`) : pass(name, `${router} answers like a Sluice router on chain ${chainId}; owner ${getAddress(owner)}, fee recipient ${getAddress(feeRecipient)}, fee ${feeBps} bps`));

    // The code on the chain against the hash recorded when the deployment was made.
    const dep = input.deployment;
    if (!dep?.routerCodeHash) {
      checks.push(skip("Deployed code", "no deployment record with a code hash was given (--deployment deployment.json)"));
    } else {
      const bad: string[] = [];
      if (dep.router && getAddress(dep.router) !== router) bad.push("SLUICE_ROUTER is not the router the deployment record names");
      if (keccak256(code) !== dep.routerCodeHash.toLowerCase()) bad.push("the router's code is not the code recorded at deployment");
      if (dep.vaultCodeHash && keccak256(vaultCode) !== dep.vaultCodeHash.toLowerCase()) bad.push("the vault's code is not the code recorded at deployment");
      checks.push(bad.length ? fail("Deployed code", bad.join("; ")) : pass("Deployed code", "the router's and the vault's code hash match the deployment record"));
    }
  } catch (err) {
    checks.push(err instanceof NetworkError ? fail(name, "the router could not be read") : fail(name, "the router did not answer as a Sluice router does"));
  }
}

function finish(checks: Check[]): PreflightResult {
  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.name);
  const warned = checks.filter((c) => c.status === "WARN").map((c) => c.name);
  return { checks, go: failed.length === 0, failed, warned };
}

/** The lines to print: one per check, then the verdict. */
export function formatPreflight(result: PreflightResult, network: Network): string[] {
  const lines = result.checks.map((c) => `${c.status.padEnd(4)} ${c.name}: ${c.detail}`);
  lines.push("");
  lines.push(result.go ? `GO on ${network}${result.warned.length ? ` (with warnings: ${result.warned.join(", ")})` : ""}` : `NO-GO on ${network}: ${result.failed.join(", ")}`);
  return lines;
}
