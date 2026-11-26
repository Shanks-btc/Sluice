// The evidence recorder: the only thing that writes a row into docs/EVIDENCE.md.
//
// A row is a claim that a transaction on QIE shows something. The recorder takes a transaction hash and the kind of claim, reads the
// transaction back from the chain with read-only RPC methods, checks that it succeeded and that what it did is what the claim says,
// and only then renders a row. If anything differs it refuses, says why, and writes nothing. Nothing in this file can send a
// transaction or sign anything, and it never reads a key.
//
// The claims it knows, and what each one checks (everything from the chain, by RPC):
//   deploy                the transaction created a contract; its code is the compiled PaymentRouter's (same length and same metadata
//                         hash); it answers like a Sluice router on this chain; and the vault it created has code and names it as
//                         its router. The vault is created by the router's constructor, so it has no deployment of its own: its code
//                         is compared with the compiled AgentVault by pnpm live:vaultcheck, which is a command to run and not a claim
//                         this recorder writes
//   verify-link           the explorer shows verified source for the deployment's contract, which is the router. It says nothing about
//                         the vault. The only claim that asks the explorer, because "verified" is something only the explorer says
//   deposit               a router Deposited event in a successful transaction
//   withdraw              a router Withdrawn event in a successful transaction
//   settle-batch          the transaction is a call to the router's batchSettle, and the router emitted Settled for the intents it paid
//   paid-call-settlement  a router Settled event for an intent that someone other than its payer, its payee and its signer submitted
//                         (what a facilitator does). It can show that a signed payment was settled for a tool id. It cannot show that an
//                         MCP tool call took place, and the row does not say it did
//   relayed-start         a deposit whose payer signed it themselves, after a plain QIE top-up from another address, at a time when
//                         the payer's QIE balance was zero. The top-up's hash is part of the claim
//   refund                a router Refunded event in a successful transaction: a payer's unspent prepaid balance left the router, by the
//                         payer's own transaction or by a signed request that a relayer sent. It is not a payment to anyone's earnings
//
// "mainnet" and "testnet" rows go into docs/EVIDENCE.md, each under its own heading, each with the network written in the row. A row
// from a local fork is labelled "fork" and is never written to that file.
import { Interface, TypedDataEncoder, getAddress, id } from "ethers";
import { EVENTS } from "./events";
import { EVIDENCE_COLUMNS, EVIDENCE_COLUMNS_EXTENDED, NETWORKS, NetworkError, checkRow, hashFromCell, parseEvidenceStrict } from "./evidence";
import type { EvidenceRow, Network, Rpc, RowResult } from "./evidence";
import { QUSDC_ADDRESS } from "./guard";
import { RpcRefused, readOnlyRpc } from "./readrpc";
import { loadArtifact } from "./live";
import { formatQusdc } from "./units";

export const CLAIM_TYPES = ["deploy", "verify-link", "settle-batch", "deposit", "relayed-start", "paid-call-settlement", "withdraw", "refund"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** The Event column for each claim. Deployed and SourceVerified are not contract events: they are what the row says happened. */
export const CLAIM_EVENT: Readonly<Record<ClaimType, string>> = {
  deploy: "Deployed",
  "verify-link": "SourceVerified",
  "settle-batch": "Settled",
  deposit: "Deposited",
  "relayed-start": "Deposited",
  "paid-call-settlement": "Settled",
  withdraw: "Withdrawn",
  refund: "Refunded",
};

export type RecordNetwork = Network | "fork";

const CHAIN_ID: Readonly<Record<RecordNetwork, number>> = { mainnet: 1990, testnet: 1983, fork: 1990 };
const EXPLORER: Readonly<Partial<Record<RecordNetwork, string>>> = { mainnet: "https://mainnet.qie.digital" };

/** The most QIE a top-up in a zero-QIE start may be: the facilitator's hard ceiling (packages/facilitator/src/caps.ts), tested to be equal. */
export const RELAYED_START_MAX_TOPUP_WEI = 1_500_000_000_000_000n;

/** A claim the recorder refused, with a reason fit to print. */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

export type RecordedRow = {
  network: RecordNetwork;
  date: string;
  event: string;
  hash: string;
  block: string;
  contract: string;
  amount: string;
  who: string;
  /** The claim cell: the type, and the part of the claim that is not in the transaction itself. */
  claim: string;
  recheck: string;
};

export type ClaimInput = {
  claim: ClaimType;
  network: RecordNetwork;
  /** The transaction: the deployment for `deploy` and `verify-link`, the deposit for `relayed-start`, otherwise the transaction itself. */
  hash: string;
  /** The router, for every claim except deploy and verify-link, where it is the contract the transaction created. */
  router?: string;
  /** relayed-start: the transaction in which the facilitator sent QIE to the payer. */
  topup?: string;
  /** paid-call-settlement: the tool the payment is for, by name. Optional; when given the event's toolId must be its keccak256. */
  tool?: string;
};

export type ClaimDeps = {
  rpc: Rpc;
  /** Asks the explorer whether an address has verified source. Only verify-link calls it. */
  explorerVerified?: (address: string) => Promise<boolean>;
  /** The runtime code the compiled PaymentRouter should have. Only deploy needs it; by default it is read from artifacts/. */
  compiledRouterCode?: () => string | undefined;
};

export type Recorded = { rows: RecordedRow[]; notes: string[] };

// ---------------------------------------------------------------------------------------------------------------------- RPC

/** Every method the recorder may call. Nothing here can send, sign or change anything. */
export const RECORDER_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getBalance",
  "eth_call",
]);

/** A read-only JSON-RPC client over several endpoints, limited to the methods the recorder needs. See readOnlyRpc. */
export function recorderRpc(urls: readonly string[], fetchImpl: typeof fetch = fetch): Rpc {
  return readOnlyRpc(urls, RECORDER_READ_ONLY_METHODS, fetchImpl);
}

export { RpcRefused };

/** The public RPC endpoints for a network: rpc1 to rpc5. */
export function publicRpcUrls(network: Network): string[] {
  return [1, 2, 3, 4, 5].map((n) => `https://rpc${n}${network}.qie.digital/`);
}

// ----------------------------------------------------------------------------------------------------------------- the chain

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type RpcLog = { address: string; topics: string[]; data: string };
type RpcReceipt = { status: string; blockNumber: string; transactionHash?: string; contractAddress?: string | null; logs: RpcLog[] };
type RpcTx = { hash: string; from: string; to: string | null; value: string; input: string; blockNumber: string | null };

const routerViews = new Interface([
  "function domainSeparator() view returns (bytes32)",
  "function token() view returns (address)",
  "function vault() view returns (address)",
]);
const batchInterface = new Interface([
  "function batchSettle((address payer, address payee, uint256 amount, bytes32 toolId, bytes32 nonce, uint256 deadline)[] intents, bytes[] signatures) returns (uint256 settled)",
]);
const SKIPPED = "event SettleSkipped(uint256 indexed index, address indexed payer, bytes32 nonce, bytes4 reason)";

const isoFromSeconds = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new RecordError(what);
  return value;
}

type Loaded = { receipt: RpcReceipt; tx: RpcTx; block: bigint; date: string; hash: string };

/** The transaction, its receipt and its block, on the right chain, and successful. Anything else is refused. */
async function load(rpc: Rpc, network: RecordNetwork, hash: string): Promise<Loaded> {
  if (!HASH.test(hash)) throw new RecordError("the transaction hash must be 0x followed by 64 hex characters");
  const chain = await rpc("eth_chainId", []);
  if (typeof chain !== "string" || BigInt(chain) !== BigInt(CHAIN_ID[network])) {
    throw new RecordError(`wrong network: ${network} is chain ${CHAIN_ID[network]}, but the RPC says ${String(chain)}`);
  }
  const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as RpcReceipt | null;
  if (!receipt) throw new RecordError("the transaction was not found on this network");
  if (receipt.status !== "0x1") throw new RecordError("the transaction failed (its status is not 0x1), so it proves nothing");
  const tx = must((await rpc("eth_getTransactionByHash", [hash])) as RpcTx | null, "the transaction was not found on this network");
  const blockNumber = BigInt(receipt.blockNumber);
  const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp: string } | null;
  if (!block) throw new RecordError("the block was not found");
  return { receipt, tx, block: blockNumber, date: isoFromSeconds(BigInt(block.timestamp)), hash: hash.toLowerCase() };
}

/** True when the address answers like a Sluice router on this chain: its domain separator is the one for its own address and chain. */
async function ensureRouter(rpc: Rpc, router: string, network: RecordNetwork): Promise<void> {
  if (!ADDRESS.test(router)) throw new RecordError("the router must be an address");
  const address = getAddress(router);
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || code === "0x") throw new RecordError("there is no contract at the router address on this network");
  const call = async (name: "domainSeparator" | "token") => {
    try {
      return (await rpc("eth_call", [{ to: address, data: routerViews.encodeFunctionData(name) }, "latest"])) as string;
    } catch (err) {
      if (err instanceof RpcRefused) throw new RecordError("the address does not answer like a Sluice router");
      throw err;
    }
  };
  const separator = routerViews.decodeFunctionResult("domainSeparator", await call("domainSeparator"))[0] as string;
  const expected = TypedDataEncoder.hashDomain({ name: "SluiceRouter", version: "1", chainId: CHAIN_ID[network], verifyingContract: address });
  if (separator !== expected) throw new RecordError("the address does not answer like a Sluice router on this chain");
  if (network === "mainnet") {
    const token = getAddress(routerViews.decodeFunctionResult("token", await call("token"))[0] as string);
    if (token !== getAddress(QUSDC_ADDRESS)) throw new RecordError("on mainnet the router must hold QUSDC, and this one holds another token");
  }
}

const vaultViews = new Interface(["function router() view returns (address)"]);

/**
 * The router's vault is a contract, and it names this router as its router. The router's constructor creates the vault, and the router
 * checks nothing about it afterwards, so a deployment claim looks. Returns the vault's address.
 */
async function ensureVault(rpc: Rpc, router: string): Promise<string> {
  const view = async (to: string, data: string): Promise<string> => {
    try {
      return (await rpc("eth_call", [{ to, data }, "latest"])) as string;
    } catch (err) {
      if (err instanceof RpcRefused) throw new RecordError("the router's vault could not be read");
      throw err;
    }
  };
  let vault: string;
  try {
    vault = getAddress(String(routerViews.decodeFunctionResult("vault", await view(router, routerViews.encodeFunctionData("vault")))[0]));
  } catch (err) {
    if (err instanceof RecordError) throw err;
    throw new RecordError("the router does not name a vault");
  }
  const code = await rpc("eth_getCode", [vault, "latest"]);
  if (typeof code !== "string" || code === "0x") throw new RecordError("there is no code at the router's vault address");
  let back: string;
  try {
    back = getAddress(String(vaultViews.decodeFunctionResult("router", await view(vault, vaultViews.encodeFunctionData("router")))[0]));
  } catch (err) {
    if (err instanceof RecordError) throw err;
    throw new RecordError("the router's vault does not name a router");
  }
  if (back !== getAddress(router)) throw new RecordError("the router's vault names another router");
  return vault;
}

const eventInterface = (name: string) => new Interface([EVENTS[name]?.fragment as string]);

/** The router's events of one kind in a receipt, decoded. */
function routerEvents(receipt: RpcReceipt, router: string, name: string) {
  const iface = eventInterface(name);
  const topic = iface.getEvent(name)?.topicHash;
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== router.toLowerCase() || log.topics[0] !== topic) continue;
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    if (parsed) out.push(parsed);
  }
  return out;
}

const command = (hash: string) => `pnpm evidence:check --hash ${hash}`;

function make(input: ClaimInput, loaded: Loaded, extra: Pick<RecordedRow, "contract" | "amount" | "who"> & { event?: string; claim?: string }): RecordedRow {
  return {
    network: input.network,
    date: loaded.date,
    event: extra.event ?? CLAIM_EVENT[input.claim],
    hash: loaded.hash,
    block: loaded.block.toString(),
    contract: extra.contract,
    amount: extra.amount,
    who: extra.who,
    claim: extra.claim ?? input.claim,
    recheck: command(loaded.hash),
  };
}

const requireRouter = (input: ClaimInput): string => {
  if (!input.router || !ADDRESS.test(input.router)) throw new RecordError(`the ${input.claim} claim needs the router's address (--router)`);
  return getAddress(input.router);
};

/** The metadata at the end of Solidity's output: a hash of the source and settings, which the same build always has. */
const METADATA_TAIL = 106; // hex characters: 53 bytes

/** The deployed code is the compiled router's: the same length, and the same metadata hash, which immutables do not change. */
export function sameCompiledCode(deployed: string, compiled: string): boolean {
  const a = deployed.toLowerCase();
  const b = compiled.toLowerCase();
  return a.length === b.length && a.length > METADATA_TAIL + 2 && a.slice(-METADATA_TAIL) === b.slice(-METADATA_TAIL);
}

function defaultCompiledCode(): string | undefined {
  try {
    return loadArtifact("PaymentRouter").deployedBytecode;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------------------ the claims

async function recordDeploy(input: ClaimInput, deps: ClaimDeps, verifyOnly: false | "verify-link"): Promise<Recorded> {
  const loaded = await load(deps.rpc, input.network, input.hash);
  if (loaded.tx.to !== null) throw new RecordError("this transaction did not create a contract: it was sent to an address");
  const created = loaded.receipt.contractAddress;
  if (!created) throw new RecordError("this transaction created no contract");
  const address = getAddress(created);
  const code = await deps.rpc("eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || code === "0x") throw new RecordError("there is no code at the address the transaction created");
  await ensureRouter(deps.rpc, address, input.network);
  const notes: string[] = [];
  if (verifyOnly === false) {
    const compiled = (deps.compiledRouterCode ?? defaultCompiledCode)();
    if (!compiled) throw new RecordError("the compiled router was not found: run pnpm compile, so the deployed code can be compared with it");
    if (!sameCompiledCode(code, compiled)) throw new RecordError("the code at the address is not the compiled PaymentRouter's (different length or metadata hash)");
    notes.push("the deployed code has the compiled router's length and metadata hash");
    const vault = await ensureVault(deps.rpc, address);
    notes.push(
      `the router's vault ${vault} has code and names this router as its router. The router's constructor created it, so it has no deployment of its own; compare its code with the compiled AgentVault by running pnpm live:vaultcheck`,
    );
    return { rows: [make(input, loaded, { contract: address, amount: "—", who: getAddress(loaded.tx.from) })], notes };
  }
  if (!deps.explorerVerified) throw new RecordError("the explorer could not be asked");
  if (!(await deps.explorerVerified(address))) throw new RecordError("the explorer does not show verified source for this contract (the router)");
  notes.push("the explorer shows verified source for the router, which is the contract this deployment created. That says nothing about the vault: this claim does not ask the explorer about it");
  return { rows: [make(input, loaded, { contract: address, amount: "—", who: getAddress(loaded.tx.from) })], notes };
}

async function recordEvents(input: ClaimInput, deps: ClaimDeps, eventName: string): Promise<Recorded> {
  const router = requireRouter(input);
  const loaded = await load(deps.rpc, input.network, input.hash);
  await ensureRouter(deps.rpc, router, input.network);
  const spec = EVENTS[eventName] as (typeof EVENTS)[string];
  const found = routerEvents(loaded.receipt, router, eventName);
  if (found.length === 0) throw new RecordError(`the transaction has no ${eventName} event from the router ${router}`);
  const notes: string[] = [];
  let events = found;

  if (input.claim === "settle-batch") {
    if (!loaded.tx.to || getAddress(loaded.tx.to) !== router) throw new RecordError("a settle-batch claim needs a transaction sent to the router itself");
    let intents: number;
    try {
      intents = (batchInterface.decodeFunctionData("batchSettle", loaded.tx.input)[0] as unknown[]).length;
    } catch {
      throw new RecordError("the transaction is not a call to the router's batchSettle");
    }
    const skipped = loaded.receipt.logs.filter((l) => l.address.toLowerCase() === router.toLowerCase() && l.topics[0] === new Interface([SKIPPED]).getEvent("SettleSkipped")?.topicHash).length;
    if (found.length + skipped !== intents) throw new RecordError(`the batch held ${intents} intents but the router reported ${found.length} settled and ${skipped} skipped`);
    notes.push(`a batch of ${intents}: ${found.length} settled, ${skipped} skipped by the router`);
  }

  if (input.claim === "paid-call-settlement") {
    const sender = getAddress(loaded.tx.from);
    events = found.filter((e) => {
      const outsider = ![e.args.payer, e.args.payee, e.args.signer].some((a) => getAddress(String(a)) === sender);
      const toolOk = !input.tool || String(e.args.toolId) === id(input.tool);
      return outsider && toolOk && getAddress(String(e.args.payer)) !== getAddress(String(e.args.payee));
    });
    if (events.length === 0) {
      throw new RecordError(
        input.tool
          ? `no Settled event in the transaction was submitted by a third party for the tool "${input.tool}"`
          : "no Settled event in the transaction was submitted by someone other than its payer, payee and signer",
      );
    }
    notes.push("a signed payment was settled by a third party; this shows the payment, not that a tool call took place");
  }

  if (input.claim === "relayed-start") {
    const topup = await relayedStartCheck(input, deps, loaded, found);
    notes.push(...topup);
  }

  const claim = input.claim === "relayed-start" ? `relayed-start (top-up ${input.topup?.toLowerCase()})` : input.claim === "paid-call-settlement" && input.tool ? `paid-call-settlement (tool ${input.tool})` : input.claim;
  const rows = events.map((e) =>
    make(input, loaded, {
      contract: router,
      amount: spec.amountField ? formatQusdc(BigInt(e.args[spec.amountField])) : "—",
      who: getAddress(String(e.args[spec.whoField])),
      claim,
    }),
  );
  return { rows, notes };
}

/** What makes a deposit a zero-QIE start: the payer signed it, after a small top-up from someone else, when they held no QIE. */
async function relayedStartCheck(input: ClaimInput, deps: ClaimDeps, deposit: Loaded, events: ReturnType<typeof routerEvents>): Promise<string[]> {
  if (!input.topup || !HASH.test(input.topup)) throw new RecordError("a relayed-start claim needs the top-up's transaction hash (--topup)");
  if (events.length !== 1) throw new RecordError("a relayed-start claim needs a transaction with exactly one deposit");
  const payer = getAddress(String(events[0]?.args.account));
  if (getAddress(deposit.tx.from) !== payer) throw new RecordError("the payer did not send the deposit themselves: its sender is another address");
  const top = await load(deps.rpc, input.network, input.topup);
  if (!top.tx.to || getAddress(top.tx.to) !== payer) throw new RecordError("the top-up was not sent to the payer");
  if (getAddress(top.tx.from) === payer) throw new RecordError("the top-up came from the payer's own address");
  if (top.tx.input !== "0x") throw new RecordError("the top-up is not a plain QIE transfer: it carries call data");
  const value = BigInt(top.tx.value);
  if (value <= 0n) throw new RecordError("the top-up sent no QIE");
  if (value > RELAYED_START_MAX_TOPUP_WEI) throw new RecordError(`the top-up is above ${RELAYED_START_MAX_TOPUP_WEI} wei, more than a zero-QIE start sends`);
  if (top.block > deposit.block) throw new RecordError("the top-up came after the deposit");
  const before = `0x${(top.block - 1n).toString(16)}`;
  let balance: unknown;
  try {
    balance = await deps.rpc("eth_getBalance", [payer, before]);
  } catch (err) {
    if (err instanceof RpcRefused) throw new RecordError("the node could not give the payer's QIE balance before the top-up (it may not keep old state), so a zero-QIE start cannot be shown");
    throw err;
  }
  if (typeof balance !== "string" || BigInt(balance) !== 0n) throw new RecordError("the payer held QIE before the top-up, so this was not a start from zero QIE");
  return [`QIE balance of the payer before the top-up: 0; top-up ${value} wei from ${getAddress(top.tx.from)}; the payer then signed the deposit`];
}

/** Verifies a claim against the chain and returns the rows it supports. Throws RecordError for a claim that does not hold. */
export async function verifyClaim(input: ClaimInput, deps: ClaimDeps): Promise<Recorded> {
  if (!(CLAIM_TYPES as readonly string[]).includes(input.claim)) throw new RecordError(`the claim type must be one of ${CLAIM_TYPES.join(", ")}`);
  if (!(input.network in CHAIN_ID)) throw new RecordError("the network must be mainnet, testnet or fork");
  switch (input.claim) {
    case "deploy":
      return recordDeploy(input, deps, false);
    case "verify-link":
      return recordDeploy(input, deps, "verify-link");
    case "deposit":
    case "relayed-start":
      return recordEvents(input, deps, "Deposited");
    case "withdraw":
      return recordEvents(input, deps, "Withdrawn");
    case "refund":
      return recordEvents(input, deps, "Refunded");
    case "settle-batch":
    case "paid-call-settlement":
      return recordEvents(input, deps, "Settled");
  }
}

// ------------------------------------------------------------------------------------------------------------ the explorer

/**
 * Asks Blockscout whether an address has verified source: GET /api/v2/smart-contracts/<address>, then the Etherscan-style getsourcecode
 * call as a second opinion. A read-only GET. `true` only when the explorer says so; any other answer, an error included, is `false`.
 */
export function explorerVerifiedFor(base: string, fetchImpl: typeof fetch = fetch): (address: string) => Promise<boolean> {
  const root = new URL(base);
  if (root.protocol !== "https:" && root.hostname !== "127.0.0.1" && root.hostname !== "localhost") throw new Error("the explorer URL must be https");
  const get = async (path: string): Promise<{ status: number; json: unknown }> => {
    const url = new URL(path, root);
    if (url.origin !== root.origin) throw new Error("refusing to leave the explorer's origin");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
  return async (address) => {
    const a = getAddress(address);
    try {
      const v2 = await get(`/api/v2/smart-contracts/${a}`);
      const body = v2.json as { is_verified?: unknown; name?: unknown; source_code?: unknown } | null;
      if (v2.status === 200 && body && (body.is_verified === true || (typeof body.name === "string" && typeof body.source_code === "string" && body.source_code.length > 0))) return true;
    } catch {
      // fall through to the second opinion
    }
    try {
      const legacy = await get(`/api?module=contract&action=getsourcecode&address=${a}`);
      const body = legacy.json as { result?: Array<{ SourceCode?: unknown; ABI?: unknown }> } | null;
      const first = body?.result?.[0];
      return legacy.status === 200 && typeof first?.SourceCode === "string" && first.SourceCode.length > 0 && typeof first.ABI === "string" && !/not verified/i.test(first.ABI);
    } catch {
      return false;
    }
  };
}

// ------------------------------------------------------------------------------------------------------------ the file

/** The hash cell: a link to the explorer where the network has one, otherwise the bare hash. */
export function hashCell(row: Pick<RecordedRow, "network" | "hash" | "claim" | "contract">): string {
  const base = EXPLORER[row.network];
  if (!base) return row.hash;
  const target = row.claim === "verify-link" ? `${base}/address/${row.contract}?tab=contract` : `${base}/tx/${row.hash}`;
  return `[${row.hash}](${target})`;
}

export function renderRow(row: RecordedRow): string {
  return `| ${[row.date, row.event, hashCell(row), row.block, row.contract, row.amount, row.who, row.network, row.claim, `\`${row.recheck}\``].join(" | ")} |`;
}

const FORK_HEADING = "## Fork (a local copy of QIE mainnet; never counted)";
const sectionHeading = (network: RecordNetwork): string => (network === "fork" ? FORK_HEADING : network === "mainnet" ? "## Mainnet (chain 1990)" : "## Testnet (chain 1983)");
const headingTest = (network: RecordNetwork): RegExp => (network === "fork" ? /^##\s+fork\b/i : NETWORKS[network].heading);

const HEADER = `| ${EVIDENCE_COLUMNS_EXTENDED.join(" | ")} |`;
const SEPARATOR = `| ${EVIDENCE_COLUMNS_EXTENDED.map(() => "---").join(" | ")} |`;

/** A row's identity for duplicate checks. */
export const rowKey = (r: Pick<RecordedRow, "network" | "hash" | "event" | "who" | "amount" | "claim">): string =>
  [r.network, r.hash, r.event, r.who, r.amount, r.claim].join("|").toLowerCase();

function upgradeEmptyTable(lines: string[], network: Network): void {
  const h = lines.findIndex((l) => NETWORKS[network].heading.test(l.trim()));
  if (h === -1) return;
  let t = h + 1;
  while (t < lines.length && !(lines[t] ?? "").trim().startsWith("|")) {
    if ((lines[t] ?? "").trim().startsWith("## ")) return;
    t += 1;
  }
  if (t >= lines.length || (lines[t] ?? "").trim() !== `| ${EVIDENCE_COLUMNS.join(" | ")} |`) return;
  let end = t + 2;
  while (end < lines.length && (lines[end] ?? "").trim().startsWith("|")) end += 1;
  if (end > t + 2) throw new RecordError(`the ${network} table holds rows in the original seven-column format; they have no Network column and cannot be mixed with recorded rows`);
  lines[t] = HEADER;
  lines[t + 1] = SEPARATOR;
}

/**
 * Adds rows to the evidence file's text and returns the new text. Throws RecordError, and returns nothing, if a row is a duplicate or
 * the table cannot take it. Rows for each network go in the table under that network's heading, which is created for a fork.
 */
export function appendRows(markdown: string, rows: RecordedRow[]): string {
  if (rows.length === 0) throw new RecordError("there is nothing to record");
  // The file's own line endings are kept: a file checked out with CRLF (git's autocrlf on Windows) gets CRLF rows, not a mix.
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  let lines = markdown.split(/\r?\n/);
  // A table in the original seven-column format that has no rows is brought up to the recorded format, wherever the new rows go; one that
  // has rows is refused, because its rows have no Network column.
  for (const network of ["mainnet", "testnet"] as const) upgradeEmptyTable(lines, network);
  for (const network of new Set(rows.map((r) => r.network))) {
    const mine = rows.filter((r) => r.network === network);
    let h = lines.findIndex((l) => headingTest(network).test(l.trim()));
    if (h === -1) {
      if (network !== "fork") throw new RecordError(`the evidence file has no "${sectionHeading(network)}" section`);
      while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
      lines.push("", sectionHeading(network), "", HEADER, SEPARATOR, "");
      h = lines.findIndex((l) => headingTest(network).test(l.trim()));
    }
    // The table: its header line, then its separator, then its rows, up to the first line that is not a table line.
    let t = h + 1;
    while (t < lines.length && !(lines[t] ?? "").trim().startsWith("|")) {
      if ((lines[t] ?? "").trim().startsWith("## ")) throw new RecordError(`the ${network} section has no table`);
      t += 1;
    }
    if (t >= lines.length) throw new RecordError(`the ${network} section has no table`);
    const header = (lines[t] ?? "").trim();
    let end = t + 2;
    while (end < lines.length && (lines[end] ?? "").trim().startsWith("|")) end += 1;
    const bodyRows = lines.slice(t + 2, end);
    if (header === HEADER) {
      // already the extended table
    } else if (header === `| ${EVIDENCE_COLUMNS.join(" | ")} |`) {
      if (bodyRows.length > 0) throw new RecordError(`the ${network} table holds rows in the original seven-column format; they have no Network column and cannot be mixed with recorded rows`);
      lines[t] = HEADER;
      lines[t + 1] = SEPARATOR;
    } else {
      throw new RecordError(`the ${network} table does not have the columns the recorder writes`);
    }
    const existing = new Set<string>();
    for (const line of bodyRows) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length !== EVIDENCE_COLUMNS_EXTENDED.length) continue;
      const hashMatch = /^\[(0x[0-9a-fA-F]{64})\]/.exec(cells[2] as string);
      existing.add(rowKey({ network: cells[7] as RecordNetwork, hash: hashMatch ? (hashMatch[1] as string) : (cells[2] as string), event: cells[1] as string, who: cells[6] as string, amount: cells[5] as string, claim: cells[8] as string }));
    }
    const fresh: string[] = [];
    for (const r of mine) {
      const key = rowKey(r);
      if (existing.has(key)) throw new RecordError(`this row is already in the evidence file (${r.event} in ${r.hash})`);
      existing.add(key);
      fresh.push(renderRow(r));
    }
    lines = [...lines.slice(0, end), ...fresh, ...lines.slice(end)];
  }
  const out = lines.join(eol);
  const real = rows.filter((r) => r.network !== "fork");
  if (real.length > 0) {
    // What is written must read back, strictly, with each row under the network it is labelled with.
    try {
      parseEvidenceStrict(out);
    } catch {
      throw new RecordError("the evidence file would not read back after this change, so nothing was written");
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ re-checking

/** `deposit`, `relayed-start (top-up 0x…)`, `paid-call-settlement (tool dex_quote)` -> the type and what was in the brackets. */
export function parseClaimCell(cell: string): { claim: ClaimType; topup?: string; tool?: string } | undefined {
  const m = /^([a-z-]+)(?: \((?:top-up (0x[0-9a-fA-F]{64})|tool ([A-Za-z0-9_.-]{1,64}))\))?$/.exec(cell.trim());
  if (!m || !(CLAIM_TYPES as readonly string[]).includes(m[1] as string)) return undefined;
  return { claim: m[1] as ClaimType, ...(m[2] ? { topup: m[2] } : {}), ...(m[3] ? { tool: m[3] } : {}) };
}

/**
 * Checks one row against the chain again. A row with a claim is verified by the same code that recorded it, and must be among the rows
 * that code produces now; a row without one (the original format) goes through the original check. A network problem is SKIPPED.
 */
export async function checkClaimRow(row: EvidenceRow, deps: ClaimDeps, router?: string): Promise<RowResult> {
  if (!row.claim) return checkRow(row, deps.rpc);
  const parsed = parseClaimCell(row.claim);
  if (!parsed) return { status: "FAIL", detail: `unknown claim ${JSON.stringify(row.claim)}` };
  try {
    const recorded = await verifyClaim(
      { ...parsed, network: row.network, hash: row.hash, router: router ?? (parsed.claim === "deploy" || parsed.claim === "verify-link" ? undefined : row.contract) },
      deps,
    );
    const same = recorded.rows.some(
      (r) => r.event === row.event && r.date === row.date && r.block === row.block && r.contract.toLowerCase() === row.contract.toLowerCase() && r.amount === row.amount && r.who.toLowerCase() === row.who.toLowerCase(),
    );
    return same
      ? { status: "PASS", detail: `${parsed.claim} confirmed in block ${row.block}` }
      : { status: "FAIL", detail: "the chain does not show this row: a column differs from what the transaction did" };
  } catch (err) {
    if (err instanceof RecordError && err.message.startsWith("the compiled router was not found")) return { status: "SKIPPED", detail: "compile first (pnpm compile): the deployed code is compared with the compiled code" };
    if (err instanceof RecordError) return { status: "FAIL", detail: err.message };
    if (err instanceof NetworkError || err instanceof RpcRefused) return { status: "SKIPPED", detail: "network: the chain could not be read" };
    return { status: "SKIPPED", detail: "network: unexpected response" };
  }
}

/**
 * The rows of the "Fork" table in a copy of the evidence file, which the recorder writes for a run on a local copy of the chain. They are
 * labelled "fork", the normal parser does not read them, and nothing counts them as evidence of anything; this exists so that a fork run
 * can be checked and counted with the same commands that will be used on mainnet. A row that is not in the recorded format is refused.
 */
export function parseForkRows(markdown: string): Array<Omit<EvidenceRow, "network"> & { network: "fork" }> {
  const rows: Array<Omit<EvidenceRow, "network"> & { network: "fork" }> = [];
  let inFork = false;
  let header = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      inFork = /^##\s+fork\b/i.test(line);
      header = false;
      continue;
    }
    if (!inFork || !line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (/^:?-{3,}:?$/.test(cells[0] ?? "")) continue;
    if (!header) {
      if (cells.join("|") !== EVIDENCE_COLUMNS_EXTENDED.join("|")) throw new RecordError("the Fork table does not have the columns the recorder writes");
      header = true;
      continue;
    }
    if (cells.length !== EVIDENCE_COLUMNS_EXTENDED.length) throw new RecordError(`malformed fork row: ${line.slice(0, 80)}`);
    const [date, event, hash, block, contract, amount, who, labelled, claim, recheck] = cells as [string, string, string, string, string, string, string, string, string, string];
    if (labelled !== "fork") throw new RecordError(`a row labelled "${labelled}" is in the Fork table: ${line.slice(0, 80)}`);
    rows.push({ network: "fork", date, event, hash: hashFromCell(hash), block, contract, amount, who, claim, recheck: recheck.replace(/`/g, "") });
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------------------ counts

export type ClaimCounts = { claim: string; rows: number; distinct: number; excluded: number };

/** Rows per claim type, and the distinct addresses in their Who column, leaving out rows whose Who is on the founder list. */
export function countByClaim(rows: EvidenceRow[], founders: ReadonlySet<string>): ClaimCounts[] {
  const groups = new Map<string, { rows: number; who: Set<string>; excluded: number }>();
  for (const r of rows) {
    if (r.network !== "mainnet") continue; // only mainnet rows are counted as proof of anything
    const type = r.claim ? (parseClaimCell(r.claim)?.claim ?? r.claim) : "unclassified";
    const g = groups.get(type) ?? { rows: 0, who: new Set<string>(), excluded: 0 };
    if (founders.has(r.who.toLowerCase())) {
      g.excluded += 1;
    } else {
      g.rows += 1;
      g.who.add(r.who.toLowerCase());
    }
    groups.set(type, g);
  }
  return [...CLAIM_TYPES, "unclassified"].map((claim) => {
    const g = groups.get(claim) ?? { rows: 0, who: new Set<string>(), excluded: 0 };
    return { claim, rows: g.rows, distinct: g.who.size, excluded: g.excluded };
  });
}
