// The pre-flight check: read-only questions to QIE's public RPC and a verdict, GO or NO-GO, before anything is spent.
//
//   SLUICE_NETWORK=mainnet pnpm live:preflight --deployer 0x... --relayer 0x...
//   SLUICE_NETWORK=mainnet SLUICE_ROUTER=0x... pnpm live:preflight --phase post-deploy --deployment deployment.json
//
// It sends nothing and holds no key. It asks rpc1 to rpc5 of the network in turn (or SLUICE_RPC_URL alone), and reads: the chain id, whether
// the endpoints agree, the gas price, QUSDC's code and decimals, the deployer's and the relayer's balances, and (after a deploy) whether
// the router at SLUICE_ROUTER answers like a Sluice router and has the code recorded when it was deployed.
//
//   --phase       pre-deploy or post-deploy (default: post-deploy when SLUICE_ROUTER is set)
//   --deployer    the deployer's address; or SLUICE_KEY in the environment, from which only the address is taken
//   --relayer     the relayer's address; or SLUICE_RELAYER_KEY in the environment, the same way
//   --deployment  the file scripts/live/deploy.ts wrote (default deployment.json, if it exists)
//   --explorer    the explorer to check for a reply (default https://mainnet.qie.digital on mainnet)
//
// Exit code 0: GO. 1: NO-GO, or a wrong command. 2: the chain could not be read at all.
import { existsSync, readFileSync } from "node:fs";
import { Wallet, getAddress } from "ethers";
import { NETWORKS } from "../../src/evidence";
import type { Network } from "../../src/evidence";
import { formatPreflight, preflight } from "../../src/preflight";
import type { PreflightInput } from "../../src/preflight";
import { parseAmount } from "../../src/guard";
import { publicRpcUrls } from "../../src/recorder";

export type Env = Record<string, string | undefined>;
export type PreflightIo = { log?: (line: string) => void; fetchImpl?: typeof fetch; cwd?: string };

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--phase", "--deployer", "--relayer", "--deployment", "--explorer"]);

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

const addressOf = (key: string | undefined): string | undefined => {
  const k = key?.trim();
  return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? new Wallet(k).address : undefined;
};

export async function main(argv: string[], env: Env = process.env, io: PreflightIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  try {
    const args = parseArgs(argv);
    const network = env.SLUICE_NETWORK?.trim();
    if (network !== "mainnet" && network !== "testnet") throw new UsageError("set SLUICE_NETWORK to mainnet or testnet");
    const phaseArg = args.phase;
    if (phaseArg !== undefined && phaseArg !== "pre-deploy" && phaseArg !== "post-deploy") throw new UsageError("--phase must be pre-deploy or post-deploy");
    const router = env.SLUICE_ROUTER?.trim() || undefined;
    const phase = phaseArg ?? (router ? "post-deploy" : "pre-deploy");

    const given = (name: string, value: string | undefined): string | undefined => {
      if (!value) return undefined;
      try {
        return getAddress(value);
      } catch {
        throw new UsageError(`${name} is not an address`);
      }
    };
    const deployer = given("--deployer", args.deployer) ?? addressOf(env.SLUICE_KEY);
    const relayer = given("--relayer", args.relayer) ?? addressOf(env.SLUICE_RELAYER_KEY);

    const rpcOverride = env.SLUICE_RPC_URL?.trim();
    const rpcUrls = rpcOverride ? [rpcOverride] : publicRpcUrls(network as Network);
    for (const url of rpcUrls) if (!url.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) throw new UsageError("SLUICE_RPC_URL must be https");

    const file = args.deployment ?? (existsSync(`${io.cwd ?? "."}/deployment.json`) ? `${io.cwd ?? "."}/deployment.json` : undefined);
    let deployment: PreflightInput["deployment"];
    if (file) {
      try {
        deployment = JSON.parse(readFileSync(file, "utf8")) as PreflightInput["deployment"];
      } catch {
        throw new UsageError("the deployment file could not be read");
      }
    }

    const input: PreflightInput = {
      network: network as Network,
      rpcUrls,
      phase,
      ...(deployer ? { deployer } : {}),
      ...(relayer ? { relayer } : {}),
      ...(router ? { router } : {}),
      ...(env.SLUICE_TOKEN?.trim() ? { token: env.SLUICE_TOKEN.trim() } : {}),
      ...(deployment ? { deployment } : {}),
      ...(env.SLUICE_MAX_QIE?.trim() ? { relayerBudgetWei: parseAmount(env.SLUICE_MAX_QIE, 18, "SLUICE_MAX_QIE") } : {}),
      ...(env.SLUICE_MAX_QUSDC?.trim() ? { maxQusdc: parseAmount(env.SLUICE_MAX_QUSDC, 6, "SLUICE_MAX_QUSDC") } : {}),
    };
    const explorer = args.explorer ?? env.SLUICE_EXPLORER_URL?.trim() ?? (network === "mainnet" ? "https://mainnet.qie.digital" : undefined);
    const fetchImpl = io.fetchImpl ?? fetch;
    const result = await preflight(input, {
      fetchImpl,
      ...(explorer
        ? {
            explorerReachable: async () => {
              try {
                const res = await fetchImpl(new URL("/api/v2/stats", explorer), { method: "GET", signal: AbortSignal.timeout?.(10_000) });
                return res.status < 500;
              } catch {
                return false;
              }
            },
          }
        : {}),
    });
    log(`pre-flight on ${network} (chain ${NETWORKS[network as Network].chainId}), ${phase}. Read-only: nothing is sent.`);
    for (const line of formatPreflight(result, network as Network)) log(line);
    if (result.checks.some((c) => c.name === "Chain id" && c.status === "FAIL" && c.detail === "no RPC endpoint could be read")) return 2;
    return result.go ? 0 : 1;
  } catch (err) {
    log(err instanceof UsageError ? `refused: ${err.message}` : err instanceof Error && /^SLUICE_/.test(err.message) ? `refused: ${err.message}` : "the pre-flight check failed to run");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error("live:preflight failed");
      process.exit(1);
    },
  );
}
