// pnpm live:golive:plan: the exact, ordered PowerShell commands of the whole mainnet go-live, with the five addresses filled in, after the
// addresses have been checked against each other and against the chain.
//
//   $env:SLUICE_NETWORK = "mainnet"
//   pnpm live:golive:plan --owner 0x... --fee-recipient 0x... --payer 0x...
//
// Read-only. It prints commands and runs none of them: it sends nothing, signs nothing and has no spending caps because it spends nothing.
//
//   --owner          the router's owner (a plain account, not the deployer's or the relayer's address)
//   --fee-recipient  where the fee is credited
//   --payer          the wallet that starts with no QIE
//   --deployer       the deployer's address. Left out, it is read from .\deployer-mainnet.key in the folder it is run from.
//   --relayer        the relayer's address. Left out, it is read from .\relayer-mainnet.key.
//   --payer-qusdc    what the payer deposits in the start with no QIE (default 0.3, and never above 100: the live scripts' ceiling)
//
// A key file is read only to learn the address it belongs to. The key is not printed, not kept and not put in any message.
// SLUICE_NETWORK must be mainnet. SLUICE_RPC_URL names one endpoint; left out, QIE's five endpoints are probed in turn.
// Exit code 0: printed (warnings are part of the output). 1: refused, and why. 2: the chain could not be read.
import { exitWith } from "../../src/exit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NoHealthyEndpoint } from "@sluice/sdk";
import type { Rpc } from "../../src/evidence";
import { NetworkError } from "../../src/evidence";
import { DEFAULT_PAYER_QUSDC, FLAG, GOLIVE_READ_ONLY_METHODS, KeyFileError, MAINNET_CHAIN_ID, addressOfKeyFileText, checkRoles, evaluate, formatPlan, readFacts } from "../../src/golive-plan";
import type { Role } from "../../src/golive-plan";
import { CEILING_QUSDC, parseAmount } from "../../src/guard";
import { readOnlyRpc, RpcRefused } from "../../src/readrpc";
import { publicRpcUrls } from "../../src/recorder";
import { chooseRpc } from "../../src/rpc-use";

export type Env = Record<string, string | undefined>;
export type PlanIo = {
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** A reader of the chain given by a test. Left out, the program reads QIE's endpoints. */
  rpc?: Rpc;
  /** The folder the key files are looked for in. Left out, the folder the program was run from. */
  cwd?: string;
};

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--owner", "--fee-recipient", "--payer", "--deployer", "--relayer", "--payer-qusdc"]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown option ${flag.slice(0, 40)} (the options are ${[...VALUE_FLAGS].join(", ")})`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag.slice(2) in out) throw new UsageError(`${flag} was given twice`);
    out[flag.slice(2)] = value;
  }
  return out;
}

export async function main(argv: string[], env: Env = process.env, io: PlanIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  try {
    const args = parseArgs(argv);
    if (env.SLUICE_NETWORK?.trim() !== "mainnet") {
      log("refused: set SLUICE_NETWORK to mainnet. This plan is for chain 1990 and is not made for any other network.");
      return 1;
    }
    const payerQusdc = args["payer-qusdc"] ? parseAmount(args["payer-qusdc"], 6, "--payer-qusdc") : DEFAULT_PAYER_QUSDC;
    if (payerQusdc > CEILING_QUSDC) throw new UsageError("--payer-qusdc is above 100, the most the live scripts will move");

    // The five addresses. The owner and the fee recipient are always given. The deployer's and the relayer's come from the options, or else
    // from their key files. A key file that is there is also checked against the address given for it, for the deployer, the relayer and the
    // payer: the pre-flight check reads the balance of the address it is given, so a wrong address would make it say GO about the wrong
    // account. Each file is read for the address it belongs to and for nothing else.
    const raw: Partial<Record<Role, string>> = { owner: args.owner, feeRecipient: args["fee-recipient"], payer: args.payer };
    const keyProblems: Partial<Record<Role, string>> = {};
    for (const role of ["deployer", "relayer", "payer"] as const) {
      const file = `${role}-mainnet.key`;
      const given = args[role];
      let fromFile: string | undefined;
      let readable = true;
      try {
        fromFile = addressOfKeyFileText(readFileSync(join(io.cwd ?? process.cwd(), file), "utf8"), file);
      } catch (err) {
        if (err instanceof KeyFileError) keyProblems[role] = given ? err.message : `${FLAG[role]} was not given, and ${err.message}`;
        else readable = false;
      }
      if (given) raw[role] = given;
      else if (fromFile && role !== "payer") raw[role] = fromFile;
      else if (!readable && role !== "payer") keyProblems[role] = `${FLAG[role]} was not given, and ${file} could not be read in this folder: give ${FLAG[role]} the address, or run this from the folder that holds the key`;
      if (given && fromFile && given.toLowerCase() !== fromFile.toLowerCase()) {
        keyProblems[role] = `${file} belongs to a different address than ${FLAG[role]}: one of them is the wrong one`;
      }
    }
    const checked = checkRoles(raw);
    const problems = [...Object.values(keyProblems), ...checked.problems.filter((p) => !(Object.keys(keyProblems) as Role[]).some((role) => p === `${FLAG[role]} is missing`))];
    if (problems.length > 0 || !checked.roles) {
      for (const p of problems) log(`refused: ${p}`);
      return 1;
    }
    const roles = checked.roles;

    // The chain. Nothing is opened before this point: a wrong address is refused without a connection.
    let rpc = io.rpc;
    if (!rpc) {
      const named = env.SLUICE_RPC_URL?.trim();
      let urls: string[] = named ? [named] : publicRpcUrls("mainnet");
      for (const url of urls) {
        if (!url.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) throw new UsageError("SLUICE_RPC_URL must be https");
      }
      if (!named) {
        try {
          const chosen = await chooseRpc("mainnet", undefined, log, { fetchImpl: io.fetchImpl });
          urls = [chosen.url, ...urls.filter((u) => u !== chosen.url)];
        } catch (err) {
          if (!(err instanceof NoHealthyEndpoint)) throw err;
          log(`golive plan: ${err.message}`);
          log("no RPC endpoint can be read, so no plan was made");
          return 2;
        }
      }
      rpc = readOnlyRpc(urls, GOLIVE_READ_ONLY_METHODS, io.fetchImpl ?? fetch);
    }
    let facts;
    try {
      facts = await readFacts(rpc, roles);
    } catch (err) {
      if (err instanceof NetworkError || err instanceof RpcRefused) {
        log("the chain could not be read, so no plan was made. A plan is never guessed.");
        return 2;
      }
      throw err;
    }
    if (facts.chainId !== MAINNET_CHAIN_ID) {
      log(`refused: the RPC is on chain ${facts.chainId}, but this plan is for mainnet (chain ${MAINNET_CHAIN_ID})`);
      return 1;
    }
    const findings = evaluate(roles, facts, payerQusdc);
    for (const line of formatPlan(roles, facts, findings, payerQusdc)) log(line);
    return findings.some((f) => f.level === "FAIL") ? 1 : 0;
  } catch (err) {
    // A message is written for a person and holds no key. Anything else is reported by its kind alone.
    log(err instanceof UsageError ? `refused: ${err.message}` : err instanceof Error && /^(--|SLUICE_)/.test(err.message) ? `refused: ${err.message}` : "the go-live plan failed to run");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("live:golive:plan failed");
      exitWith(1);
    },
  );
}
