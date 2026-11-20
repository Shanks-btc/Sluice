// pnpm evidence:record: the only way a row gets into docs/EVIDENCE.md.
//
//   pnpm evidence:record --claim deposit --tx 0x... --network mainnet --router 0x...
//
// It reads the transaction back from QIE's public RPC (rpc1 to rpc5, in turn) with read-only methods, checks that it succeeded and that
// it shows what the claim says, and then adds a dated row, with its explorer link and the command that checks it again. If the chain
// disagrees with the claim, it prints why and writes nothing. It holds no key and sends nothing.
//
//   --claim    deploy | verify-link | settle-batch | deposit | relayed-start | paid-call-settlement | withdraw
//   --tx       the transaction. For deploy and verify-link it is the deployment; for relayed-start it is the deposit
//   --network  mainnet or testnet (or fork, for a test run on a local copy, which never touches docs/EVIDENCE.md)
//   --router   the router (or SLUICE_ROUTER); not needed for deploy and verify-link
//   --topup    relayed-start: the transaction in which the facilitator sent the payer QIE
//   --tool     paid-call-settlement: the tool's name, to require that the payment is for that tool
//   --rpc      an RPC URL, repeatable; the default is rpc1 to rpc5 of the network. Must be https on a qie.digital host unless
//              --allow-custom-rpc is given, and a local address is only for --network fork
//   --explorer the explorer's address, for verify-link (or SLUICE_EXPLORER_URL; the default for mainnet is https://mainnet.qie.digital)
//   --file     the evidence file to write; required for fork, and never docs/EVIDENCE.md for fork
//   --dry-run  verify and print the rows, and write nothing
//
// Exit code 0: recorded. 1: refused (the claim does not hold, or the command was wrong). 2: the chain could not be read, so nothing was
// verified and nothing was written.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NetworkError } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import {
  CLAIM_TYPES, RecordError, RpcRefused, appendRows, explorerVerifiedFor, publicRpcUrls, recorderRpc, renderRow, verifyClaim,
} from "../../src/recorder";
import type { ClaimDeps, ClaimInput, ClaimType, RecordNetwork } from "../../src/recorder";

export type Env = Record<string, string | undefined>;

export type RecordIo = {
  log?: (line: string) => void;
  /** For tests: a node to ask instead of the one the URLs name. */
  rpc?: Rpc;
  fetchImpl?: typeof fetch;
  explorerVerified?: ClaimDeps["explorerVerified"];
  compiledRouterCode?: ClaimDeps["compiledRouterCode"];
  /** Where docs/EVIDENCE.md is. Defaults to this repository's. */
  evidencePath?: string;
};

type Args = {
  claim?: string;
  tx?: string;
  network?: string;
  router?: string;
  topup?: string;
  tool?: string;
  rpc: string[];
  explorer?: string;
  file?: string;
  allowCustomRpc: boolean;
  dryRun: boolean;
};

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--claim", "--tx", "--network", "--router", "--topup", "--tool", "--rpc", "--explorer", "--file"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { rpc: [], allowCustomRpc: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--allow-custom-rpc") {
      out.allowCustomRpc = true;
    } else if (flag === "--dry-run") {
      out.dryRun = true;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      if (flag === "--rpc") out.rpc.push(value);
      else (out as unknown as Record<string, unknown>)[flag.slice(2)] = value;
    } else {
      throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
    }
  }
  return out;
}

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/** The RPC endpoints a claim on this network may be read from. A local node is only ever a fork, which is never evidence. */
export function chooseRpc(network: RecordNetwork, urls: string[], allowCustom: boolean): string[] {
  if (network === "fork") {
    if (urls.length === 0) throw new UsageError("a fork run needs --rpc with the address of the local node");
    for (const u of urls) if (!LOCAL.test(u)) throw new UsageError("a fork run reads only from a node on this machine (http://127.0.0.1)");
    return urls;
  }
  if (urls.length === 0) return publicRpcUrls(network);
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw new UsageError("an --rpc value is not a URL");
    }
    if (LOCAL.test(u)) throw new UsageError(`a node on this machine is not ${network}: a local copy of the chain is labelled fork and is never recorded as evidence`);
    if (url.protocol !== "https:") throw new UsageError("--rpc must be https");
    if (!allowCustom && !url.hostname.endsWith(".qie.digital")) {
      throw new UsageError("--rpc is not a qie.digital address; add --allow-custom-rpc only if you trust that node to be QIE " + network);
    }
  }
  return urls;
}

export async function main(argv: string[], env: Env = process.env, io: RecordIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  const evidencePath = resolve(io.evidencePath ?? join(__dirname, "..", "..", "docs", "EVIDENCE.md"));
  try {
    const args = parseArgs(argv);
    const claim = args.claim as ClaimType | undefined;
    if (!claim || !(CLAIM_TYPES as readonly string[]).includes(claim)) throw new UsageError(`--claim must be one of ${CLAIM_TYPES.join(", ")}`);
    if (!args.tx) throw new UsageError("--tx is needed: the transaction hash");
    const network = (args.network ?? env.SLUICE_NETWORK?.trim()) as RecordNetwork | undefined;
    if (network !== "mainnet" && network !== "testnet" && network !== "fork") throw new UsageError("--network must be mainnet, testnet or fork");

    let file = evidencePath;
    if (network === "fork") {
      if (!args.file) throw new UsageError("a fork run needs --file: a fork row is never written to docs/EVIDENCE.md");
      file = resolve(args.file);
      if (file === evidencePath) throw new UsageError("a fork row is never written to docs/EVIDENCE.md");
    } else if (args.file) {
      file = resolve(args.file);
    }

    const urls = chooseRpc(network, args.rpc.length > 0 ? args.rpc : env.EVIDENCE_RPC_URL?.trim() ? [env.EVIDENCE_RPC_URL.trim()] : [], args.allowCustomRpc);
    const rpc = io.rpc ?? recorderRpc(urls, io.fetchImpl);
    const router = args.router ?? env.SLUICE_ROUTER?.trim();
    const input: ClaimInput = { claim, network, hash: args.tx, ...(router ? { router } : {}), ...(args.topup ? { topup: args.topup } : {}), ...(args.tool ? { tool: args.tool } : {}) };

    let explorerVerified = io.explorerVerified;
    if (claim === "verify-link" && !explorerVerified) {
      const base = args.explorer ?? env.SLUICE_EXPLORER_URL?.trim() ?? (network === "mainnet" ? "https://mainnet.qie.digital" : undefined);
      if (!base) throw new UsageError("verify-link needs --explorer: there is no default explorer for this network");
      explorerVerified = explorerVerifiedFor(base, io.fetchImpl);
    }

    const { rows, notes } = await verifyClaim(input, { rpc, explorerVerified, compiledRouterCode: io.compiledRouterCode });
    for (const note of notes) log(`checked: ${note}`);
    if (args.dryRun) {
      log("dry run: nothing was written. The rows would be:");
      for (const row of rows) log(renderRow(row));
      return 0;
    }
    const before = readFileSync(file, "utf8");
    const after = appendRows(before, rows);
    // Written to a temporary file and moved into place, so a stop half-way leaves the old file, never half of the new one.
    const tmp = join(dirname(file), `.${Date.now()}.evidence.tmp`);
    writeFileSync(tmp, after);
    renameSync(tmp, file);
    log(`recorded ${rows.length} row${rows.length === 1 ? "" : "s"} for the ${claim} claim on ${network}:`);
    for (const row of rows) {
      log(renderRow(row));
    }
    log(`check it again any time with: ${rows[0]?.recheck}`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      log(`refused: ${err.message}`);
      return 1;
    }
    if (err instanceof RecordError) {
      log(`refused: ${err.message}. Nothing was written.`);
      return 1;
    }
    if (err instanceof NetworkError || err instanceof RpcRefused) {
      log("the chain could not be read, so nothing was verified and nothing was written.");
      return 2;
    }
    log("the recorder failed, and nothing was written.");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error("evidence:record failed");
      process.exit(1);
    },
  );
}
