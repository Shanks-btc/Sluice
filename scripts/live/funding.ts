// pnpm live:funding: how much QIE and QUSDC the founder needs to put at each address before the mainnet deploy, from the gas measured in
// docs/GAS.md at the gas price on the chain right now, and what buying QUSDC from QIEDEX's pool would cost at 10, 25 and 100 QUSDC.
//
//   pnpm live:funding --deployer 0x... --relayer 0x...
//   pnpm live:funding --deployer 0x... --relayer 0x... --qusdc 25 --margin 4
//
// Read-only. It sends nothing and holds no key. It asks rpc1 to rpc5 of mainnet in turn (or SLUICE_RPC_URL alone), reads at one block, and
// prints that block and its time. It reads no price in dollars.
//
//   --deployer  the deployer's address, to show what it holds and what it still needs (optional)
//   --relayer   the relayer's address, the same (optional)
//   --qusdc     the funded run's size in QUSDC (default 10, and never above 100: the live scripts' ceiling)
//   --margin    the factor on the gas figures (default 3, from 1 to 10)
//
// SLUICE_MAX_QIE sets the relayer's day budget for the low-balance line (default 0.5 QIE).
// Exit code 0: printed. 1: a wrong command. 2: the chain could not be read.
import { exitWith } from "../../src/exit";
import { getAddress } from "ethers";
import { NoHealthyEndpoint } from "@sluice/sdk";
import { NetworkError } from "../../src/evidence";
import { DEFAULT_DAILY_BUDGET_WEI, DEFAULT_MARGIN, DEFAULT_RUN_QUSDC, FUNDING_READ_ONLY_METHODS, PRICED_SIZES, formatFunding, planFunding, readFundingInputs } from "../../src/funding";
import { CEILING_QUSDC, parseAmount } from "../../src/guard";
import { readOnlyRpc } from "../../src/readrpc";
import { publicRpcUrls } from "../../src/recorder";
import { chooseRpc } from "../../src/rpc-use";

export type Env = Record<string, string | undefined>;
export type FundingIo = { log?: (line: string) => void; fetchImpl?: typeof fetch };

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--deployer", "--relayer", "--qusdc", "--margin"]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    out[flag.slice(2)] = value;
  }
  return out;
}

const addressOf = (name: string, value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return getAddress(value);
  } catch {
    throw new UsageError(`${name} is not an address`);
  }
};

export async function main(argv: string[], env: Env = process.env, io: FundingIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  try {
    const args = parseArgs(argv);
    const runQusdc = args.qusdc ? parseAmount(args.qusdc, 6, "--qusdc") : DEFAULT_RUN_QUSDC;
    if (runQusdc > CEILING_QUSDC) throw new UsageError("--qusdc is above 100, the most the live scripts will move");
    let margin = DEFAULT_MARGIN;
    if (args.margin !== undefined) {
      if (!/^\d{1,2}$/.test(args.margin) || Number(args.margin) < 1 || Number(args.margin) > 10) throw new UsageError("--margin must be a whole number from 1 to 10");
      margin = BigInt(args.margin);
    }
    const dailyBudgetWei = env.SLUICE_MAX_QIE?.trim() ? parseAmount(env.SLUICE_MAX_QIE, 18, "SLUICE_MAX_QIE") : DEFAULT_DAILY_BUDGET_WEI;
    const addresses: Array<{ label: string; address: string }> = [];
    const deployer = addressOf("--deployer", args.deployer);
    const relayer = addressOf("--relayer", args.relayer);
    if (deployer) addresses.push({ label: "deployer", address: deployer });
    if (relayer) addresses.push({ label: "relayer", address: relayer });
    if (deployer && relayer && deployer === relayer) throw new UsageError("the deployer and the relayer are the same address: they need keys of their own");

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
        log(`funding: ${err.message}`);
        log("no RPC endpoint can be read, so nothing was calculated");
        return 2;
      }
    }
    const rpc = readOnlyRpc(urls, FUNDING_READ_ONLY_METHODS, io.fetchImpl ?? fetch);
    let reads;
    try {
      // The sizes priced are 10, 25 and 100 QUSDC, and the plan's own total, so the pool's router is asked about each.
      reads = await readFundingInputs(rpc, addresses, [...PRICED_SIZES, planFunding({ gasPrice: 1n, runQusdc, margin, dailyBudgetWei }).totalQusdc]);
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
      log("the chain could not be read, so nothing was calculated");
      return 2;
    }
    if (reads.chainId !== 1990) {
      log(`the RPC is on chain ${reads.chainId}, but this calculator is for mainnet (chain 1990)`);
      return 1;
    }
    for (const line of formatFunding(reads, { runQusdc, margin, dailyBudgetWei })) log(line);
    return 0;
  } catch (err) {
    log(err instanceof UsageError ? `refused: ${err.message}` : err instanceof Error && /^(--|SLUICE_)/.test(err.message) ? `refused: ${err.message}` : "the funding calculator failed to run");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("live:funding failed");
      exitWith(1);
    },
  );
}
