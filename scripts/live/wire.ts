// pnpm live:wire --network mainnet: after scripts/live/deploy.ts has written deployment.json, writes the settings files for the facilitator, the
// tool server and the web app (.env.mainnet.facilitator, .env.mainnet.tool-server, .env.mainnet.web; all git-ignored) with the router, the
// vault, the token, the chain and the deployment block filled in, and prints which values are public, which are secrets you make, and which
// you still have to fill in. It writes no key. It reads only deployment.json and sends nothing.
//
//   pnpm live:wire --network mainnet
//   pnpm live:wire --network mainnet --deployment path\to\deployment.json --out .\settings --force
//
//   --network     mainnet or testnet; required, and it must be the network the deployment file names
//   --deployment  the file deploy.ts wrote (default deployment.json)
//   --out         the folder to write the three files to (default the current folder)
//   --force       replace files that are already there (otherwise they are refused, so nothing you filled in is lost)
//
// Exit code 0: written. 1: refused, with the reason.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WireError, describeWiring, parseDeployment, renderEnvFile, wire } from "../../src/wire";
import type { Network } from "../../src/evidence";

export type WireIo = { log?: (line: string) => void; cwd?: string };

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--network", "--deployment", "--out"]);

function parseArgs(argv: string[]): { values: Record<string, string>; force: boolean } {
  const values: Record<string, string> = {};
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--force") {
      force = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    values[flag.slice(2)] = value;
  }
  return { values, force };
}

export function main(argv: string[], io: WireIo = {}): number {
  const log = io.log ?? console.log;
  const cwd = io.cwd ?? ".";
  try {
    const { values, force } = parseArgs(argv);
    const network = values.network;
    if (network !== "mainnet" && network !== "testnet") throw new UsageError("give --network mainnet or --network testnet: there is no default, so the files are never written for the wrong network");
    const deploymentPath = join(cwd, values.deployment ?? "deployment.json");
    if (!existsSync(deploymentPath)) throw new UsageError(`${values.deployment ?? "deployment.json"} does not exist: run scripts/live/deploy.ts first, from this folder`);
    const record = parseDeployment(readFileSync(deploymentPath, "utf8"), network as Network);
    const files = wire(record);
    const outDir = join(cwd, values.out ?? ".");
    const targets = files.map((f) => join(outDir, f.file));
    const taken = targets.filter((t) => existsSync(t));
    if (taken.length > 0 && !force) throw new UsageError(`${files.filter((f) => existsSync(join(outDir, f.file))).map((f) => f.file).join(", ")} already exist${taken.length === 1 ? "s" : ""}: they may hold values you filled in. Use --force to replace them`);
    mkdirSync(outDir, { recursive: true });
    files.forEach((f, i) => writeFileSync(targets[i] as string, renderEnvFile(f), { flag: force ? "w" : "wx" }));
    log(`wrote ${files.map((f) => f.file).join(", ")} for ${network} (chain ${record.chainId}), router ${record.router}`);
    log("They hold no key, and they are git-ignored (every name starts with .env.). Which values are which:");
    for (const line of describeWiring(files)) log(line);
    log("");
    log("A value left empty makes the program that reads it refuse to start, so nothing runs half set up. Fill them in, then run pnpm live:preflight again.");
    return 0;
  } catch (err) {
    if (err instanceof UsageError || err instanceof WireError) {
      log(`refused: ${err.message}`);
      return 1;
    }
    log("live:wire failed to run");
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
