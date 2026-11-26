// pnpm mainnet:dryrun: the mainnet scripts, run in the order the founder will run them, on a LOCAL FORK of QIE mainnet. Nothing is sent to
// mainnet or to any network: the fork lives in this process, the keys are made here and thrown away, and QUSDC is minted on the fork only.
//
// What is real: the scripts, their flags, their guards, the real QUSDC contract's code and state as the fork read them, the compiled router
// and vault, the facilitator and the tool server as separate processes started from the settings files `live:wire` wrote, the proxy, the
// recorder, and the checks. What is not: the chain (a copy held in memory), the explorer (none), the clock (moved up to the wall clock),
// every key and every balance. The only setting that differs from the founder's is SLUICE_RPC_URL, which names the fork.
//
// It writes docs/MAINNET-DRYRUN-LOG.md: each command, what it printed, the gas each step measured against docs/GAS.md, and what the run
// cannot show. It writes nothing else in the repository (docs/EVIDENCE.md is copied, and the copy is what the recorder writes to).
//
//   pnpm mainnet:dryrun            (needs pnpm build first; reads QIE's public RPC read-only to make the fork)
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Contract, Wallet, getAddress, hexlify, randomBytes } from "ethers";
import { ethers, network } from "hardhat";
import { cutSecrets, toolIdOf } from "@sluice/sdk";
import { MEASURED_GAS, SMOKE_STEPS_GAS } from "../src/gas-figures";
import { DEFAULT_PAYER_QUSDC, addressOfKeyFileText, buildSteps } from "../src/golive-plan";
import { QUSDC_ADDRESS, formatQie } from "../src/guard";
import { formatQusdc } from "../src/units";
import { parseEnvFile } from "../src/wire";
import { spawnFacilitator } from "../test/helpers/chaos";
import { mintQusdc } from "../test/helpers/fork";
import { spawnToolServer } from "../test/helpers/remote";
import { ROOT, inheritedEnv, tsCommand } from "../test/helpers/spawn";
import { setQie, startRpc } from "../test/helpers/stack";

const LOG_PATH = join(ROOT, "docs", "MAINNET-DRYRUN-LOG.md");
const QUSDC = getAddress(QUSDC_ADDRESS);

type Step = { n: number; title: string; founder: string[]; ranAs: string; code: number; output: string; notes: string[] };

const secrets: string[] = [];
const keyed = (): Wallet => {
  const w = new Wallet(hexlify(randomBytes(32)));
  secrets.push(w.privateKey);
  return w;
};
const say = (line: string): void => void process.stderr.write(`${line}\n`);

/** Long output is cut to its head and tail, so the log stays readable and says it did so. */
function trim(text: string, maxLines = 60): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text.trimEnd();
  const head = lines.slice(0, Math.floor(maxLines * 0.6));
  const tail = lines.slice(lines.length - Math.floor(maxLines * 0.35));
  return [...head, `… (${lines.length - head.length - tail.length} lines cut here)`, ...tail].join("\n").trimEnd();
}

/**
 * A path on this machine says whose machine it is, and the log is a document in a repository. Every path is replaced by a name for what it
 * is, in the two forms a Windows path takes in output (single and doubled backslashes, and forward slashes).
 */
function scrub(text: string, work: string): string {
  const forms = (path: string): string[] => [path, path.split("\\").join("\\\\"), path.split("\\").join("/")];
  let out = text;
  for (const [path, name] of [[work, "<run folder>"], [ROOT, "<repo>"], [tmpdir(), "<temp>"], [homedir(), "<home>"]] as const) {
    for (const form of forms(path)) out = out.split(form).join(name);
  }
  return out;
}

async function exec(entry: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; text: string }> {
  const { command, args: commandArgs } = tsCommand(entry, args);
  // The script runs in a folder of its own, so that deployment.json and the other files it writes never land in the repository. The loaders
  // it needs are found through NODE_PATH and TS_NODE_PROJECT, because the folder has no node_modules or tsconfig.json of its own.
  const where = { NODE_PATH: join(ROOT, "node_modules"), TS_NODE_PROJECT: join(ROOT, "tsconfig.json") };
  const child = spawn(command, commandArgs, { cwd, env: { ...inheritedEnv(), ...where, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout?.on("data", (c: Buffer) => (text += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (text += c.toString("utf8")));
  const timer = setTimeout(() => child.kill("SIGKILL"), 8 * 60_000);
  const code = await new Promise<number>((resolve) => child.once("exit", (c) => resolve(c ?? 1)));
  clearTimeout(timer);
  return { code, text: scrub(cutSecrets(text, secrets), cwd) };
}

/** A local stand-in for the explorer, so that the pre-flight check's reachability read does not leave this machine. */
async function standInExplorer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * The address of one of the founder's real key files in the repository folder, if it is there. The key is read to learn the address and is
 * not kept: this run never signs with a real key, because a transaction signed for chain 1990 on a fork could be replayed on mainnet.
 */
function realAddress(file: string): string | undefined {
  try {
    return addressOfKeyFileText(readFileSync(join(ROOT, file), "utf8"), file);
  } catch {
    return undefined;
  }
}

/** The `$env:NAME = "value"` assignments of the plan's PowerShell lines. A value read from a key file is not here: the key is the run's own. */
function planAssignments(commands: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of commands) {
    for (const part of line.split(";")) {
      const m = /^\s*\$env:(\w+)\s*=\s*"([^"]*)"\s*$/.exec(part);
      if (m && m[1] !== "SLUICE_FACILITATOR_URL") out[m[1] as string] = m[2] as string;
    }
  }
  return out;
}

const pct = (a: bigint, b: bigint): string => (b === 0n ? "n/a" : `${((Number(a - b) / Number(b)) * 100).toFixed(1)}%`);
const withCommas = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function main(): Promise<number> {
  if (process.env.FORK !== "1") {
    say("this runs on a fork of QIE mainnet: use `pnpm mainnet:dryrun`, which sets FORK=1");
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "sluice-dryrun-"));
  const steps: Step[] = [];
  const gas: Array<{ step: string; hash: string; figure?: bigint; note?: string }> = [];
  const rpc = await startRpc();
  const explorer = await standInExplorer();
  let facilitator: Awaited<ReturnType<typeof spawnFacilitator>> | undefined;
  let tools: Awaited<ReturnType<typeof spawnToolServer>> | undefined;
  let failed = false;
  try {
    // ------------------------------------------------------------------------------------------- the fork, its clock and the keys
    const wall = Math.floor(Date.now() / 1000);
    const head = (await network.provider.send("eth_getBlockByNumber", ["latest", false])) as { number: string; timestamp: string };
    const forkedAt = Number(BigInt(head.number));
    if (Number(BigInt(head.timestamp)) < wall) await network.provider.send("evm_setNextBlockTimestamp", [wall]);
    await network.provider.send("evm_mine", []);
    const chainId = Number(BigInt(await network.provider.send("eth_chainId", [])));
    say(`forked QIE mainnet at block ${forkedAt} (chain ${chainId}); serving it at ${rpc.url}`);

    const deployer = keyed();
    const relayer = keyed();
    const payer = keyed(); // the owner of the funded run: holds QUSDC, starts with no QIE
    const builder = keyed(); // the payee: earns, and withdraws with no QIE
    const agent = keyed();
    const routerOwner = getAddress(hexlify(randomBytes(20))); // stands in for the multisig: an address, no key
    const feeRecipient = getAddress(hexlify(randomBytes(20)));
    // The funding is the founder's real funding, as the fork read it: the fork is a copy of mainnet, so the real deployer's and relayer's
    // addresses hold there what they hold on mainnet. Their holdings are given to this run's throwaway keys, when they are enough for a
    // run from the start. Once the real deploy and smoke run have been made on mainnet, the real deployer holds less than a fresh smoke
    // run deposits (the fee stays with the router), and where an address holds nothing yet, or too little, the amounts the plan expects
    // (0.05 QIE and 0.3 QUSDC; 0.1 QIE) are used instead, and the log says so.
    const realDeployer = realAddress("deployer-mainnet.key");
    const realRelayer = realAddress("relayer-mainnet.key");
    const erc20 = new Contract(QUSDC, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
    const holdingsOf = async (who: string | undefined): Promise<{ qie: bigint; qusdc: bigint }> =>
      who ? { qie: BigInt(await network.provider.send("eth_getBalance", [who, "latest"])), qusdc: (await erc20.getFunction("balanceOf")(who)) as bigint } : { qie: 0n, qusdc: 0n };
    const realD = await holdingsOf(realDeployer);
    const realR = await holdingsOf(realRelayer);
    // Enough for a run from the start: the smoke run's 0.3 QUSDC and QIE for the deploy and the smoke run with room (about 0.006 at
    // 1.7 gwei), and for the relayer well above the pre-flight check's floor (about 0.019).
    const deployerEnough = realD.qusdc >= DEFAULT_PAYER_QUSDC && realD.qie >= 2n * 10n ** 16n;
    const relayerEnough = realR.qie >= 3n * 10n ** 16n;
    const fund = {
      deployerQie: deployerEnough ? realD.qie : 5n * 10n ** 16n,
      deployerQusdc: deployerEnough ? realD.qusdc : DEFAULT_PAYER_QUSDC,
      relayerQie: relayerEnough ? realR.qie : 10n ** 17n,
      payerQusdc: DEFAULT_PAYER_QUSDC,
      deployerFromChain: deployerEnough,
      relayerFromChain: relayerEnough,
    };
    await setQie(deployer.address, fund.deployerQie);
    await mintQusdc(deployer.address, fund.deployerQusdc);
    await setQie(relayer.address, fund.relayerQie);
    await mintQusdc(payer.address, fund.payerQusdc); // the payer's QUSDC, and no QIE: the start with no QIE is what is proven
    await setQie(payer.address, 0n);
    await setQie(builder.address, 0n);

    const base = { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: rpc.url, SLUICE_EXPLORER_URL: explorer.url } as Record<string, string>;
    const ps = (v: string): string => v; // the founder's PowerShell lines are shown as written in the runbook
    let n = 0;
    const run = async (title: string, founder: string[], entry: string, args: string[], env: Record<string, string>, notes: string[] = [], expect: number | "any" = 0): Promise<{ code: number; text: string }> => {
      n += 1;
      say(`step ${n}: ${title}`);
      const r = await exec(entry, args, { ...base, ...env }, work);
      steps.push({ n, title, founder, ranAs: scrub(`${entry} ${args.join(" ")}`.trim(), work), code: r.code, output: r.text, notes });
      if (expect !== "any" && r.code !== expect) {
        failed = true;
        say(`  UNEXPECTED exit ${r.code} (wanted ${expect}); output:\n${trim(r.text, 30)}`);
        throw new Error(`step ${n} (${title}) ended with ${r.code}`);
      }
      return r;
    };

    // ------------------------------------------------------------------------------------------------ the go-live plan, and what it sets
    // The plan's own commands are what the later steps run: the settings and the caps below are read out of the plan's PowerShell lines, so the
    // caps that the founder will type are the caps this run works under.
    const at: Record<string, number> = {};
    const roles = { deployer: deployer.address, relayer: relayer.address, owner: routerOwner, feeRecipient, payer: payer.address };
    const gasPrice = BigInt(await network.provider.send("eth_gasPrice", []));
    const planned = buildSteps(roles, { gasPrice, payerQusdc: fund.payerQusdc });
    const planStep = (title: string): (typeof planned)[number] => {
      const found = planned.find((p) => p.title.startsWith(title));
      if (!found) throw new Error(`the plan has no step that starts "${title}"`);
      return found;
    };
    const planArgs = ["--owner", routerOwner, "--fee-recipient", feeRecipient, "--payer", payer.address];
    const planFounder = [ps(`$env:SLUICE_NETWORK = "mainnet"`), ps("pnpm live:golive:plan --owner 0xOwner --fee-recipient 0xFeeRecipient --payer 0xPayer")];
    await run(
      "The go-live plan, for the real deployer and relayer and three new addresses",
      planFounder,
      "scripts/live/golive-plan.ts", [...planArgs, "--deployer", realDeployer ?? deployer.address, "--relayer", realRelayer ?? relayer.address], {},
      [
        realDeployer && realRelayer
          ? "The deployer and the relayer here are the founder's real addresses (the command reads them from the key files in the repository folder; here they are given, because this run's folder holds no key files). The owner, the fee recipient and the payer are three addresses made for this run, with no key kept. The fork holds what mainnet holds at those addresses, so the lines about their balances are what the founder's own run would say. Nothing was sent."
          : "No key files were found in the repository folder, so the deployer and the relayer here are this run's own. The owner, the fee recipient and the payer are three addresses made for this run. Nothing was sent.",
      ],
    );
    at.planReal = n;
    await run("The go-live plan, for this run's own five addresses", planFounder, "scripts/live/golive-plan.ts", [...planArgs, "--deployer", deployer.address, "--relayer", relayer.address], {}, [
      "The commands in this plan are the ones the rest of this log runs, with the settings and the caps it prints. Each plan step is accounted for in the table at the end.",
    ]);
    at.planOwn = n;

    await run("Read QUSDC's facts again", [ps("pnpm live:facts")], "scripts/live/facts.ts", [], {}, ["Read-only. It reads the real token's state as the fork copied it, so what it says is what RISKS.md says on the day the fork was made."]);
    at.facts = n;

    // ------------------------------------------------------------------------------------------------- preflight, before the deploy
    const addrs = ["--deployer", deployer.address, "--relayer", relayer.address];
    await run(
      "The read-only pre-flight check, before the deploy",
      [ps(planStep("Choose the network").commands[0] as string), ...planStep("Run the pre-flight check").commands.map(ps)],
      "scripts/live/preflight.ts", addrs, {},
      ["Expect GO. Here the fork is the node, so only the RPC line differs from a real run, and the explorer is a local stand-in. The QUSDC roles line reads the real token's state as the fork copied it. The relayer holds less than a day's budget, as the founder's does, so a WARN about it is expected and does not stop the run."],
    );
    at.preflight1 = n;

    // ------------------------------------------------------------------------------------------------------------------- the deploy
    const deployEnv = { ...planAssignments(planStep("Set the deploy settings and the caps").commands), SLUICE_KEY: deployer.privateKey };
    const deployFounder = [ps(planStep("Choose the network").commands[0] as string), ...planStep("Set the deploy settings and the caps").commands.map(ps)];
    await run("Dry-run the deploy", [...deployFounder, ps("pnpm exec ts-node scripts/live/deploy.ts --dry-run")], "scripts/live/deploy.ts", ["--dry-run"], deployEnv, ["Sends nothing. Expect the plan fits."]);
    at.deployDry = n;
    // The guards, shown refusing, before the real deploy: each is a command the founder could mistype.
    await run("A deploy that names the deployer as the owner is refused", [ps(`$env:SLUICE_OWNER = <the deployer's own address>`), ps("pnpm exec ts-node scripts/live/deploy.ts")], "scripts/live/deploy.ts", [], { ...deployEnv, SLUICE_OWNER: deployer.address }, ["Refused before any connection is made."], 1);
    await run("A mistyped option is refused, not ignored", [ps("pnpm exec ts-node scripts/live/deploy.ts --dry-ruun")], "scripts/live/deploy.ts", ["--dry-ruun"], deployEnv, ["Refused: a mistyped --dry-run must never become a real deployment."], 1);
    const dep = await run("Deploy", [...deployFounder, ps("pnpm exec ts-node scripts/live/deploy.ts")], "scripts/live/deploy.ts", [], deployEnv, ["Writes deployment.json in this run's folder (the founder's is the repository root)."]);
    at.deploy = n;
    const deployment = JSON.parse(readFileSync(join(work, "deployment.json"), "utf8")) as { router: string; vault: string; hash: string; block: number; token: string };
    const router = getAddress(deployment.router);
    gas.push({ step: "Deploy the router (creates the vault)", hash: deployment.hash, figure: MEASURED_GAS.deployRouter });
    if (getAddress(deployment.token) !== QUSDC) throw new Error("the router does not hold QUSDC");

    // --------------------------------------------------------------------------------------- record the deploy, wire, pre-flight again
    const evidence = join(work, "EVIDENCE.copy.md");
    copyFileSync(join(ROOT, "docs", "EVIDENCE.md"), evidence);
    const forkFlags = ["--network", "fork", "--rpc", rpc.url, "--file", evidence];
    const founderRecord = (claim: string, tx: string, extra = ""): string => `pnpm evidence:record --claim ${claim} --tx ${tx} --network mainnet${extra}`;
    const record = async (claim: string, tx: string, extra: string[] = [], note = ""): Promise<void> => {
      await run(`Record a ${claim} claim`, [ps(founderRecord(claim, "0xTheTransactionHash", extra.length ? ` ${extra.join(" ")}` : ""))], "scripts/evidence/record.ts", ["--claim", claim, "--tx", tx, ...extra, ...forkFlags], {}, [
        "On mainnet there is no --rpc, --file or fork: the command reads QIE's endpoints and writes docs/EVIDENCE.md. Here it reads the fork and writes the copy, under a Fork heading that nothing counts." + (note ? ` ${note}` : ""),
      ]);
    };
    await record("deploy", deployment.hash);
    at.recordDeploy = n;

    await run("Wire the deployment into the settings files", [ps("pnpm live:wire --network mainnet")], "scripts/live/wire.ts", ["--network", "mainnet"], {}, ["Writes .env.mainnet.facilitator, .env.mainnet.tool-server and .env.mainnet.web next to deployment.json. No key is written."]);
    at.wire = n;
    const facilitatorFile = parseEnvFile(readFileSync(join(work, ".env.mainnet.facilitator"), "utf8"));
    const toolsFile = parseEnvFile(readFileSync(join(work, ".env.mainnet.tool-server"), "utf8"));

    await run(
      "Pre-flight again, with the deployment record",
      planStep("Run the pre-flight check again").commands.map((c) => ps(c.replace("$d.router", `"${router}"`))),
      "scripts/live/preflight.ts", [...addrs, "--deployment", "deployment.json"], { SLUICE_ROUTER: router },
      ["Expect GO and `Deployed code ... match the deployment record`. The plan's first line here reads the router from deployment.json; the run's own router is written in its place."],
    );
    at.preflight2 = n;

    // The vault: the router's constructor creates it, so its code is compared with the compiled AgentVault, which needs no explorer.
    await run(
      "Compare the vault's code with the compiled AgentVault",
      planStep("Compare the vault's code").commands.map(ps),
      "scripts/live/vaultcheck.ts", [], { SLUICE_ROUTER: router },
      ["Read-only. It reads the vault's address from the router, the code at that address from the fork, and compares it with the compiled AgentVault with its six immutables filled in. It also compares the code's hash with the one deployment.json recorded. No explorer is asked."],
    );
    at.vaultcheck = n;

    // -------------------------------------------------------------------------------------------------------------- the smoke run
    const smokeEnv = { ...planAssignments(planStep("Set the smoke run").commands), SLUICE_KEY: deployer.privateKey, SLUICE_ROUTER: router };
    await run("Dry-run the smoke run", [...planStep("Set the smoke run").commands.map(ps)], "scripts/live/smoke.ts", ["--dry-run"], smokeEnv, ["Sends nothing. Eight steps, each decoded. The caps are the ones the plan prints."]);
    at.smokeDry = n;
    const smoke = await run("The smoke run", [ps("pnpm exec ts-node scripts/live/smoke.ts")], "scripts/live/smoke.ts", [], smokeEnv, ["Moves 0.3 QUSDC in and takes nearly all of it back. The deployer holds exactly the QUSDC the founder's holds, so a smoke run that needed more would stop here."]);
    at.smoke = n;
    const hashOf = (label: string): string => new RegExp(`^${label.replace(/[()]/g, "\\$&")}: (0x[0-9a-f]{64}) in block`, "m").exec(smoke.text)?.[1] ?? "";
    for (const [label, figure] of SMOKE_STEPS_GAS) gas.push({ step: `smoke: ${label}`, hash: hashOf(label), figure });
    await record("deposit", hashOf("deposit"), ["--router", router]);
    await record("withdraw", hashOf("withdraw"), ["--router", router]);
    at.recordSmoke = n;

    // ----------------------------------------------------------------------------------- the facilitator and the tool server, as processes
    const hostSecrets = { SLUICE_APPROVE: "facilitator", SLUICE_RELAYER_KEY: relayer.privateKey };
    const metricsToken = hexlify(randomBytes(24)).slice(2);
    secrets.push(metricsToken);
    facilitator = await spawnFacilitator({
      ...facilitatorFile, ...hostSecrets, ...base,
      SLUICE_FACILITATOR_STATE: join(work, "queue.jsonl"), SLUICE_FACILITATOR_CORS_ORIGINS: "http://127.0.0.1:3000", SLUICE_FACILITATOR_METRICS_TOKEN: metricsToken,
      SLUICE_FACILITATOR_PORT: "0", SLUICE_FACILITATOR_FLUSH_MS: "500",
    });
    const facilitatorUrl = `http://127.0.0.1:${facilitator.port}`;
    tools = await spawnToolServer({
      ...toolsFile, ...base, SLUICE_PAYEE: builder.address, SLUICE_FACILITATOR_URL: facilitatorUrl, SLUICE_TOOLS_CORS_ORIGINS: "http://127.0.0.1:3000",
      SLUICE_EXPLORER_URL: "http://127.0.0.1:9", // no explorer: the tools say role holders are unavailable instead of guessing
      // A fork fetches state from mainnet on a contract's initial use, which can take longer than the tool server's default limit of
      // ten seconds for one read. Raised for this run only; the default stays as it is.
      SLUICE_TOOLS_RPC_TIMEOUT_MS: "60000",
    });
    const health = (await (await fetch(`${facilitatorUrl}/health`)).json()) as Record<string, unknown>;
    const toolHealth = await fetch(`${tools.url}/health`);
    steps.push({
      n: ++n, title: "Start the facilitator and the tool server from the settings files", founder: ["(on the host; see docs/DEPLOY-FACILITATOR.md and docs/DEPLOY-TOOL-SERVER.md)"], ranAs: "packages/facilitator/src/cli.ts, examples/paid-tools/src/cli.ts --http 0", code: 0,
      output: `facilitator listening on ${facilitatorUrl}; tool server listening on ${tools.url}\nfacilitator /health: ${JSON.stringify({ ok: health.ok, chainId: health.chainId, router: health.router, killSwitch: health.killSwitch, lowBalance: health.lowBalance, relayerBalanceWei: health.relayerBalanceWei, queued: health.queued })}\ntool server /health: HTTP ${toolHealth.status}`,
      notes: [
        "Both started with SLUICE_NETWORK=mainnet from the files `live:wire` wrote (the values it left empty were filled in), with SLUICE_APPROVE=facilitator and the relayer key given as the host would. The RPC is the fork. The tool server's limit on one RPC read was raised from ten seconds to sixty for this run: a fork fetches a contract's state from mainnet on initial use, and an early read was slow enough to hit the default.",
        `The relayer holds ${formatQie(fund.relayerQie)} QIE here, as the founder's does, which is below the 0.5 QIE of a day's budget. \`lowBalance\` is therefore ${String(health.lowBalance)}, and the facilitator raises its low_balance alert: that is the expected warning, and it does not stop the facilitator from settling. The plan says the same.`,
      ],
    });
    at.host = n;

    // ------------------------------------------------------------------------------------------------------------- the funded run
    // The payer's settings are the plan's: its caps, and the amount of the start.
    const startAmount = formatQusdc(fund.payerQusdc);
    const ownerEnv = (key: string): Record<string, string> => ({ ...planAssignments(planStep("The payer starts").commands), SLUICE_KEY: key, SLUICE_ROUTER: router, SLUICE_FACILITATOR_URL: facilitatorUrl });
    const start = await run(
      "The payer, with QUSDC and no QIE, starts through the facilitator",
      [...planStep("The payer starts").commands.map(ps)],
      "scripts/client/owner-setup.ts", ["start", "--amount", startAmount], ownerEnv(payer.privateKey),
      ["The payer signs two transactions and sends nothing; the facilitator tops the wallet up with exactly the QIE they can use, and broadcasts both. The payer holds no QIE before and none of its own after. The caps are the plan's: the QUSDC cap is the amount, and the payer's own QIE cap is the smallest there is."],
    );
    at.start = n;
    const topUp = /top-up from the facilitator: (0x[0-9a-f]{64})/.exec(start.text)?.[1] ?? "";
    const approveTx = /approval: (0x[0-9a-f]{64})/.exec(start.text)?.[1] ?? "";
    const depositTx = /deposit:\s+(0x[0-9a-f]{64})/.exec(start.text)?.[1] ?? "";
    gas.push({ step: "onboarding: QIE top-up transfer by the facilitator", hash: topUp, figure: MEASURED_GAS.topUpTransfer });
    gas.push({ step: "onboarding: approve (sent by the facilitator)", hash: approveTx, figure: MEASURED_GAS.approve });
    gas.push({ step: "onboarding: first deposit (sent by the facilitator)", hash: depositTx, figure: MEASURED_GAS.depositFirst });
    const auth = await run(
      "The owner authorises an agent key, by signature",
      [ps("pnpm client:owner authorize --agent 0xAgentAddress --budget 0.2 --per-call 0.02 --days 7 --tool dex_quote=0xBuildersAddress --tool token_risk_check=0xBuildersAddress")],
      "scripts/client/owner-setup.ts",
      ["authorize", "--agent", agent.address, "--budget", "0.2", "--per-call", "0.02", "--days", "7", "--tool", `dex_quote=${builder.address}`, "--tool", `token_risk_check=${builder.address}`],
      ownerEnv(payer.privateKey),
    );
    gas.push({ step: "authorize an agent by signature (sent by the facilitator)", hash: /authorised: (0x[0-9a-f]{64})/.exec(auth.text)?.[1] ?? "", figure: MEASURED_GAS.authorizeBySig });
    await record("relayed-start", depositTx, ["--topup", topUp, "--router", router], "A relayed start: the deposit's hash and the facilitator's top-up hash.");
    at.recordStart = n;

    const expiresAt = new Date((wall + 6 * 86_400) * 1000).toISOString();
    writeFileSync(
      join(work, "sluice.config.json"),
      JSON.stringify({
        upstream: { url: `${tools.url}/mcp` }, router, payer: payer.address, asset: QUSDC, rpcUrl: rpc.url,
        budget: { perCallCap: "0.02", totalCap: "0.2", expiresAt, allowedTools: [{ tool: "dex_quote", payee: builder.address }, { tool: "token_risk_check", payee: builder.address }] },
        logFile: "payments.jsonl", stateFile: "budget.json",
      }),
    );
    const call = async (title: string, tool: string, args: Record<string, string>): Promise<void> => {
      await run(
        title,
        [ps(`$env:SLUICE_AGENT_KEY = (Get-Content .\\agent.key -Raw).Trim(); pnpm client:smoke --config sluice.config.json --tool ${tool} ${Object.entries(args).map(([k, v]) => `--arg ${k}=${v}`).join(" ")}`)],
        "scripts/client/smoke-client.ts", ["--config", "sluice.config.json", "--tool", tool, ...Object.entries(args).flatMap(([k, v]) => ["--arg", `${k}=${v}`])], { SLUICE_AGENT_KEY: agent.privateKey },
        ["The scripted MCP client starts the payment proxy, which pays the tool server inside the budget. The tool server queues the payment with the facilitator."],
      );
    };
    await call("Paid call 1 of 3, on dex_quote", "dex_quote", { tokenIn: "QIE", tokenOut: QUSDC, amountIn: "1" });
    await call("Paid call 2 of 3, on token_risk_check", "token_risk_check", { address: QUSDC });
    await call("Paid call 3 of 3, on dex_quote", "dex_quote", { tokenIn: "QIE", tokenOut: QUSDC, amountIn: "10" });

    // The facilitator settles in batches: wait until the router shows three Settled events for the payer.
    const routerContract = new Contract(router, ["event Settled(address indexed payer,address indexed payee,bytes32 indexed toolId,uint256 amount,uint256 fee,bytes32 nonce,address submitter)", "function earnings(address) view returns (uint256)", "function payerBalance(address) view returns (uint256)", "function solvency() view returns (uint256,uint256)"], ethers.provider);
    let settled: Array<{ transactionHash: string; args: { toolId: string } }> = [];
    for (let i = 0; i < 240 && settled.length < 3; i++) {
      settled = (await routerContract.queryFilter(((routerContract.filters as unknown as Record<string, (p: string) => never>).Settled as (p: string) => never)(payer.address), deployment.block)) as unknown as Array<{ transactionHash: string; args: { toolId: string } }>;
      if (settled.length < 3) await new Promise((r) => setTimeout(r, 500));
    }
    if (settled.length < 3) throw new Error(`only ${settled.length} of 3 payments settled`);
    const batches = [...new Set(settled.map((e) => e.transactionHash))];
    const metrics = await (await fetch(`${facilitatorUrl}/internal/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } })).text();
    const unauth = (await fetch(`${facilitatorUrl}/internal/metrics`)).status;
    steps.push({
      n: ++n, title: "The facilitator settles the three payments in a batch", founder: ["(the facilitator does this on its own; read /health and /status/<id>, and the private metrics path)"], ranAs: "facilitator", code: 0,
      output: [`${settled.length} Settled events in ${batches.length} transaction(s): ${batches.join(", ")}`, `/internal/metrics without the token: HTTP ${unauth}; with it: ${metrics.split("\n").filter((l) => l.startsWith("sluice_facilitator_") && !l.startsWith("#")).slice(0, 8).join(" | ")}`].join("\n"),
      notes: ["The batch is sent by the relayer, which paid the gas, not the payer or the builder."],
    });
    batches.forEach((hash, i) => gas.push({ step: `batch settle (${settled.filter((e) => e.transactionHash === hash).length} intents, one payer, one builder)${batches.length > 1 ? ` #${i + 1}` : ""}`, hash, note: "GAS.md measures batches of 1 (111,208) and 10 (454,831) for one payer and one builder" }));
    // Each tool's claim names a batch that holds a payment for that tool (the three calls may have been settled together or apart).
    for (const tool of ["dex_quote", "token_risk_check"]) {
      const batch = settled.find((e) => e.args.toolId.toLowerCase() === toolIdOf(tool).toLowerCase())?.transactionHash;
      if (!batch) throw new Error(`no settled payment for ${tool}`);
      await record("paid-call-settlement", batch, ["--router", router, "--tool", tool]);
    }
    await record("settle-batch", batches[0] as string, ["--router", router]);

    // ----------------------------------------------------------------------------------------------------------------- the exits
    const earned = (await routerContract.getFunction("earnings")(builder.address)) as bigint;
    const bw = await run(
      "The builder, with no QIE, withdraws its earnings by signature",
      [ps(`$env:SLUICE_KEY = (Get-Content .\\builder.key -Raw).Trim(); pnpm client:owner withdraw --amount ${formatQusdc(earned)}`)],
      "scripts/client/owner-setup.ts", ["withdraw", "--amount", formatQusdc(earned)], ownerEnv(builder.privateKey),
      ["The builder signs; the facilitator submits and pays the gas."],
    );
    const withdrawTx = /withdrawn: (0x[0-9a-f]{64})/.exec(bw.text)?.[1] ?? "";
    gas.push({ step: "withdraw by signature (sent by the facilitator)", hash: withdrawTx, figure: MEASURED_GAS.withdrawBySig });
    await record("withdraw", withdrawTx, ["--router", router]);
    const left = (await routerContract.getFunction("payerBalance")(payer.address)) as bigint;
    const refund = await run(
      "The owner takes back the unspent balance, by signature",
      [ps(`pnpm client:owner refund --amount ${formatQusdc(left)}`)],
      "scripts/client/owner-setup.ts", ["refund", "--amount", formatQusdc(left)], ownerEnv(payer.privateKey),
      ["The payer signs; the facilitator submits and pays the gas."],
    );
    const refundTx = /refunded: (0x[0-9a-f]{64})/.exec(refund.text)?.[1] ?? "";
    gas.push({ step: "refund by signature (sent by the facilitator)", hash: refundTx, figure: MEASURED_GAS.refundBySig });
    await record("refund", refundTx, ["--router", router]);

    // -------------------------------------------------------------------------------------------------------- check and count the copy
    const finalPass = { EVIDENCE_RPC_URL: rpc.url };
    await run("Check every recorded row against the chain again", [ps("pnpm evidence:check")], "scripts/evidence-check.ts", ["--file", evidence, "--fork"], finalPass, ["On mainnet the command takes no flags and reads docs/EVIDENCE.md. --file and --fork point it at the copy and the fork."]);
    await run(
      "Count paid calls and the recorded rows",
      [ps(`$env:SLUICE_ROUTER = "0xTheRouter"; $env:SLUICE_FROM_BLOCK = "<the deployment's block>"; pnpm evidence:summary`)],
      "scripts/evidence-summary.ts", ["--file", evidence, "--fork"], { ...finalPass, SLUICE_ROUTER: router, SLUICE_FROM_BLOCK: String(deployment.block) },
    );
    at.check = n;
    const [held, owed] = (await routerContract.getFunction("solvency")()) as [bigint, bigint];
    const solvency = `solvency() after the run: the router holds ${formatQusdc(held)} QUSDC and owes ${formatQusdc(owed)} QUSDC (${held >= owed ? "it holds at least what it owes" : "SHORT"})`;
    // What the funding was worth: the QIE each of the two funded addresses had at the start and has now, at the fork's gas price.
    const qieNow = async (who: string): Promise<bigint> => BigInt(await network.provider.send("eth_getBalance", [who, "latest"]));
    const dEnd = await qieNow(deployer.address);
    const rEnd = await qieNow(relayer.address);
    const topUpWei = BigInt(/top-up from the facilitator: 0x[0-9a-f]{64} \((\d+) wei\)/.exec(start.text)?.[1] ?? "0");
    const closing = [
      solvency,
      `QIE, at the fork's gas price of ${(Number(gasPrice) / 1e9).toFixed(3)} gwei (mainnet's differs): the deployer started with ${formatQie(fund.deployerQie)} and ended with ${formatQie(dEnd)}, so the deploy and the smoke run cost ${formatQie(fund.deployerQie - dEnd)}. The relayer started with ${formatQie(fund.relayerQie)} and ended with ${formatQie(rEnd)}: it paid ${formatQie(fund.relayerQie - rEnd)} for the whole funded run, ${formatQie(topUpWei)} of which was the top-up it sent the payer, and the rest gas. The payer sent no transaction of its own and started with no QIE.`,
    ].join("\n\n");

    // ------------------------------------------------------------------------------------------------------------------ gas, measured
    const rows: string[] = [];
    for (const g of gas) {
      if (!g.hash) {
        rows.push(`| ${g.step} | (no hash found in the output) | | | |`);
        continue;
      }
      const receipt = await ethers.provider.getTransactionReceipt(g.hash);
      const used = receipt?.gasUsed ?? 0n;
      rows.push(`| ${g.step} | ${withCommas(used)} | ${g.figure !== undefined ? withCommas(g.figure) : "see note"} | ${g.figure !== undefined ? pct(used, g.figure) : (g.note ?? "")} |`);
    }
    // Every step of the plan is accounted for: run here, or not run and why. The list is in the plan's order, and a plan step that has no entry
    // (or an entry out of order) stops the run, so the plan cannot grow a step that this run does not know about.
    const at2 = (a: number | undefined, b = ""): string => (a === undefined ? "NOT RUN" : `run, step ${a}${b}`);
    const coverage: Array<[string, string]> = [
      ["Choose the network", "the same settings are each step's environment here, with this run's own key"],
      ["Read QUSDC's facts", at2(at.facts)],
      ["Run the pre-flight check", at2(at.preflight1)],
      ["Set the deploy settings", `its settings and caps are the environment of steps ${at.deployDry} and ${at.deploy}`],
      ["Dry-run the deploy", at2(at.deployDry)],
      ["Deploy the router", at2(at.deploy)],
      ["Record the deployment", at2(at.recordDeploy)],
      ["Write the settings files", at2(at.wire)],
      ["Run the pre-flight check again", at2(at.preflight2)],
      ["Prepare the files for verification", "not run: a fork has no explorer"],
      ["Submit the router's source to the explorer", "not run: a fork has no explorer"],
      ["Check what the explorer shows", "not run: a fork has no explorer, so no verify-link row can be recorded"],
      ["Compare the vault's code", at2(at.vaultcheck)],
      ["Set the smoke run", at2(at.smokeDry)],
      ["Run the smoke run", at2(at.smoke)],
      ["Record the deposit and the withdrawal", at2(at.recordSmoke === undefined ? undefined : at.recordSmoke - 1, ` and step ${at.recordSmoke}`)],
      ["Host the facilitator", `run as two local processes started from the settings files, step ${at.host}`],
      ["Check the facilitator", `the facilitator's and the tool server's /health were read, step ${at.host}`],
      ["The payer starts", at2(at.start)],
      ["Record the start", at2(at.recordStart)],
      ["Check every recorded row", at2(at.check === undefined ? undefined : at.check - 1, ` and step ${at.check}`)],
      ["Clear the secrets", "not run: nothing was set in a session"],
    ];
    if (coverage.length !== planned.length || planned.some((p, i) => !p.title.startsWith((coverage[i] as [string, string])[0]))) {
      throw new Error("the plan's steps and this run's account of them no longer line up: update the list in scripts/mainnet-dryrun.ts");
    }
    if (coverage.some(([, status]) => status.includes("NOT RUN") || status.includes("undefined"))) throw new Error("a plan step that this run should have run was not run");
    const planTable = planned.map((p, i) => `| ${p.n} | ${p.title} | ${(coverage[i] as [string, string])[1]} |`);
    const doc = render({ steps, rows, forkedAt, router, deployment, closing, work, planTable, fund, mirror: { realDeployer, realRelayer, deployerHeld: realD, relayerHeld: realR }, finalFacts: { deployer: deployer.address, relayer: relayer.address, payer: payer.address, builder: builder.address, agent: agent.address, routerOwner, feeRecipient } });
    writeFileSync(LOG_PATH, doc);
    say(`wrote ${LOG_PATH}`);
    return failed ? 1 : 0;
  } catch (err) {
    say(`the dry run stopped: ${cutSecrets(err instanceof Error ? err.message : String(err), secrets)}`);
    if (steps.length > 0) writeFileSync(join(work, "partial-log.json"), cutSecrets(JSON.stringify(steps, null, 2), secrets));
    say(`what it had run is in ${join(work, "partial-log.json")}`);
    return 1;
  } finally {
    await tools?.stop().catch(() => undefined);
    await facilitator?.kill().catch(() => undefined);
    await explorer.close();
    await rpc.close();
    if (!failed) rmSync(work, { recursive: true, force: true });
  }
}

type RenderInput = {
  steps: Step[];
  rows: string[];
  forkedAt: number;
  router: string;
  deployment: { router: string; vault: string; hash: string; block: number };
  closing: string;
  work: string;
  finalFacts: Record<string, string>;
  /** Rows of the table that accounts for each step of the go-live plan. */
  planTable: string[];
  fund: { deployerQie: bigint; deployerQusdc: bigint; relayerQie: bigint; payerQusdc: bigint; deployerFromChain: boolean; relayerFromChain: boolean };
  mirror: { realDeployer?: string; realRelayer?: string; deployerHeld: { qie: bigint; qusdc: bigint }; relayerHeld: { qie: bigint; qusdc: bigint } };
};

function render(r: RenderInput): string {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const out: string[] = [];
  out.push("# Mainnet dry run: a FORK SIMULATION");
  out.push("");
  out.push(`**This is a simulation on a local fork of QIE mainnet, not a run on mainnet.** Nothing in it was sent to mainnet or to any network. It says nothing about how the real chain, the real explorer, the real public RPC endpoints or a real wallet behave. It shows that the scripts, their flags, their guards and the settings files work together, in the order the founder will run them.`);
  out.push("");
  out.push(`Generated by \`pnpm mainnet:dryrun\` on ${date}. The fork was made from QIE mainnet's state at block ${r.forkedAt} (read-only calls to the public RPC), and lives in memory only. Regenerate this file by running the command again; it is overwritten, not edited by hand.`);
  out.push("");
  out.push("## What is real and what is not");
  out.push("");
  out.push("| Real | Not real |");
  out.push("| --- | --- |");
  out.push("| The scripts and their flags, exactly as the runbook names them | The chain: a copy held in memory, whose blocks are made on demand |");
  out.push("| The real QUSDC contract, with its code and state as the fork read them | Every key: the keys were made for this run and thrown away. Every balance given to them: QUSDC and QIE were created on the fork only |");
  out.push("| The compiled router and vault | The explorer: there is none, so source verification and `verify-link` are not run (the dry run's pre-flight check reads a local stand-in) |");
  out.push("| The facilitator and the tool server as separate processes, started from the settings files `live:wire` wrote | The clock: the fork's was moved up to the wall clock |");
  out.push("| The payment proxy, the recorder and the checks, reading the chain through read-only methods | The router's owner and fee recipient: addresses with no key stand in for the founder's |");
  out.push("| The settings and the caps of the deploy, the smoke run and the payer's start, read out of the go-live plan's own commands | The founder's keys: no real key signs anything here |");
  out.push("");
  out.push("One setting differs from the founder's: `SLUICE_RPC_URL`, which names the fork. On mainnet it is left unset, and the scripts probe QIE's five public endpoints.");
  out.push("");
  out.push("## Funding, as the fork read it from the real addresses");
  out.push("");
  const real = (a?: string): string => a ?? "(no key file was found, so no real address)";
  out.push(`The run is funded as the founder's real addresses are, where that is enough for a run from the start. On the fork's copy of mainnet at block ${r.forkedAt}, the real deployer ${real(r.mirror.realDeployer)} held ${formatQie(r.mirror.deployerHeld.qie)} QIE and ${formatQusdc(r.mirror.deployerHeld.qusdc)} QUSDC, and the real relayer ${real(r.mirror.realRelayer)} held ${formatQie(r.mirror.relayerHeld.qie)} QIE. This run's throwaway deployer was given ${formatQie(r.fund.deployerQie)} QIE and ${formatQusdc(r.fund.deployerQusdc)} QUSDC${r.fund.deployerFromChain ? ", which is what the real deployer held" : ", the amounts the plan expects, because the real deployer held less than a run from the start needs"}. The throwaway relayer was given ${formatQie(r.fund.relayerQie)} QIE${r.fund.relayerFromChain ? ", which is what the real relayer held" : ", the amount the plan expects, because the real relayer held too little"}. The payer was given ${formatQusdc(r.fund.payerQusdc)} QUSDC and no QIE.`);
  out.push("");
  out.push("**No real key signed anything.** The key files in the repository folder were read for the addresses they belong to, and for nothing else. A transaction signed for chain 1990 on a fork is a valid transaction on mainnet too, so anyone who held it could send it there, and a deployment signed that way would take the address the founder's own deploy is meant to have. The throwaway keys have no value on mainnet.");
  out.push("");
  out.push("## Addresses made for this run (throwaway, public)");
  out.push("");
  out.push("| Role | Address |");
  out.push("| --- | --- |");
  for (const [role, address] of Object.entries(r.finalFacts)) out.push(`| ${role} | ${address} |`);
  out.push(`| Router (deployed on the fork) | ${r.router} |`);
  out.push(`| Vault (deployed on the fork) | ${r.deployment.vault} |`);
  out.push("");
  out.push("## The steps");
  out.push("");
  out.push("Each step shows the command as the founder types it, then what the script printed. Output has had every key cut out, and long output is cut in the middle (and says so).");
  for (const s of r.steps) {
    out.push("");
    out.push(`### ${s.n}. ${s.title}`);
    out.push("");
    out.push("The founder types:");
    out.push("");
    out.push("```powershell");
    for (const line of s.founder) out.push(line);
    out.push("```");
    out.push("");
    out.push(`Run here as \`${s.ranAs}\` on the fork. Exit code ${s.code}.`);
    for (const note of s.notes) {
      out.push("");
      out.push(note);
    }
    out.push("");
    out.push("```text");
    out.push(trim(s.output));
    out.push("```");
  }
  out.push("");
  out.push("## How the go-live plan's steps line up with this run");
  out.push("");
  out.push("`pnpm live:golive:plan` prints the founder's whole sequence. Each of its steps is either run here or named as not run, with the reason. This table is checked as the run ends: a step of the plan that it does not list stops the run.");
  out.push("");
  out.push("| Plan step | Title | In this run |");
  out.push("| --- | --- | --- |");
  for (const row of r.planTable) out.push(row);
  out.push("");
  out.push("## Gas, measured on the fork, against docs/GAS.md");
  out.push("");
  out.push("Beside the gas each transaction used here is the figure measured in [GAS.md](GAS.md), on a fork at an earlier block. A difference is a difference between two forks. It says nothing about what mainnet will charge.");
  out.push("");
  out.push("| Step | Gas used here | GAS.md | Difference |");
  out.push("| --- | --- | --- | --- |");
  for (const row of r.rows) out.push(row);
  out.push("");
  out.push(r.closing);
  out.push("");
  out.push("## What building and running this found");
  out.push("");
  out.push("These were faults in the scripts or the runbook that this run, or the runs before it, exposed. Each was fixed before this log was written, and is in DECISIONS.md.");
  out.push("");
  out.push("- A recorder that had written its row then died with a Node 24 assertion on Windows (exit code 3221226505), because the program called `process.exit()` while a connection was closing. Commands now set their exit code and let the process end by itself.");
  out.push("- The runbook's last step said the builder withdraws and gave no command. `pnpm client:owner` now has `withdraw` and `refund`, by signature, for a builder or a payer with no QIE.");
  out.push("- `deploy.ts` and `smoke.ts` ignored an option they did not know, so a mistyped `--dry-run` would have run for real. They refuse it now.");
  out.push("- A facilitator, a tool server or a wallet MCP pointed at a node on another chain by a named RPC address would have started. They check the chain now.");
  out.push("- A tool call that needs a contract the fork has not yet read failed with the tool server's ten-second limit on one RPC read. On mainnet a read takes about a second. The limit was raised for this run only.");
  out.push("- The go-live plan's own settings did not all pass the guard they were written for. A cap on one transaction left over from the smoke run was above the cap on the payer's own QIE, so the payer's start would have been refused with `SLUICE_MAX_TX_QIE is above SLUICE_MAX_QIE`. The plan's tests now run each sending step's settings through the real guard, and the payer's step sets its own cap. This run reads the same settings out of the plan's lines.");
  out.push("- The plan's tests, run from the repository folder, could have read the founder's real key files, which the plan command looks for in the folder it is run from. They now run in an empty folder.");
  out.push("- Once the deployment and the smoke run had been made on mainnet, the real deployer held 0.0015 QUSDC less than a smoke run from the start deposits, and this run, which gave its own deployer exactly that, was stopped by the pre-flight check with `NO-GO`, as it should be. The run now takes the real holdings only when they are enough for a run from the start, and says which amounts it used.");
  out.push("- `pnpm live:verify` submits the router only. The vault, which the router's constructor creates, has its code compared with the compiled AgentVault instead (`pnpm live:vaultcheck`). What QIE's explorer answered about the vault is in EXPLORER-VAULT-INVESTIGATION.md.");
  out.push("");
  out.push("## What this does not show");
  out.push("");
  out.push("- How mainnet, its explorer or its public endpoints behave: the explorer's source verification (`pnpm live:verify`), its 502s and the rate limits of rpc1 to rpc5 were not exercised.");
  out.push("- A real wallet, a real multisig, a real host, real latency, or whether a transaction as large as the biggest batch is accepted by the live chain.");
  out.push("- Any recorded row as evidence: the rows were written to a copy of the evidence file under a Fork heading, are never read by the proof strip or counted by `pnpm evidence:summary`, and are not on mainnet.");
  out.push("- Anything about QUSDC's behaviour on the live chain beyond what the fork copied, and nothing about how the live chain's state will differ when the founder runs this.");
  out.push("");
  return `${out.join("\n")}\n`;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`mainnet dry run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
