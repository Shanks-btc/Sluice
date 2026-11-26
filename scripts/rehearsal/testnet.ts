// pnpm rehearsal:testnet: the whole rehearsal on QIE's TESTNET (chain 1983), one step after another, resumable.
//
//   pnpm rehearsal:testnet            run, or carry on from where the last run stopped
//   pnpm rehearsal:testnet --status   print where it has got to, and change nothing
//
// It reads two throwaway key files in the repository root, deployer-testnet.key and relayer-testnet.key, and only inside this program: it
// checks each against the address it is meant to hold, hands a key to the program that needs it through that program's own environment,
// and never prints one, copies one, or writes one into a log, a state file or a document. It sends on the testnet only. Every step that
// sends first asks the node for its chain id and stops unless it is 1983. It calls no faucet.
//
// Where it keeps things (all git-ignored):
//   rehearsal-state.json      where the run has got to: addresses, hashes and numbers, never a key
//   .rehearsal/               the throwaway owner and agent keys made for this run, the facilitator's queue, logs, and the scripts' work files
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { Contract, Interface, Wallet, getAddress, id as keccak, zeroPadValue } from "ethers";
import { FacilitatorClient, cutSecrets, signOnboarding } from "@sluice/sdk";
import type { FailoverJsonRpcProvider } from "@sluice/sdk";
import { formatQie } from "../../src/guard";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import type { RpcChoice } from "../../src/rpc-use";
import {
  EXPECTED_ADDRESSES, PER_TX_CAP_WEI, REHEARSAL_CHAIN_ID, RELAYER_DAILY_BUDGET_WEI, STEPS, TESTNET_EXPLORER, RehearsalRefused, StateError, addTx, assertTestnetChain,
  assertUnderTxCap, faucetStopLines, formatGwei, fundingNeeds, hashesIn, measuredFor, newState, parseState, refuseUnsafeSettings, runRehearsal, serializeState, shortfalls,
  statusLines,
} from "../../src/rehearsal";
import type { RehearsalState, StepDef, StepId, StepOutcome } from "../../src/rehearsal";
import { main as deployToken } from "../live/deploy-test-token";
import { main as deploy } from "../live/deploy";
import { main as smoke } from "../live/smoke";
import { main as preflight } from "../live/preflight";
import { main as verify } from "../live/verify-contracts";
import type { VerifyIo } from "../live/verify-contracts";
import { main as record } from "../evidence/record";
import type { RecordIo } from "../evidence/record";
import { main as evidenceCheck } from "../evidence-check";
import { main as evidenceSummary } from "../evidence-summary";
import { main as ownerSetup } from "../client/owner-setup";
import { main as scriptedClient } from "../client/smoke-client";

export type Env = Record<string, string | undefined>;
/**
 * `expected`, `record`, `evidence` and `verify` are for tests: the command line and the environment cannot set them. They let a test point
 * the run at a local node that reports chain 1983, with throwaway keys of its own and a copy of the evidence file, so that the real key
 * files, the real evidence file and the real testnet are not involved.
 */
export type RehearsalIo = {
  log?: (line: string) => void;
  root?: string;
  expected?: { deployer: string; relayer: string };
  record?: Partial<RecordIo>;
  evidence?: { file?: string; text?: string; deps?: Parameters<typeof evidenceCheck>[4]; summaryRpc?: Parameters<typeof evidenceSummary>[2] };
  verify?: VerifyIo;
};

const ROOT = join(__dirname, "..", "..");
const TOKEN_UNITS = 1_000_000n; // one test token, six decimals
const TOOLS = [
  { name: "token_risk_check", price: "0.01" },
  { name: "contract_lookup", price: "0.005" },
] as const;
const DAY_SECONDS = 86_400;

type Service = { child: ChildProcess; port: number; url: string; logPath: string; flushMs?: number };
type Keys = { deployer: string; relayer: string; owner: string; agent: string };
type Ctx = {
  root: string;
  dir: string;
  work: string;
  statePath: string;
  state: RehearsalState;
  env: Env;
  out: (line: string) => void;
  secrets: string[];
  io: RehearsalIo;
  keys?: Keys;
  conn?: { choice: RpcChoice; provider: FailoverJsonRpcProvider };
  fac?: Service;
  tools?: Service;
};

// ------------------------------------------------------------------------------------------------------------------------------ small helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (text: string, n = 300): string => (text.length > n ? `${text.slice(0, n)}…` : text);
const hash64 = (text: string): string[] => [...text.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0].toLowerCase());

function inherited(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "NODE_OPTIONS", "ComSpec", "PATHEXT", "windir"]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

async function getJson(url: string, timeoutMs = 8_000): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // left empty
  }
  return { status: res.status, body };
}

// ----------------------------------------------------------------------------------------------------------------------------------- keys

function readKeyFile(root: string, name: string): string {
  const file = join(root, name);
  if (!existsSync(file)) throw new Error(`the key file ${name} is not in the repository root`);
  const text = readFileSync(file, "utf8").trim();
  const m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(text);
  if (!m) throw new Error(`${name} does not hold a 32-byte hex key on one line`);
  return `0x${m[1]}`;
}

/** A key file's key, once it is checked to belong to the address it is meant to hold. The messages name the file and the address, never the key. */
export function readCheckedKey(root: string, name: string, expected: string): string {
  const key = readKeyFile(root, name);
  if (new Wallet(key).address !== getAddress(expected)) throw new Error(`${name} does not belong to ${getAddress(expected)}, so it is not used`);
  return key;
}

/** Reads and checks the two given keys, and makes (or reads again) the throwaway owner and agent keys for this run. Prints addresses only. */
function loadKeys(ctx: Ctx): Keys {
  if (ctx.keys) return ctx.keys;
  const deployer = readKeyFile(ctx.root, "deployer-testnet.key");
  const relayer = readKeyFile(ctx.root, "relayer-testnet.key");
  ctx.secrets.push(deployer, relayer); // from here on every line that is printed or logged has them cut out
  const expected = ctx.io.expected ?? EXPECTED_ADDRESSES;
  const dAddr = new Wallet(readCheckedKey(ctx.root, "deployer-testnet.key", expected.deployer)).address;
  const rAddr = new Wallet(readCheckedKey(ctx.root, "relayer-testnet.key", expected.relayer)).address;
  const fresh = (name: string): string => {
    const file = join(ctx.dir, name);
    if (existsSync(file)) return readKeyFile(ctx.dir, name);
    const key = Wallet.createRandom().privateKey;
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    return key;
  };
  const owner = fresh("owner.key");
  const agent = fresh("agent.key");
  ctx.secrets.push(owner, agent);
  ctx.keys = { deployer, relayer, owner, agent };
  ctx.state.data.deployer = dAddr;
  ctx.state.data.relayer = rAddr;
  ctx.state.data.owner = new Wallet(owner).address;
  ctx.state.data.agent = new Wallet(agent).address;
  return ctx.keys;
}

// ------------------------------------------------------------------------------------------------------------------------------- the chain

/** Chooses an endpoint, and refuses unless the node says chain 1983. A node on chain 1990, or any other chain, stops the run here. */
export async function openTestnet(env: Env, out: (line: string) => void, options: { fetchImpl?: typeof fetch } = {}): Promise<{ choice: RpcChoice; provider: FailoverJsonRpcProvider }> {
  const choice = await chooseRpc("testnet", env.SLUICE_RPC_URL, out, options);
  const provider = providerFor(choice, REHEARSAL_CHAIN_ID, 20_000);
  try {
    assertTestnetChain(await provider.send("eth_chainId", []), `the endpoint ${new URL(choice.url).host}`);
  } catch (err) {
    provider.destroy();
    throw err;
  }
  return { choice, provider };
}

/** Chooses an endpoint (once per run), and refuses unless the node says chain 1983. */
async function connect(ctx: Ctx): Promise<{ choice: RpcChoice; provider: FailoverJsonRpcProvider }> {
  if (ctx.conn) return ctx.conn;
  const conn = await openTestnet(ctx.env, ctx.out);
  ctx.state.data.endpoint = new URL(conn.choice.url).host;
  ctx.conn = conn;
  return conn;
}

/** Every send asks again: the chain id is checked immediately before, and a node that has moved to another chain stops the run. */
async function verifiedProvider(ctx: Ctx): Promise<FailoverJsonRpcProvider> {
  const { provider } = await connect(ctx);
  assertTestnetChain(await provider.send("eth_chainId", []), "the node");
  return provider;
}

type SentTx = { hash: string; wait: () => Promise<{ status: number | null; hash: string; blockNumber: number; gasUsed: bigint; gasPrice: bigint } | null> };
type CallFn = ((...args: unknown[]) => Promise<SentTx>) & { estimateGas: (...args: unknown[]) => Promise<bigint> };

/** One contract call from a key this program holds, under the cap for one transaction. Returns the transaction's hash. */
async function sendCall(ctx: Ctx, step: StepId, label: string, key: string, to: string, abi: string[], method: string, args: unknown[]): Promise<string> {
  const provider = await verifiedProvider(ctx);
  const signer = new Wallet(key, provider);
  const fn = new Contract(to, abi, signer).getFunction(method) as unknown as CallFn;
  const price = (await provider.getFeeData()).gasPrice;
  if (price === null || price === undefined || price <= 0n) throw new Error("the node gave no gas price");
  const estimate = await fn.estimateGas(...args);
  const gasLimit = (estimate * 12n) / 10n;
  assertUnderTxCap(gasLimit, price, label);
  const tx = await fn(...args, { gasLimit, gasPrice: price });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label}: the transaction failed (${tx.hash})`);
  ctx.out(`${label}: ${receipt.hash} in block ${receipt.blockNumber}`);
  addTx(ctx.state, { step, label, hash: receipt.hash, block: receipt.blockNumber, gasUsed: String(receipt.gasUsed), gasPriceWei: String(receipt.gasPrice), costWei: String(receipt.gasUsed * receipt.gasPrice) });
  return receipt.hash.toLowerCase();
}

/** Fills in the gas and cost of every recorded transaction from its receipt. */
async function enrichTxs(ctx: Ctx): Promise<void> {
  if (!ctx.conn) return;
  const provider = ctx.conn.provider;
  for (const tx of ctx.state.txs) {
    if (tx.gasUsed && tx.costWei && tx.block !== undefined) continue;
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt) continue;
      addTx(ctx.state, { ...tx, block: receipt.blockNumber, gasUsed: String(receipt.gasUsed), gasPriceWei: String(receipt.gasPrice), costWei: String(receipt.gasUsed * receipt.gasPrice) });
    } catch {
      // the receipt can be filled in on a later run
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------ running the other scripts

/** The environment a live script gets: the testnet, the caps, and what the step adds. */
function scriptEnv(ctx: Ctx, extra: Env): Env {
  // A node the person named is used as given by every script; with none named each script probes QIE's endpoints and says which it chose.
  const named = ctx.env.SLUICE_RPC_URL?.trim();
  return { SLUICE_NETWORK: "testnet", SLUICE_MAX_QIE: "0.5", SLUICE_MAX_TX_QIE: formatQie(PER_TX_CAP_WEI), ...(named ? { SLUICE_RPC_URL: named } : {}), ...extra };
}

/** Runs a script's main with this run's work folder as the current directory (where deployment.json and the other files go). */
async function inWork<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(ctx.work);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

function collector(ctx: Ctx): { lines: string[]; say: (line: string) => void } {
  const lines: string[] = [];
  return { lines, say: (line: string) => { lines.push(cutSecrets(line, ctx.secrets)); ctx.out(line); } };
}

const exitFailure = (what: string, code: number, lines: string[]): Error => {
  const bad = lines.filter((l) => /^(FAIL|refused|NO-GO|the |no )/i.test(l)).slice(-4);
  return new Error(`${what} exited ${code}${bad.length ? `: ${bad.join(" | ")}` : ""}`);
};

// -------------------------------------------------------------------------------------------------------------------------- local services

async function startService(ctx: Ctx, name: "facilitator" | "tool server", script: string, args: string[], env: Env, port: number, logPath: string, flushMs?: number): Promise<Service> {
  if (!existsSync(script)) throw new Error(`${script.replace(ROOT, ".")} is not built: run pnpm build first`);
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env: { ...inherited(), ...env } as NodeJS.ProcessEnv, stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  const url = `http://127.0.0.1:${port}`;
  const service: Service = { child, port, url, logPath, ...(flushMs !== undefined ? { flushMs } : {}) };
  let exited = false;
  child.once("exit", () => { exited = true; });
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (exited) {
      const tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-3).map((l) => cutSecrets(l, ctx.secrets)).join(" | ");
      throw new Error(`the ${name} stopped while starting: ${short(tail, 500)}`);
    }
    try {
      const { status, body } = await getJson(`${url}/health`, 3_000);
      if (status === 200 || body.ok === true) return service;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  child.kill("SIGKILL");
  throw new Error(`the ${name} did not answer /health within 90 seconds`);
}

function alive(s: Service | undefined): s is Service {
  return Boolean(s && s.child.exitCode === null && s.child.signalCode === null);
}

async function stopService(s: Service | undefined): Promise<void> {
  if (!alive(s)) return;
  await new Promise<void>((resolveStop) => {
    s.child.once("exit", () => resolveStop());
    s.child.kill("SIGKILL"); // on Windows every kill is abrupt, so there is no gentler form
    setTimeout(resolveStop, 5_000);
  });
}

async function ensureFacilitator(ctx: Ctx, flushMs: number): Promise<Service> {
  if (alive(ctx.fac) && ctx.fac.flushMs === flushMs) return ctx.fac;
  await stopService(ctx.fac);
  const keys = loadKeys(ctx);
  const data = ctx.state.data;
  if (!data.router) throw new Error("there is no router yet");
  if (!data.facilitatorPort) data.facilitatorPort = await freePort();
  const port = data.facilitatorPort;
  const dir = join(ctx.dir, "facilitator");
  mkdirSync(dir, { recursive: true });
  const env: Env = {
    SLUICE_NETWORK: "testnet",
    SLUICE_APPROVE: "facilitator",
    SLUICE_MAX_QIE: formatQie(RELAYER_DAILY_BUDGET_WEI),
    SLUICE_ROUTER: data.router,
    SLUICE_RELAYER_KEY: keys.relayer,
    SLUICE_FACILITATOR_STATE: join(dir, "queue.jsonl"),
    SLUICE_FACILITATOR_KILL_FILE: join(dir, "KILL"),
    SLUICE_FACILITATOR_PORT: String(port),
    SLUICE_FACILITATOR_HOST: "127.0.0.1",
    SLUICE_FACILITATOR_URL: `http://127.0.0.1:${port}`,
    SLUICE_FACILITATOR_FLUSH_MS: String(flushMs),
    SLUICE_FACILITATOR_LOW_BALANCE_QIE: "0.005",
    ...(ctx.env.SLUICE_RPC_URL?.trim() ? { SLUICE_RPC_URL: ctx.env.SLUICE_RPC_URL.trim() } : {}),
  };
  ctx.out(`starting the facilitator on 127.0.0.1:${port} (settles every ${flushMs / 1000} s; its queue is ${join(".rehearsal", "facilitator", "queue.jsonl")})`);
  const service = await startService(ctx, "facilitator", join(ROOT, "packages", "facilitator", "dist", "cli.js"), [], env, port, join(dir, "facilitator.log"), flushMs);
  const { body } = await getJson(`${service.url}/health`);
  assertTestnetChain(String(body.chainId), "the facilitator");
  if (getAddress(String(body.router)) !== getAddress(data.router)) throw new Error("the facilitator is on another router than this run's");
  if (getAddress(String(body.relayer)) !== getAddress(String(data.relayer))) throw new Error("the facilitator's relayer is not the relayer key's address");
  if (body.killSwitch !== false) throw new Error("the facilitator started with the kill switch on");
  const chosen = readFileSync(service.logPath, "utf8").split("\n").reverse().find((l) => l.includes("rpc endpoint chosen"));
  if (chosen) ctx.out(`facilitator: ${cutSecrets(chosen, ctx.secrets)}`);
  ctx.out(`facilitator up: chain ${String(body.chainId)}, relayer ${String(body.relayer)} holds ${formatQie(BigInt(String(body.relayerBalanceWei)))} QIE`);
  ctx.fac = service;
  return service;
}

async function ensureToolServer(ctx: Ctx): Promise<Service> {
  if (alive(ctx.tools)) return ctx.tools;
  const keys = loadKeys(ctx);
  const data = ctx.state.data;
  const fac = await ensureFacilitator(ctx, ctx.fac?.flushMs ?? 6_000);
  if (!data.toolsPort) data.toolsPort = await freePort();
  const port = data.toolsPort;
  const dir = join(ctx.dir, "tools");
  mkdirSync(dir, { recursive: true });
  const env: Env = {
    SLUICE_NETWORK: "testnet",
    SLUICE_ROUTER: data.router ?? "",
    SLUICE_FACILITATOR_URL: fac.url,
    SLUICE_PAYEE: new Wallet(keys.deployer).address,
    SLUICE_TOOLS_HOST: "127.0.0.1",
    SLUICE_TOOLS_PORT: String(port),
    ...(ctx.env.SLUICE_RPC_URL?.trim() ? { SLUICE_RPC_URL: ctx.env.SLUICE_RPC_URL.trim() } : {}),
  };
  ctx.out(`starting the example tool server on 127.0.0.1:${port}, paying ${env.SLUICE_PAYEE} (the builder)`);
  const service = await startService(ctx, "tool server", join(ROOT, "examples", "paid-tools", "dist", "cli.js"), ["--http"], env, port, join(dir, "tools.log"));
  const { body } = await getJson(`${service.url}/health`);
  ctx.out(`tool server up: ${JSON.stringify(body).slice(0, 300)}`);
  ctx.tools = service;
  return service;
}

// ----------------------------------------------------------------------------------------------------------------------------- paid calls

type Call = { tool: string; intent?: string; code: number; lines: string[] };

function proxyConfig(ctx: Ctx): string {
  const data = ctx.state.data;
  const keys = loadKeys(ctx);
  if (!data.router || !data.token || !data.toolsPort) throw new Error("the router, the token and the tool server are needed for the proxy's config");
  const file = join(ctx.dir, "sluice.config.json");
  const builder = new Wallet(keys.deployer).address;
  const grantExpiry = Number(data.agentGrantExpiry ?? 0);
  const expiresAt = new Date((grantExpiry > 0 ? grantExpiry - 600 : Math.floor(Date.now() / 1000) + DAY_SECONDS - 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const config = {
    upstream: { url: `http://127.0.0.1:${data.toolsPort}/mcp` },
    router: data.router,
    payer: new Wallet(keys.owner).address,
    chainId: REHEARSAL_CHAIN_ID,
    asset: data.token,
    budget: { perCallCap: "0.02", totalCap: "0.5", expiresAt, allowedTools: TOOLS.map((t) => ({ tool: t.name, payee: builder })) },
    logFile: join(ctx.dir, "sluice-payments.jsonl"),
    stateFile: join(ctx.dir, "sluice-budget.json"),
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** One paid call through the scripted client, which starts the payment proxy as a child process. */
async function paidCall(ctx: Ctx, tool: string, args: Record<string, string>): Promise<Call> {
  const keys = loadKeys(ctx);
  await ensureToolServer(ctx);
  const config = proxyConfig(ctx);
  const { lines, say } = collector(ctx);
  const code = await scriptedClient(["--config", config, "--tool", tool, "--args", JSON.stringify(args)], { SLUICE_AGENT_KEY: keys.agent, SLUICE_NETWORK: "testnet", ...(ctx.env.SLUICE_RPC_URL ? { SLUICE_RPC_URL: ctx.env.SLUICE_RPC_URL } : {}) }, { log: say });
  const intent = lines.map((l) => /intent (0x[0-9a-fA-F]{64}) is/.exec(l)?.[1]).find(Boolean)?.toLowerCase();
  return { tool, code, lines, ...(intent ? { intent } : {}) };
}

type IntentStatus = { id: string; status: string; transaction?: string; blockNumber?: number; reason?: string };

async function statusOf(ctx: Ctx, id: string): Promise<IntentStatus> {
  const fac = await ensureFacilitator(ctx, ctx.fac?.flushMs ?? 6_000);
  const { body } = await getJson(`${fac.url}/status/${id}`);
  return body as unknown as IntentStatus;
}

/** Waits until every intent is settled (or one is not going to be), and returns each one's status. */
async function waitSettled(ctx: Ctx, ids: string[], timeoutMs = 240_000): Promise<IntentStatus[]> {
  const started = Date.now();
  let last: IntentStatus[] = [];
  while (Date.now() - started < timeoutMs) {
    last = [];
    for (const id of ids) last.push(await statusOf(ctx, id));
    const bad = last.find((s) => ["skipped", "expired", "failed"].includes(s.status));
    if (bad) throw new Error(`intent ${bad.id} is ${bad.status}${bad.reason ? ` (${bad.reason})` : ""}`);
    if (last.every((s) => s.status === "settled")) return last;
    await sleep(3_000);
  }
  throw new Error(`not every intent settled within ${timeoutMs / 1000} seconds: ${last.map((s) => `${s.id.slice(0, 10)} ${s.status}`).join(", ")}`);
}

const dataList = (ctx: Ctx, key: string): string[] => (Array.isArray(ctx.state.data[key]) ? (ctx.state.data[key] as string[]) : []);

// ------------------------------------------------------------------------------------------------------------------------------- the steps

type StepFn = (ctx: Ctx) => Promise<StepOutcome>;
const done = (note?: string): StepOutcome => ({ kind: "done", ...(note ? { note } : {}) });

const ERC20 = ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"];
const ROUTER_ABI = [
  "function earnings(address) view returns (uint256)",
  "function withdraw(uint256 amount, address to)",
  "function payerBalance(address) view returns (uint256)",
];
const SETTLED = new Interface(["event Settled(address indexed payer, address indexed payee, bytes32 indexed toolId, uint256 amount, uint256 fee, bytes32 nonce, address signer)"]);

async function requireCode(ctx: Ctx, address: string, what: string): Promise<void> {
  const provider = await verifiedProvider(ctx);
  if ((await provider.getCode(address)) === "0x") throw new Error(`there is no contract at ${address}, so ${what} is not on the chain`);
}

const stepFns: Record<StepId, StepFn> = {
  // ------------------------------------------------------------------------------------------------------- 1. keys, endpoint, balances
  async keys(ctx) {
    const keys = loadKeys(ctx);
    ctx.out(`deployer ${new Wallet(keys.deployer).address} (the key file's address matches the one given)`);
    ctx.out(`relayer  ${new Wallet(keys.relayer).address} (the key file's address matches the one given)`);
    ctx.out(`throwaway owner ${ctx.state.data.owner} and agent ${ctx.state.data.agent} for this run, in .rehearsal/ (git-ignored; zero QIE, test tokens only)`);
    return done("both key files hold the addresses they should");
  },

  async endpoint(ctx) {
    const { choice, provider } = await connect(ctx);
    ctx.out(`will ask ${new URL(choice.url).host} for everything, with ${choice.fallbacks.length} fallback${choice.fallbacks.length === 1 ? "" : "s"} for reads`);
    ctx.out(`chain id ${BigInt(String(await provider.send("eth_chainId", [])))} confirmed, block ${await provider.getBlockNumber()}`);
    return done(`${new URL(choice.url).host}, chain 1983`);
  },

  async funding(ctx) {
    const keys = loadKeys(ctx);
    const { provider } = await connect(ctx);
    const gasPrice = (await provider.getFeeData()).gasPrice;
    if (gasPrice === null || gasPrice === undefined || gasPrice <= 0n) throw new Error("the node gave no gas price");
    const dAddr = new Wallet(keys.deployer).address;
    const rAddr = new Wallet(keys.relayer).address;
    const balances = { deployer: await provider.getBalance(dAddr), relayer: await provider.getBalance(rAddr) };
    const needs = fundingNeeds(gasPrice, { deployer: dAddr, relayer: rAddr });
    ctx.out(`gas price ${formatGwei(gasPrice)} gwei; deployer holds ${formatQie(balances.deployer)} QIE, relayer holds ${formatQie(balances.relayer)} QIE`);
    ctx.out(`the run needs at least ${formatQie(needs.deployer.minWei)} QIE at the deployer and ${formatQie(needs.relayer.minWei)} QIE at the relayer`);
    ctx.state.data.gasPriceWei = gasPrice.toString();
    ctx.state.data.startBalances = { deployer: balances.deployer.toString(), relayer: balances.relayer.toString() };
    const short = shortfalls(needs, balances);
    if (short.length > 0) return { kind: "stop", lines: faucetStopLines(short, needs.deployer.priceWei, gasPrice) };
    return done(`deployer ${formatQie(balances.deployer)} QIE, relayer ${formatQie(balances.relayer)} QIE`);
  },

  // ------------------------------------------------------------------------------------------------- 2. token, pre-flight, router deploy
  async token(ctx) {
    const keys = loadKeys(ctx);
    const provider = await verifiedProvider(ctx);
    const file = join(ctx.work, "testnet-token.json");
    if (!ctx.state.data.token && existsSync(file)) {
      const found = JSON.parse(readFileSync(file, "utf8")) as { token?: string; chainId?: number };
      if (found.chainId === REHEARSAL_CHAIN_ID && found.token && (await provider.getCode(found.token)) !== "0x") {
        ctx.state.data.token = getAddress(found.token);
        ctx.out(`the token from an earlier run is on the chain: ${found.token}`);
      }
    }
    if (!ctx.state.data.token) {
      ctx.out("will deploy the test token (no value, open mint) and mint 1,000 of it to the deployer");
      const { lines, say } = collector(ctx);
      await inWork(ctx, () => deployToken(scriptEnv(ctx, { SLUICE_APPROVE: "deploy-test-token", SLUICE_KEY: keys.deployer }), say));
      const found = JSON.parse(readFileSync(file, "utf8")) as { token: string; hash: string; block: number };
      ctx.state.data.token = getAddress(found.token);
      for (const tx of hashesIn("token", lines.filter((l) => !/^(pnpm |#)/.test(l)))) addTx(ctx.state, { ...tx, label: "deploy test token" });
      addTx(ctx.state, { step: "token", label: "deploy test token", hash: found.hash, block: found.block });
    }
    // The mint's hash is not printed by the script: read it from the token's Transfer event from the zero address.
    const token = ctx.state.data.token as string;
    const topic = keccak("Transfer(address,address,uint256)");
    const logs = await provider.getLogs({ address: token, topics: [topic, zeroPadValue("0x00", 32)], fromBlock: ctx.state.txs.find((t) => t.label === "deploy test token")?.block ?? 0, toBlock: "latest" });
    for (const l of logs.slice(0, 2)) addTx(ctx.state, { step: "token", label: "mint the deployer's test tokens", hash: l.transactionHash, block: l.blockNumber });
    await requireCode(ctx, token, "the test token");
    return done(`test token ${token}`);
  },

  async "preflight-pre"(ctx) {
    const keys = loadKeys(ctx);
    ctx.out("will run the read-only pre-flight check (nothing is sent)");
    const { lines, say } = collector(ctx);
    const code = await preflight(["--deployer", new Wallet(keys.deployer).address, "--relayer", new Wallet(keys.relayer).address], scriptEnv(ctx, { SLUICE_TOKEN: ctx.state.data.token, SLUICE_MAX_QIE: formatQie(RELAYER_DAILY_BUDGET_WEI) }), { log: say, cwd: ctx.work });
    if (code !== 0) throw exitFailure("the pre-flight check", code, lines);
    return done("GO");
  },

  async "deploy-dry"(ctx) {
    const keys = loadKeys(ctx);
    ctx.out("will show the router deploy without sending it (the node estimates the gas and nothing is broadcast)");
    const { say } = collector(ctx);
    await inWork(ctx, () => deploy(deployEnv(ctx, keys), say, ["--dry-run"]));
    return done("the dry run printed its plan and sent nothing");
  },

  async deploy(ctx) {
    const keys = loadKeys(ctx);
    const provider = await verifiedProvider(ctx);
    const file = join(ctx.work, "deployment.json");
    if (!ctx.state.data.router && existsSync(file)) {
      const found = JSON.parse(readFileSync(file, "utf8")) as { router?: string; chainId?: number };
      if (found.chainId === REHEARSAL_CHAIN_ID && found.router && (await provider.getCode(found.router)) !== "0x") ctx.out(`a router from an earlier run is on the chain: ${found.router}`);
      else rmSync(file, { force: true });
    }
    if (!existsSync(file)) {
      ctx.out("will deploy the router: owner and fee recipient are the deployer, fee 100 bps");
      const { say } = collector(ctx);
      await inWork(ctx, () => deploy(deployEnv(ctx, keys), say, []));
    }
    const found = JSON.parse(readFileSync(file, "utf8")) as { router: string; vault: string; hash: string; block: number };
    Object.assign(ctx.state.data, { router: getAddress(found.router), vault: getAddress(found.vault), deployHash: found.hash.toLowerCase(), deployBlock: found.block });
    addTx(ctx.state, { step: "deploy", label: "deploy router", hash: found.hash, block: found.block });
    await requireCode(ctx, found.router, "the router");
    return done(`router ${found.router} in block ${found.block}`);
  },

  async "record-deploy"(ctx) {
    ctx.out("will record the deploy claim on the testnet; the recorder reads it back from the chain first");
    return recordAll(ctx, [["--claim", "deploy", "--tx", String(ctx.state.data.deployHash), "--network", "testnet"]]);
  },

  async "preflight-post"(ctx) {
    const keys = loadKeys(ctx);
    ctx.out("will run the read-only pre-flight check against the deployment record (nothing is sent)");
    const { lines, say } = collector(ctx);
    const code = await preflight(["--deployer", new Wallet(keys.deployer).address, "--relayer", new Wallet(keys.relayer).address, "--deployment", join(ctx.work, "deployment.json")], scriptEnv(ctx, { SLUICE_TOKEN: ctx.state.data.token, SLUICE_ROUTER: ctx.state.data.router, SLUICE_MAX_QIE: formatQie(RELAYER_DAILY_BUDGET_WEI) }), { log: say, cwd: ctx.work });
    if (code !== 0) throw exitFailure("the pre-flight check", code, lines);
    return done("GO");
  },

  // ------------------------------------------------------------------------------------------------------------------------ 3. smoke run
  async "smoke-dry"(ctx) {
    const keys = loadKeys(ctx);
    ctx.out("will show the smoke run's eight transactions without sending them");
    const { say } = collector(ctx);
    await inWork(ctx, () => smoke(scriptEnv(ctx, { SLUICE_APPROVE: "smoke", SLUICE_KEY: keys.deployer, SLUICE_ROUTER: ctx.state.data.router }), say, ["--dry-run"]));
    return done("the dry run printed its plan and sent nothing");
  },

  async smoke(ctx) {
    const keys = loadKeys(ctx);
    ctx.out("will run the smoke round trip: approve, deposit, two settles, authorise and revoke an agent, withdraw, refund (eight transactions)");
    const { lines, say } = collector(ctx);
    await inWork(ctx, () => smoke(scriptEnv(ctx, { SLUICE_APPROVE: "smoke", SLUICE_KEY: keys.deployer, SLUICE_ROUTER: ctx.state.data.router }), say, []));
    for (const tx of hashesIn("smoke", lines.filter((l) => !/^(pnpm |#)/.test(l)))) addTx(ctx.state, tx);
    ctx.state.data.smokeRecord = lines.filter((l) => l.startsWith("pnpm evidence:record")).map((l) => l.replace(/^pnpm evidence:record\s+/, ""));
    return done(`${lines.filter((l) => /: 0x[0-9a-f]{64} in block/.test(l)).length} transactions`);
  },

  async "record-smoke"(ctx) {
    ctx.out("will record the smoke run's deposit, withdraw and refund claims on the testnet");
    const commands = dataList(ctx, "smokeRecord").map((c) => c.split(/\s+/));
    if (commands.length === 0) throw new Error("the smoke run printed no recorder commands");
    return recordAll(ctx, commands);
  },

  // ------------------------------------------------------------------------------------------------------ 4. local facilitator and tools
  async facilitator(ctx) {
    await ensureFacilitator(ctx, 6_000);
    return done(`running on 127.0.0.1:${ctx.state.data.facilitatorPort}`);
  },

  async "tool-server"(ctx) {
    await ensureToolServer(ctx);
    return done(`running on 127.0.0.1:${ctx.state.data.toolsPort}`);
  },

  // ----------------------------------------------------------------------------------------------------------------------- 5. funded flow
  async "funded-flow"(ctx) {
    const keys = loadKeys(ctx);
    const data = ctx.state.data;
    const provider = await verifiedProvider(ctx);
    const ownerAddr = new Wallet(keys.owner).address;
    const deployerAddr = new Wallet(keys.deployer).address;
    const fac = await ensureFacilitator(ctx, 6_000);
    await ensureToolServer(ctx);
    const env = scriptEnv(ctx, { SLUICE_APPROVE: "owner-setup", SLUICE_KEY: keys.owner, SLUICE_ROUTER: data.router, SLUICE_FACILITATOR_URL: fac.url, SLUICE_MAX_QUSDC: "5" });

    if (!data.ownerMinted) {
      ctx.out(`will mint 1 test token to the throwaway owner ${ownerAddr} (the deployer sends it; the owner holds no QIE)`);
      const hash = await sendCall(ctx, "funded-flow", "mint test tokens to the owner", keys.deployer, data.token as string, ERC20, "mint", [ownerAddr, TOKEN_UNITS]);
      data.ownerMinted = hash;
    }
    if (!data.ownerStarted) {
      const qie = await provider.getBalance(ownerAddr);
      if (qie !== 0n) throw new Error(`the throwaway owner holds ${formatQie(qie)} QIE, so a start from zero QIE cannot be shown`);
      ctx.out("will start the owner from zero QIE: it signs an approval and a deposit of 1 test token, the facilitator tops it up and sends them");
      const { lines, say } = collector(ctx);
      const code = await ownerSetup(["start", "--amount", "1"], env, { log: say });
      if (code !== 0) throw exitFailure("owner-setup start", code, lines);
      const pick = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]).find(Boolean)?.toLowerCase();
      data.ownerTopUp = pick(/top-up from the facilitator: (0x[0-9a-fA-F]{64})/);
      data.ownerApprove = pick(/approval: (0x[0-9a-fA-F]{64})/);
      data.ownerDeposit = pick(/deposit:\s+(0x[0-9a-fA-F]{64})/);
      for (const tx of hashesIn("funded-flow", lines)) addTx(ctx.state, { ...tx, label: `owner start, ${tx.label}` });
      data.ownerStarted = true;
    }
    if (!data.agentAuthorized) {
      ctx.out("will have the owner authorise the agent's session key by signature (budget 0.5, 0.02 a call, 1 day, two tools); the facilitator submits it");
      const { lines, say } = collector(ctx);
      const args = ["authorize", "--agent", String(data.agent), "--budget", "0.5", "--per-call", "0.02", "--days", "1", ...TOOLS.flatMap((t) => ["--tool", `${t.name}=${deployerAddr}`])];
      const code = await ownerSetup(args, env, { log: say });
      if (code !== 0) throw exitFailure("owner-setup authorize", code, lines);
      for (const tx of hashesIn("funded-flow", lines)) addTx(ctx.state, { ...tx, label: "authorise agent (relayed)" });
      const stated = lines.map((l) => /expiry (\d{4}-\d\d-\d\dT[\d:]+Z)/.exec(l)?.[1]).find(Boolean);
      data.agentGrantExpiry = stated ? Math.floor(Date.parse(stated) / 1000) : Math.floor(Date.now() / 1000) + DAY_SECONDS;
      data.agentAuthorized = true;
    }

    const plan: Array<[string, Record<string, string>]> = [
      ["token_risk_check", { address: String(data.token) }],
      ["contract_lookup", { address: String(data.router) }],
      ["token_risk_check", { address: String(data.token) }],
    ];
    const calls = dataList(ctx, "flowCalls");
    for (let i = calls.length; i < plan.length; i++) {
      const [tool, args] = plan[i] as [string, Record<string, string>];
      ctx.out(`paid call ${i + 1} of ${plan.length}: ${tool}, through pnpm client:smoke and the payment proxy`);
      const call = await paidCall(ctx, tool, args);
      if (call.code !== 0 || !call.intent) throw exitFailure(`paid call ${i + 1} (${tool})`, call.code, call.lines);
      calls.push(`${tool}:${call.intent}`);
      data.flowCalls = calls;
      data.intents = [...dataList(ctx, "intents"), call.intent];
    }
    return done(`owner started from zero QIE, agent authorised, ${calls.length} paid calls on ${new Set(calls.map((c) => c.split(":")[0])).size} tools`);
  },

  async settlement(ctx) {
    const ids = dataList(ctx, "flowCalls").map((c) => c.split(":")[1] as string);
    ctx.out(`will wait for the facilitator to settle ${ids.length} intents (it settles every few seconds)`);
    const statuses = await waitSettled(ctx, ids);
    for (const s of statuses) {
      ctx.out(`intent ${s.id}: settled in ${s.transaction} (block ${s.blockNumber})`);
      if (s.transaction) addTx(ctx.state, { step: "settlement", label: "batchSettle by the facilitator", hash: s.transaction, ...(s.blockNumber ? { block: s.blockNumber } : {}) });
    }
    ctx.state.data.flowSettlements = statuses.map((s) => `${s.id}:${s.transaction}`);
    return done(`${statuses.length} intents settled in ${new Set(statuses.map((s) => s.transaction)).size} batch transaction${new Set(statuses.map((s) => s.transaction)).size === 1 ? "" : "s"}`);
  },

  async "record-flow"(ctx) {
    const data = ctx.state.data;
    const calls = dataList(ctx, "flowCalls").map((c) => c.split(":") as [string, string]);
    const settlements = new Map(dataList(ctx, "flowSettlements").map((s) => s.split(":") as [string, string]));
    const commands: string[][] = [];
    const seen = new Set<string>();
    for (const [tool, id] of calls) {
      const tx = settlements.get(id);
      if (!tx || seen.has(`${tx}|${tool}`)) continue;
      seen.add(`${tx}|${tool}`);
      commands.push(["--claim", "paid-call-settlement", "--tx", tx, "--network", "testnet", "--router", String(data.router), "--tool", tool]);
    }
    if (data.ownerDeposit && data.ownerTopUp) {
      commands.push(["--claim", "relayed-start", "--tx", String(data.ownerDeposit), "--topup", String(data.ownerTopUp), "--network", "testnet", "--router", String(data.router)]);
    }
    if (data.ownerDeposit) commands.push(["--claim", "deposit", "--tx", String(data.ownerDeposit), "--network", "testnet", "--router", String(data.router)]);
    ctx.out("will record the paid-call-settlement, relayed-start and deposit claims on the testnet");
    return recordAll(ctx, commands);
  },

  // ---------------------------------------------------------------------------------------------------------------------------- 6. drills
  async "restart-drill"(ctx) {
    const data = ctx.state.data;
    const provider = await verifiedProvider(ctx);
    const notes: string[] = [];
    const say = (line: string) => { notes.push(line); ctx.out(line); };
    say("DRILL: kill the facilitator with an intent queued, restart it, and check on the chain that the intent settles exactly once.");
    // A long flush interval, so that the intent stays queued while the facilitator is running.
    await ensureFacilitator(ctx, 120_000);
    await ensureToolServer(ctx);
    const call = await paidCall(ctx, "contract_lookup", { address: String(data.router) });
    if (call.code !== 0 || !call.intent) throw exitFailure("the drill's paid call", call.code, call.lines);
    data.intents = [...dataList(ctx, "intents"), call.intent];
    const queued = await statusOf(ctx, call.intent);
    say(`before the kill: intent ${call.intent} is ${queued.status}`);
    if (queued.status !== "queued") throw new Error(`the intent was ${queued.status}, not queued, so the drill would show nothing`);
    const fac = ctx.fac as Service;
    const pid = fac.child.pid;
    await stopService(fac); // an abrupt kill: nothing is flushed and nothing is told
    say(`killed the facilitator process (pid ${String(pid)}) with the intent still queued`);
    let reachable = true;
    try {
      await getJson(`${fac.url}/health`, 2_000);
    } catch {
      reachable = false;
    }
    if (reachable) throw new Error("the facilitator still answers after the kill");
    say("the facilitator no longer answers");
    const restarted = await ensureFacilitator(ctx, 5_000);
    say(`restarted the facilitator on the same queue file (${restarted.url})`);
    const after = await statusOf(ctx, call.intent);
    say(`after the restart: intent ${call.intent} is ${after.status}`);
    const [settled] = await waitSettled(ctx, [call.intent]);
    if (!settled?.transaction) throw new Error("the intent settled without a transaction hash");
    say(`settled in ${settled.transaction} (block ${settled.blockNumber})`);
    addTx(ctx.state, { step: "restart-drill", label: "batchSettle after the restart", hash: settled.transaction, ...(settled.blockNumber ? { block: settled.blockNumber } : {}) });
    // On the chain: the owner's Settled events, one for each intent this run has made, each with a nonce of its own.
    const all = dataList(ctx, "intents");
    await waitSettled(ctx, all);
    const events = await ownerSettled(ctx, provider);
    say(`the router shows ${events.length} Settled events for the owner since it was deployed; the run has made ${all.length} intents`);
    if (events.length !== all.length) throw new Error(`${events.length} Settled events on the chain for ${all.length} intents`);
    if (new Set(events.map((e) => e.nonce)).size !== events.length) throw new Error("two Settled events share a nonce");
    say("each intent settled exactly once: the counts match and no nonce repeats.");
    ctx.state.drills["restart-drill"] = notes;
    return done(`killed with the intent queued; after the restart it settled once, in ${settled.transaction}`);
  },

  async "killswitch-drill"(ctx) {
    const data = ctx.state.data;
    const keys = loadKeys(ctx);
    const provider = await verifiedProvider(ctx);
    const notes: string[] = [];
    const say = (line: string) => { notes.push(line); ctx.out(line); };
    say("DRILL: turn the kill switch on, see that /verify refuses and no top-up is sent, turn it off and see the service work again.");
    const fac = await ensureFacilitator(ctx, 6_000);
    await ensureToolServer(ctx);
    const killFile = join(ctx.dir, "facilitator", "KILL");
    const relayerAddr = new Wallet(keys.relayer).address;
    const nonceBefore = await provider.getTransactionCount(relayerAddr);
    writeFileSync(killFile, "");
    try {
      const on = await getJson(`${fac.url}/health`);
      say(`kill file created: /health says killSwitch ${String(on.body.killSwitch)}`);
      if (on.body.killSwitch !== true) throw new Error("the kill switch did not turn on");

      const refused = await paidCall(ctx, "token_risk_check", { address: String(data.token) });
      const reason = refused.lines.filter((l) => /did not go through|stopped|refus/i.test(l)).join(" | ");
      say(`a paid call while it is on: exit code ${refused.code}; ${short(reason || refused.lines.slice(-2).join(" | "), 300)}`);
      if (refused.code === 0) throw new Error("a paid call went through with the kill switch on");
      if (refused.intent) throw new Error("an intent was queued with the kill switch on");

      const stranger = new Wallet(Wallet.createRandom().privateKey);
      const gasPrice = ((await provider.getFeeData()).gasPrice ?? 0n) * 11n / 10n;
      const txs = await signOnboarding(stranger, { router: String(data.router), asset: String(data.token), amount: TOKEN_UNITS, nonce: 0, gasPrice, chainId: REHEARSAL_CHAIN_ID });
      const out = await new FacilitatorClient({ url: fac.url }).onboard({ payer: stranger.address, approveTx: txs.approveTx, depositTx: txs.depositTx });
      say(`a zero-QIE start for a new wallet while it is on: ok ${String(out.ok)}, ${out.error ?? ""}${out.detail ? ` (${out.detail})` : ""}`);
      if (out.ok) throw new Error("the facilitator started a wallet with the kill switch on");
      await sleep(4_000);
      const strangerQie = await provider.getBalance(stranger.address);
      const nonceAfter = await provider.getTransactionCount(relayerAddr);
      say(`on the chain: the new wallet holds ${formatQie(strangerQie)} QIE, and the relayer's transaction count went from ${nonceBefore} to ${nonceAfter}`);
      if (strangerQie !== 0n || nonceAfter !== nonceBefore) throw new Error("something was sent while the kill switch was on");
    } finally {
      rmSync(killFile, { force: true });
    }
    const off = await getJson(`${fac.url}/health`);
    say(`kill file removed: /health says killSwitch ${String(off.body.killSwitch)}`);
    if (off.body.killSwitch !== false) throw new Error("the kill switch did not turn off");
    const again = await paidCall(ctx, "contract_lookup", { address: String(data.token) });
    say(`a paid call after it is off: exit code ${again.code}${again.intent ? `, intent ${again.intent}` : ""}`);
    if (again.code !== 0 || !again.intent) throw exitFailure("the paid call after the kill switch was turned off", again.code, again.lines);
    data.intents = [...dataList(ctx, "intents"), again.intent];
    const [settled] = await waitSettled(ctx, [again.intent]);
    if (settled?.transaction) addTx(ctx.state, { step: "killswitch-drill", label: "batchSettle after the kill switch was turned off", hash: settled.transaction, ...(settled.blockNumber ? { block: settled.blockNumber } : {}) });
    say(`that intent settled in ${settled?.transaction}`);
    ctx.state.drills["killswitch-drill"] = notes;
    return done("on: /verify refused and nothing was sent; off: a paid call settled");
  },

  // ------------------------------------------------------------------------------------------------------------ 9. the builder withdraws
  async withdraw(ctx) {
    const keys = loadKeys(ctx);
    const data = ctx.state.data;
    const provider = await verifiedProvider(ctx);
    await waitSettled(ctx, dataList(ctx, "intents"));
    const builder = new Wallet(keys.deployer).address;
    const router = new Contract(String(data.router), ROUTER_ABI, provider);
    const earned = (await router.getFunction("earnings")(builder)) as bigint;
    ctx.out(`the builder ${builder} is owed ${earned} units (${Number(earned) / 1e6} test tokens) in the router`);
    if (earned === 0n) throw new Error("the builder is owed nothing, so there is nothing to withdraw");
    ctx.out("will withdraw all of it to the builder's own address");
    const hash = await sendCall(ctx, "withdraw", "withdraw the builder's earnings", keys.deployer, String(data.router), ROUTER_ABI, "withdraw", [earned, builder]);
    data.withdrawHash = hash;
    const left = (await router.getFunction("earnings")(builder)) as bigint;
    ctx.out(`owed after the withdraw: ${left} units`);
    return done(`${Number(earned) / 1e6} test tokens withdrawn in ${hash}`);
  },

  async "record-withdraw"(ctx) {
    ctx.out("will record the withdraw claim on the testnet");
    return recordAll(ctx, [["--claim", "withdraw", "--tx", String(ctx.state.data.withdrawHash), "--network", "testnet", "--router", String(ctx.state.data.router)]]);
  },

  // ----------------------------------------------------------------------------------------------------------------------- 7. the evidence
  async evidence(ctx) {
    ctx.out("will run pnpm evidence:check and pnpm evidence:summary, and keep what they print");
    const check = collector(ctx);
    const ev = ctx.io.evidence ?? {};
    const evidenceText = ev.text ?? (ev.file ? readFileSync(ev.file, "utf8") : undefined);
    const checkCode = await evidenceCheck([], {}, check.say, ev.file, ev.deps);
    ctx.state.drills["evidence:check"] = check.lines;
    const summary = collector(ctx);
    const summaryCode = await evidenceSummary({}, summary.say, undefined, undefined, evidenceText);
    ctx.state.drills["evidence:summary"] = summary.lines;
    const chain = collector(ctx);
    const chainCode = ctx.state.data.router
      ? await evidenceSummary({ SLUICE_NETWORK: "testnet", SLUICE_ROUTER: ctx.state.data.router, SLUICE_FROM_BLOCK: String(ctx.state.data.deployBlock ?? 0), ...(ctx.env.SLUICE_RPC_URL ? { EVIDENCE_RPC_URL: ctx.env.SLUICE_RPC_URL } : {}) }, chain.say, ev.summaryRpc, undefined, evidenceText)
      : 0;
    ctx.state.drills["evidence:summary (testnet router scan)"] = chain.lines;
    if (checkCode !== 0) throw exitFailure("evidence:check", checkCode, check.lines);
    if (summaryCode !== 0) throw exitFailure("evidence:summary", summaryCode, summary.lines);
    if (chainCode !== 0) throw exitFailure("evidence:summary on the testnet router", chainCode, chain.lines);
    return done("evidence:check passed every row; the summary ran");
  },

  // ---------------------------------------------------------------------------------------------------------------- 8. source verification
  async "verify-source"(ctx) {
    // The explorer is the one QIE's documentation gives for the testnet (unless SLUICE_EXPLORER_URL names another). That its verification
    // endpoint works is not confirmed: the script asks, and says what the explorer answered.
    const explorer = ctx.env.SLUICE_EXPLORER_URL?.trim() || TESTNET_EXPLORER;
    const file = join(ctx.work, "deployment.json");
    const { lines, say } = collector(ctx);
    ctx.out(`will ask ${explorer} (the testnet explorer in QIE's documentation; its verification endpoint is unconfirmed) whether it shows verified source for the router, and submit the router's source if it does not (nothing is submitted for the vault, which the router's constructor creates). The files for the manual route are written first`);
    const code = await verify(["--explorer", explorer, "--deployment", file], scriptEnv(ctx, { SLUICE_APPROVE: "verify" }), { log: say, ...ctx.io.verify });
    ctx.state.drills["verify-source"] = lines;
    if (code !== 0) {
      ctx.out("the explorer does not show verified source for the router, so no verify-link row is written. The manual route's files are in artifacts/verification/ (see docs/MAINNET-RUNBOOK.md)");
      throw exitFailure("live:verify", code, lines);
    }
    ctx.out("will record the verify-link claim on the testnet");
    await recordAll(ctx, [["--claim", "verify-link", "--tx", String(ctx.state.data.deployHash), "--network", "testnet", "--explorer", explorer]]);
    return done(`the explorer at ${explorer} shows verified source for the router`);
  },
};

function deployEnv(ctx: Ctx, keys: Keys): Env {
  const deployer = new Wallet(keys.deployer).address;
  return scriptEnv(ctx, { SLUICE_APPROVE: "deploy", SLUICE_KEY: keys.deployer, SLUICE_TOKEN: ctx.state.data.token, SLUICE_OWNER: deployer, SLUICE_FEE_RECIPIENT: deployer, SLUICE_FEE_BPS: "100" });
}

/** Runs the recorder for each command. Every command is tried; the step fails if any was refused. */
async function recordAll(ctx: Ctx, commands: string[][]): Promise<StepOutcome> {
  let failed = 0;
  let recorded = 0;
  for (const args of commands) {
    const { lines, say } = collector(ctx);
    ctx.out(`pnpm evidence:record ${args.join(" ")}`);
    const code = await record(args, {}, { log: say, ...ctx.io.record });
    if (code === 0) recorded += 1;
    else {
      failed += 1;
      ctx.out(`  the recorder exited ${code}: ${lines.slice(-2).join(" | ")}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${commands.length} recorder commands were refused or could not read the chain; ${recorded} were recorded`);
  return done(`${recorded} claim${recorded === 1 ? "" : "s"} recorded`);
}

/** Every Settled event the router has emitted for the owner, with the nonce of each. */
async function ownerSettled(ctx: Ctx, provider: FailoverJsonRpcProvider): Promise<Array<{ hash: string; nonce: string }>> {
  const topic = SETTLED.getEvent("Settled")?.topicHash as string;
  const logs = await provider.getLogs({ address: String(ctx.state.data.router), topics: [topic, zeroPadValue(String(ctx.state.data.owner), 32)], fromBlock: Number(ctx.state.data.deployBlock ?? 0), toBlock: "latest" });
  return logs.map((l) => ({ hash: l.transactionHash, nonce: String(SETTLED.parseLog({ topics: [...l.topics], data: l.data })?.args.nonce) }));
}

// ---------------------------------------------------------------------------------------------------------------------------------- the run

function readOrNewState(path: string): RehearsalState {
  if (!existsSync(path)) return newState(new Date().toISOString());
  return parseState(readFileSync(path, "utf8"));
}

function printSummary(ctx: Ctx, result: Awaited<ReturnType<typeof runRehearsal>>): void {
  const out = ctx.out;
  out("");
  out("where the run stands:");
  for (const line of statusLines(ctx.state)) out(line);
  const txs = ctx.state.txs;
  if (txs.length > 0) {
    out("");
    out("transactions this run sent or caused (hash, block, gas used, QIE paid by the sender):");
    let total = 0n;
    for (const t of txs) {
      const cost = t.costWei ? BigInt(t.costWei) : undefined;
      if (cost) total += cost;
      const measured = measuredFor(t.label);
      const vs = measured && t.gasUsed ? ` (docs/GAS.md: ${measured.gas}, ${measured.basis})` : "";
      out(`  ${t.label}: ${t.hash} block ${t.block ?? "?"} gas ${t.gasUsed ?? "?"}${cost ? ` cost ${formatQie(cost)} QIE` : ""}${vs}`);
    }
    out(`  total paid in gas by the senders: ${formatQie(total)} QIE`);
  }
  out("");
  if (result.stopped) out(`stopped at the ${result.stopped} step; fix what it says and run pnpm rehearsal:testnet again to carry on.`);
  else if (result.aborted) out(`aborted at the ${result.aborted} step by a refusal; nothing after it ran.`);
  else if (result.failed.length > 0 || result.blocked.length > 0) out(`not finished: failed ${result.failed.join(", ") || "none"}; blocked ${result.blocked.join(", ") || "none"}. Run pnpm rehearsal:testnet again to retry them.`);
  else out("every step is done.");
}

export async function main(argv: string[], env: Env = process.env, io: RehearsalIo = {}): Promise<number> {
  const root = resolve(io.root ?? ROOT);
  const dir = join(root, ".rehearsal");
  const statePath = join(root, "rehearsal-state.json");
  const secrets: string[] = [];
  const logPath = join(dir, "rehearsal.log");
  const base = io.log ?? ((line: string) => console.log(line));
  const out = (line: string): void => {
    const safe = cutSecrets(line, secrets);
    base(safe);
    try {
      appendFileSync(logPath, `${safe}\n`);
    } catch {
      // the log is a convenience
    }
  };
  try {
    const { status } = refuseUnsafeSettings(env, argv);
    const state = readOrNewState(statePath);
    if (status) {
      for (const line of statusLines(state)) out(line);
      return 0;
    }
    mkdirSync(join(dir, "work"), { recursive: true });
    const ctx: Ctx = { root, dir, work: join(dir, "work"), statePath, state, env, out, secrets, io };
    const save = (): void => {
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, serializeState(state, ctx.secrets));
      renameSync(tmp, statePath);
    };
    out(`pnpm rehearsal:testnet: ${new Date().toISOString()}. Testnet (chain 1983) only; no mainnet call is made, no faucet is called, no key is printed.`);
    const result = await runRehearsal(STEPS as readonly StepDef[], {
      state,
      save,
      log: out,
      redact: (t) => cutSecrets(t, ctx.secrets),
      run: async (step) => {
        const outcome = await stepFns[step.id](ctx);
        await enrichTxs(ctx);
        return outcome;
      },
    });
    try {
      await enrichTxs(ctx);
      save();
    } finally {
      await stopService(ctx.tools);
      await stopService(ctx.fac);
    }
    printSummary(ctx, result);
    if (result.stopped) return 2;
    return result.failed.length > 0 || result.blocked.length > 0 || result.aborted ? 1 : 0;
  } catch (err) {
    if (err instanceof RehearsalRefused || err instanceof StateError) {
      out(cutSecrets(err.message, secrets));
      return 1;
    }
    out("the rehearsal could not run, and it sent nothing it had not recorded.");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error("rehearsal:testnet failed");
      process.exit(1);
    },
  );
}
