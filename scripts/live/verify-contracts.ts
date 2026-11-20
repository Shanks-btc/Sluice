// Gets the router's and the vault's source verified on the explorer, and checks that the explorer says so.
//
//   SLUICE_NETWORK=mainnet SLUICE_APPROVE=verify pnpm live:verify --deployment deployment.json
//   SLUICE_NETWORK=mainnet pnpm live:verify --check-only          (only asks the explorer whether it shows verified source)
//   SLUICE_NETWORK=mainnet pnpm live:verify --prepare-only        (only writes the files for the manual route)
//
// THE FOUNDER RUNS THIS. It holds no key and sends no transaction. Submitting is a POST of the source files to the explorer's
// verifysourcecode endpoint, so it needs SLUICE_APPROVE=verify; the other two modes need no approval.
//
// Whatever happens, it first writes everything the manual route needs to artifacts/verification/: for each contract the standard JSON
// input, a flattened single file, and the exact settings (printed). The explorer answers 502 at times; when it does, this script says so and
// the manual route in docs/MAINNET-RUNBOOK.md is the way through.
//
// Exit code 0: the explorer shows verified source for both. 1: it does not, or the command was wrong. 2: the explorer could not be reached.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { NetworkError } from "../../src/evidence";
import { recorderRpc, RpcRefused, explorerVerifiedFor } from "../../src/recorder";
import type { Rpc } from "../../src/evidence";
import { EXPECTED, VerifyError, buildInput, constructorArguments, flatten, submitVerification, vaultConstructorArguments } from "../../src/verify-contracts";
import type { BuildInput, SubmitOptions } from "../../src/verify-contracts";

export type Env = Record<string, string | undefined>;
export type VerifyIo = {
  log?: (line: string) => void;
  /** Where the repository is (its artifacts/ folder and deployment.json). */
  root?: string;
  rpc?: Rpc;
  fetchImpl?: typeof fetch;
  submit?: SubmitOptions;
};

class UsageError extends Error {}

const FLAGS = new Set(["--check-only", "--prepare-only"]);
const VALUE_FLAGS = new Set(["--deployment", "--explorer"]);

export async function main(argv: string[], env: Env = process.env, io: VerifyIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  const root = io.root ?? join(__dirname, "..", "..");
  try {
    const args: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i] as string;
      if (FLAGS.has(flag)) args[flag.slice(2)] = true;
      else if (VALUE_FLAGS.has(flag)) {
        const v = argv[++i];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
        args[flag.slice(2)] = v;
      } else throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
    }
    const network = env.SLUICE_NETWORK?.trim();
    if (network !== "mainnet" && network !== "testnet") throw new UsageError("set SLUICE_NETWORK to mainnet or testnet");
    const submit = !args["check-only"] && !args["prepare-only"];
    if (submit && env.SLUICE_APPROVE?.trim() !== "verify") throw new UsageError('submitting posts the source to the explorer, so it needs SLUICE_APPROVE=verify (or use --check-only or --prepare-only)');

    const file = typeof args.deployment === "string" ? args.deployment : join(root, "deployment.json");
    if (!existsSync(file)) throw new UsageError("the deployment file was not found: run scripts/live/deploy.ts first, or give --deployment");
    const deployment = JSON.parse(readFileSync(file, "utf8")) as { network?: string; router?: string; vault?: string; hash?: string };
    if (deployment.network !== network) throw new UsageError(`the deployment is on ${String(deployment.network)}, but SLUICE_NETWORK is ${network}`);
    let router: string;
    let vault: string;
    try {
      router = getAddress(String(deployment.router));
      vault = getAddress(String(deployment.vault));
    } catch {
      throw new UsageError("the deployment file has no router and vault addresses");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(deployment.hash))) throw new UsageError("the deployment file has no deployment transaction hash");

    const explorer = (typeof args.explorer === "string" ? args.explorer : undefined) ?? env.SLUICE_EXPLORER_URL?.trim() ?? (network === "mainnet" ? "https://mainnet.qie.digital" : undefined);
    if (!explorer) throw new UsageError("--explorer is needed: there is no default explorer for this network");

    // The constructor arguments come from the deployment's own data, read back from the chain.
    const rpcUrls = env.SLUICE_RPC_URL?.trim() ? [env.SLUICE_RPC_URL.trim()] : [1, 2, 3, 4, 5].map((n) => `https://rpc${n}${network}.qie.digital/`);
    const rpc = io.rpc ?? recorderRpc(rpcUrls, io.fetchImpl);
    const tx = (await rpc("eth_getTransactionByHash", [deployment.hash])) as { input?: string; to?: string | null } | null;
    if (!tx || tx.to !== null || typeof tx.input !== "string") throw new VerifyError("the deployment transaction was not found on this network, or it did not create a contract");

    const contracts: Array<{ title: string; address: string; build: BuildInput; args: string }> = [];
    const routerBuild = buildInput(root, "contracts/PaymentRouter.sol", "PaymentRouter");
    contracts.push({ title: "PaymentRouter", address: router, build: routerBuild, args: constructorArguments(tx.input, routerBuild.creationBytecode) });
    contracts.push({ title: "AgentVault", address: vault, build: buildInput(root, "contracts/AgentVault.sol", "AgentVault"), args: vaultConstructorArguments(router) });

    // Everything the manual route needs, written first.
    const out = join(root, "artifacts", "verification");
    mkdirSync(out, { recursive: true });
    log(`settings for the explorer, if you verify by hand: compiler ${contracts[0]?.build.compilerVersion}, optimization on, ${EXPECTED.optimizerRuns} runs, EVM version ${EXPECTED.evmVersion}, licence MIT`);
    for (const c of contracts) {
      writeFileSync(join(out, `${c.title}.standard-input.json`), JSON.stringify(c.build.input, null, 2));
      writeFileSync(join(out, `${c.title}.flat.sol`), flatten(c.build.input.sources, c.build.path));
      writeFileSync(join(out, `${c.title}.constructor-arguments.txt`), `${c.args}\n`);
      log(`${c.title} at ${c.address}: contract name ${c.build.path}:${c.build.name}; constructor arguments (hex, no 0x) ${c.args.length === 0 ? "(none)" : `${c.args.slice(0, 20)}…(${c.args.length / 2} bytes)`}`);
      log(`  wrote artifacts/verification/${c.title}.standard-input.json, ${c.title}.flat.sol and ${c.title}.constructor-arguments.txt`);
    }
    if (args["prepare-only"]) {
      log("prepared. To verify by hand, follow the manual steps in docs/MAINNET-RUNBOOK.md with these files.");
      return 0;
    }

    // What the explorer says now: a read, with GET only.
    const shows = explorerVerifiedFor(explorer, io.fetchImpl);
    const state = new Map<string, boolean>();
    for (const c of contracts) state.set(c.title, await shows(c.address));
    for (const c of contracts) log(`explorer: ${c.title} ${state.get(c.title) ? "shows verified source" : "does not show verified source"}`);
    if (args["check-only"]) return contracts.every((c) => state.get(c.title)) ? 0 : 1;

    let unreachable = false;
    for (const c of contracts) {
      if (state.get(c.title)) continue;
      const result = await submitVerification({ base: explorer, address: c.address, build: c.build, constructorArgs: c.args }, { fetchImpl: io.fetchImpl, ...io.submit });
      log(`submitted ${c.title}: ${result.state}: ${result.detail}`);
      if (result.state === "unreachable") unreachable = true;
      // The explorer's word for it, read separately: a submission that says it passed is not enough.
      state.set(c.title, await shows(c.address));
      log(`explorer: ${c.title} ${state.get(c.title) ? "now shows verified source" : "still does not show verified source"}`);
    }
    if (contracts.every((c) => state.get(c.title))) return 0;
    if (unreachable) {
      log("the explorer could not be reached to finish. Use the manual steps in docs/MAINNET-RUNBOOK.md with the files in artifacts/verification/, then run this script with --check-only.");
      return 2;
    }
    return 1;
  } catch (err) {
    if (err instanceof UsageError || err instanceof VerifyError) {
      log(`refused: ${err.message}`);
      return 1;
    }
    if (err instanceof NetworkError || err instanceof RpcRefused) {
      log("the chain could not be read, so nothing was prepared or submitted.");
      return 2;
    }
    log("the verification script failed to run.");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error("live:verify failed");
      process.exit(1);
    },
  );
}
