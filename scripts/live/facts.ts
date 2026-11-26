// pnpm live:facts: reads QUSDC's roles, supply and burn power from QIE mainnet again, with read-only calls, and says whether they still match
// what docs/RISKS.md states. It sends nothing and holds no key.
//
//   pnpm live:facts
//
// It asks rpc1 to rpc5 of mainnet in turn (or SLUICE_RPC_URL alone), at one block, and prints that block. Exit code 0: it matches the
// document. 1: something differs (the document must be corrected, and a changed role holder is worth reading before any money goes in).
// 2: the chain could not be read, so nothing was checked.
import { exitWith } from "../../src/exit";
import { NoHealthyEndpoint } from "@sluice/sdk";
import { FACTS_READ_ONLY_METHODS, compareWithRisks, formatFacts, readQusdcFacts } from "../../src/qusdc-facts";
import { readOnlyRpc } from "../../src/readrpc";
import { publicRpcUrls } from "../../src/recorder";
import { chooseRpc } from "../../src/rpc-use";
import { NetworkError } from "../../src/evidence";

export type Env = Record<string, string | undefined>;
export type FactsIo = { log?: (line: string) => void; fetchImpl?: typeof fetch };

export async function main(argv: string[], env: Env = process.env, io: FactsIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  if (argv.length > 0) {
    log(`refused: unknown option ${argv[0]?.slice(0, 40)} (this command takes no options)`);
    return 1;
  }
  const named = env.SLUICE_RPC_URL?.trim();
  let urls: string[] = named ? [named] : publicRpcUrls("mainnet");
  for (const url of urls) {
    if (!url.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
      log("refused: SLUICE_RPC_URL must be https");
      return 1;
    }
  }
  if (!named) {
    try {
      const chosen = await chooseRpc("mainnet", undefined, log, { fetchImpl: io.fetchImpl });
      urls = [chosen.url, ...urls.filter((u) => u !== chosen.url)];
    } catch (err) {
      if (!(err instanceof NoHealthyEndpoint)) throw err;
      log(`QUSDC facts: ${err.message}`);
      log("no RPC endpoint can be read, so nothing was checked");
      return 2;
    }
  }
  try {
    const rpc = readOnlyRpc(urls, FACTS_READ_ONLY_METHODS, io.fetchImpl ?? fetch);
    const chain = BigInt(String(await rpc("eth_chainId", [])));
    if (chain !== 1990n) {
      log(`the RPC is on chain ${chain}, but QUSDC's facts are for mainnet (chain 1990)`);
      return 1;
    }
    const facts = await readQusdcFacts(rpc);
    const comparison = compareWithRisks(facts);
    for (const line of formatFacts(facts, comparison)) log(line);
    return comparison.matches ? 0 : 1;
  } catch (err) {
    log(err instanceof NetworkError ? "the chain could not be read, so nothing was checked" : "the QUSDC facts could not be read");
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("live:facts failed");
      exitWith(2);
    },
  );
}
