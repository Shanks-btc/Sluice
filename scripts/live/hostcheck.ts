// pnpm live:hostcheck: ask the hosted facilitator and the hosted tool server for /health, and print PASS, WARN or FAIL for each thing that has
// to be true before anyone is pointed at them.
//
//   pnpm live:hostcheck --facilitator https://facilitator.example --tools https://tools.example
//   pnpm live:hostcheck --facilitator https://... --tools https://... --origin https://sluice.example
//
// Read-only. The only request it makes is GET /health, on each service (and twice more on each when --origin is given, to ask what a page on
// that origin, and on one that is not listed, would be told). It sends nothing to the chain, signs nothing and holds no key.
//
//   --facilitator  the facilitator's public address: https, with no path
//   --tools        the tool server's public address: https, with no path
//   --router       the router both must report. Left out: SLUICE_ROUTER, then the router in deployment.json in this folder.
//   --origin       the web app's exact origin (https, no path, no wildcard): checks that each service lets that origin read its answers, and no other
//
// Exit code 0: nothing failed (warnings are not failures). 1: something failed. 2: the command was wrong, and nothing was asked.
import { exitWith } from "../../src/exit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { checkHost, formatLines, parseServiceUrl, parseWebOrigin, summarize } from "../../src/hostcheck";

export type Env = Record<string, string | undefined>;
export type HostCheckIo = { log?: (line: string) => void; fetchImpl?: typeof fetch; cwd?: string; expectedChainId?: number; expectedNetwork?: string; timeoutMs?: number };

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--facilitator", "--tools", "--router", "--origin"]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown option ${flag.slice(0, 30)} (the options are ${[...VALUE_FLAGS].join(", ")})`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag.slice(2) in out) throw new UsageError(`${flag} was given twice`);
    out[flag.slice(2)] = value;
  }
  return out;
}

/** The router to compare with: --router, else SLUICE_ROUTER, else deployment.json in this folder. Where it came from is said in the output. */
function expectedRouter(args: Record<string, string>, env: Env, cwd: string): { router?: string; source?: string } {
  const given = args.router ?? env.SLUICE_ROUTER?.trim();
  if (given) {
    try {
      return { router: getAddress(given), source: args.router ? "--router" : "SLUICE_ROUTER" };
    } catch {
      throw new UsageError(`${args.router ? "--router" : "SLUICE_ROUTER"} is not an address`);
    }
  }
  try {
    const record = JSON.parse(readFileSync(join(cwd, "deployment.json"), "utf8")) as { router?: unknown };
    if (typeof record.router === "string") return { router: getAddress(record.router), source: "deployment.json" };
  } catch {
    // no deployment record here: the checks then say there is no router to compare with
  }
  return {};
}

export async function main(argv: string[], env: Env = process.env, io: HostCheckIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  try {
    const args = parseArgs(argv);
    const facilitator = parseServiceUrl("--facilitator", args.facilitator);
    const tools = parseServiceUrl("--tools", args.tools);
    const web = args.origin !== undefined ? parseWebOrigin("--origin", args.origin) : undefined;
    const problems = [facilitator.problem, tools.problem, web?.problem].filter((p): p is string => Boolean(p));
    if (problems.length > 0) {
      for (const p of problems) log(`refused: ${p}`);
      return 2;
    }
    const expected = expectedRouter(args, env, io.cwd ?? process.cwd());
    log(`Host check at ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}. Read-only: the only request is GET /health.`);
    log(`facilitator ${facilitator.origin}, tool server ${tools.origin}${web?.origin ? `, web origin ${web.origin}` : ""}`);
    log(expected.router ? `expected router ${expected.router} (${expected.source})` : "no expected router: give --router, set SLUICE_ROUTER, or run this where deployment.json is");
    const lines = await checkHost({
      facilitator: facilitator.origin as string,
      tools: tools.origin as string,
      router: expected.router,
      routerSource: expected.source,
      origin: web?.origin,
      fetchImpl: io.fetchImpl,
      expectedChainId: io.expectedChainId,
      expectedNetwork: io.expectedNetwork,
      timeoutMs: io.timeoutMs,
    });
    for (const text of formatLines(lines)) log(text);
    const total = summarize(lines);
    log(`hostcheck: ${total.pass} passed, ${total.fail} failed, ${total.warn} warning${total.warn === 1 ? "" : "s"}`);
    return total.fail > 0 ? 1 : 0;
  } catch (err) {
    log(err instanceof UsageError ? `refused: ${err.message}` : "the host check failed to run");
    return err instanceof UsageError ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("live:hostcheck failed");
      exitWith(1);
    },
  );
}
