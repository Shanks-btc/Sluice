// docs/LOCAL-MAINNET-RUN.md, run. The settings, the commands and their arguments are read out of the page's own PowerShell blocks, in the
// page's order, and carried out on a local chain: the two programs as separate processes with the page's settings, and every client
// command through the program's own entry point. A line of a block that this test does not know fails it, so the page cannot grow a step
// that nothing has run.
//
// What stands in: a local chain (chain id 1990) for mainnet, a test token at QUSDC's address, a pool at QIEDEX's addresses, a local
// explorer, throwaway keys in a temporary folder for the three key files, and free ports for 8402 and 8403. The programs are told the
// local node with SLUICE_RPC_URL, which the page leaves unset. PowerShell itself runs only the three lines that write the proxy's
// settings, and parses every block, on Windows.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Contract, Wallet, getAddress, parseEther } from "ethers";
import { ethers, network } from "hardhat";
import { main as smoke } from "../../../scripts/client/smoke-client";
import { main as owner } from "../../../scripts/client/owner-setup";
import { main as paidCall } from "../../../scripts/client/paid-call";
import { main as balances } from "../../../scripts/live/balances";
import { main as hostcheck } from "../../../scripts/live/hostcheck";
import { main as newKey } from "../../../scripts/live/new-key";
import { main as record } from "../../../scripts/evidence/record";
import { main as evidenceCheck } from "../../../scripts/evidence-check";
import { main as evidenceSummary } from "../../../scripts/evidence-summary";
import { QIEDEX } from "../../../examples/paid-tools/src";
import { parseEvidenceStrict } from "../../../src/evidence";
import { QUSDC_ADDRESS } from "../../../src/guard";
import { loadArtifact } from "../../../src/live";
import { deployContract } from "../../helpers";
import { evidenceTemplate } from "../../helpers/evidence-template";
import { fakeExplorer, serveExplorer } from "../../helpers/explorer";
import { spawnFacilitator } from "../../helpers/chaos";
import type { Spawned } from "../../helpers/chaos";
import { ROOT, inheritedEnv, tsCommand } from "../../helpers/spawn";
import { freshChain, rpcProvider, setQie, startRpc, throwawayWallet } from "../../helpers/stack";

const GUIDE = readFileSync(join(ROOT, "docs", "LOCAL-MAINNET-RUN.md"), "utf8").replace(/\r\n/g, "\n");

/** The addresses the page is written for. */
const PAGE = {
  router: "0xf6F4C1Cc954B1798d134750438ada58768978716",
  payer: "0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C",
  builder: "0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E",
  relayer: "0x0A021bC732325C57E0cC838E4111A861b84fFEB1",
};

type Block = { section: string; lines: string[] };

/** Every PowerShell block of the page, with the heading it stands under. */
function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  let section = "";
  let open: Block | undefined;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (open) {
      if (line === "```") {
        out.push(open);
        open = undefined;
      } else if (line) open.lines.push(line);
    } else if (line.startsWith("## ")) section = line.slice(3);
    else if (line === "```powershell") open = { section, lines: [] };
  }
  return out;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

type Env = Record<string, string>;
type Ran = { command: string; code: number; text: string };

/** One run of the page against its own chain, keys, folder and processes. */
async function pageRun() {
  await freshChain();
  const signers = await ethers.getSigners();
  const [deployer, feeRecipient] = [signers[0]!, signers[1]!];
  const place = async (at: string, from: { getAddress: () => Promise<string> }) =>
    network.provider.send("hardhat_setCode", [at, await network.provider.send("eth_getCode", [await from.getAddress(), "latest"])]);
  await network.provider.send("hardhat_setCode", [QUSDC_ADDRESS, loadArtifact("MockQUSDC", "test").deployedBytecode]);
  const router = await deployContract("PaymentRouter", [QUSDC_ADDRESS, deployer.address, feeRecipient.address, 100]);
  const routerAddress = getAddress(await router.getAddress());
  // A pool where the quote tool looks for QIEDEX's, with the reserves measured on 2026-11-19.
  await place(QIEDEX.wqie, await deployContract("MockToken", ["WQIE", 18]));
  await place(QIEDEX.factory, await deployContract("MockFactory", []));
  await place(QIEDEX.router, await deployContract("MockRouter", [QIEDEX.factory, QIEDEX.wqie, 997]));
  const pair = await deployContract("MockPair", [QIEDEX.wqie, QUSDC_ADDRESS]);
  await (await (pair as unknown as { setReserves: (a: string, x: bigint, y: bigint) => Promise<{ wait: () => Promise<unknown> }> }).setReserves(QIEDEX.wqie, 28_237_539_588_918_300_797_359n, 4_609_000_000n)).wait();
  const factory = new Contract(QIEDEX.factory, ["function setPair(address,address,address)"], deployer);
  await (await factory.getFunction("setPair")(QIEDEX.wqie, QUSDC_ADDRESS, await pair.getAddress())).wait();

  const wallets = { payer: throwawayWallet(), builder: throwawayWallet(), relayer: throwawayWallet() };
  // As the chain held them on the day the page was written: the payer 0.05 QUSDC and no QIE, the relayer 0.1 QIE, the builder nothing.
  await setQie(wallets.relayer.address, parseEther("0.1"));
  const qusdc = new Contract(QUSDC_ADDRESS, ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"], deployer);
  await (await qusdc.getFunction("mint")(wallets.payer.address, 50_000n)).wait();

  const rpc = await startRpc();
  const explorer = await serveExplorer(fakeExplorer(ethers.provider));
  const work = mkdtempSync(join(tmpdir(), "sluice-local-run-"));
  for (const [name, wallet] of Object.entries(wallets)) writeFileSync(join(work, `${name}-mainnet.key`), `${(wallet as Wallet).privateKey}\r\n`);
  const evidence = join(work, "evidence.md");
  writeFileSync(evidence, evidenceTemplate(readFileSync(join(ROOT, "docs", "EVIDENCE.md"), "utf8")));
  const ports = { facilitator: await freePort(), tools: await freePort() };
  const found: Record<string, string> = {};
  const windows: Record<"A" | "B" | "C", Env> = { A: {}, B: {}, C: {} };
  const ran: Ran[] = [];
  const processes: { facilitator?: Spawned; tools?: { child: ChildProcess; lines: string[] } } = {};

  const substitute = (line: string): string => {
    let out = line;
    // The ports first: a throwaway address may well hold those digits, and the page's own addresses do not.
    const swaps: Array<[string, string]> = [
      ["127.0.0.1:8402", `127.0.0.1:${ports.facilitator}`], ["127.0.0.1:8403", `127.0.0.1:${ports.tools}`], ['_PORT = "8402"', `_PORT = "${ports.facilitator}"`], ['_PORT = "8403"', `_PORT = "${ports.tools}"`], ['"12119118"', '"0"'],
      [PAGE.router, routerAddress], [PAGE.payer, wallets.payer.address], [PAGE.builder, wallets.builder.address], [PAGE.relayer, wallets.relayer.address],
    ];
    for (const [from, to] of swaps) out = out.split(from).join(to);
    out = out.replace(/0x(DepositHash|TopUpHash|BatchHash[123]|WithdrawHash|RefundHash|AgentAddress|IntentId)/g, (_m, name: string) => {
      const value = found[name];
      if (!value) throw new Error(`the page uses 0x${name} before any command has printed it`);
      return value;
    });
    return out;
  };
  /** A path the page writes as .\name or .local-mainnet\name, in the run's folder. */
  const inWork = (path: string): string => join(work, ...path.replace(/^\.\\/, "").split("\\"));

  async function startTools(env: Env): Promise<void> {
    const { command, args } = tsCommand("examples/paid-tools/src/cli.ts", ["--http"]);
    const child = spawn(command, args, { cwd: ROOT, env: { ...inheritedEnv(), ...env }, stdio: ["ignore", "ignore", "pipe"] });
    const lines: string[] = [];
    processes.tools = { child, lines };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the tool server did not start: ${lines.join(" ")}`)), 90_000);
      child.stderr?.on("data", (chunk: Buffer) => {
        lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
        if (lines.some((l) => l.includes('"msg":"started"'))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => reject(new Error(`the tool server exited (${code}): ${lines.join(" ")}`)));
    });
  }

  async function pnpm(window: "A" | "B" | "C", words: string[]): Promise<void> {
    const [name, ...argv] = words as [string, ...string[]];
    const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Env }).scripts;
    if (name === "install") return;
    expect(scripts, `pnpm ${name} is a script`).to.have.property(name);
    // The two packages are built by the page; here they run from source. live:facts compares the real token's roles with RISKS.md.
    if (name === "build" || name === "live:facts") return;
    const env: Env = { ...windows[window], SLUICE_RPC_URL: rpc.url };
    if (name === "start:facilitator") {
      for (const k of ["SLUICE_FACILITATOR_STATE", "SLUICE_FACILITATOR_KILL_FILE"]) {
        expect(env[k], k).to.match(/^\.local-mainnet\\/);
        env[k] = inWork(env[k] as string);
      }
      processes.facilitator = await spawnFacilitator(env);
      return;
    }
    if (name === "start:paid-tools") {
      expect(argv).to.deep.equal(["--http"]);
      return startTools({ ...env, SLUICE_EXPLORER_URL: explorer.url });
    }
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    let code: number;
    if (name === "live:balances") code = await balances(argv, env, { log, cwd: work });
    else if (name === "live:hostcheck") code = await hostcheck(argv, env, { log, cwd: work });
    else if (name === "client:owner") code = await owner(argv, env, { log });
    else if (name === "client:call") code = await paidCall(argv, env, { log });
    else if (name === "live:new-key") code = newKey(argv.map(inWork), log);
    else if (name === "client:smoke") {
      const i = argv.indexOf("--config");
      argv[i + 1] = inWork(argv[i + 1] as string);
      code = await smoke(argv, env, { log, command: tsCommand("packages/proxy/src/cli.ts", ["--config", argv[i + 1] as string]) });
    } else if (name === "evidence:record") {
      // A local copy of the chain is labelled fork and recorded in a file of its own: the one change to the page's command.
      const i = argv.indexOf("--network");
      expect(argv[i + 1]).to.equal("mainnet");
      argv[i + 1] = "fork";
      code = await record([...argv, "--file", evidence, "--rpc", rpc.url], {}, { log });
    } else if (name === "evidence:check") code = await evidenceCheck(["--file", evidence, "--fork"], { EVIDENCE_RPC_URL: rpc.url }, log);
    else if (name === "evidence:summary") code = await evidenceSummary({ ...env, EVIDENCE_RPC_URL: rpc.url }, log, undefined, undefined, undefined, ["--file", evidence, "--fork"]);
    else throw new Error(`this test does not know how to run pnpm ${name}`);
    const text = lines.join("\n");
    ran.push({ command: words.join(" "), code, text });
    for (const wallet of Object.values(wallets)) expect(text, "no key is printed").to.not.contain((wallet as Wallet).privateKey.slice(2));
    expect(code, `pnpm ${words.join(" ")}\n${text}`).to.equal(0);

    const started = /--claim relayed-start --tx (0x[0-9a-f]{64}) --topup (0x[0-9a-f]{64})/.exec(text);
    if (started) Object.assign(found, { DepositHash: started[1], TopUpHash: started[2] });
    const batch = /settlement: settled, transaction (0x[0-9a-f]{64})/.exec(text);
    if (batch) found[`BatchHash${Object.keys(found).filter((k) => k.startsWith("BatchHash")).length + 1}`] = batch[1] as string;
    const withdrawn = /^withdrawn: (0x[0-9a-f]{64})/m.exec(text);
    if (withdrawn) found.WithdrawHash = withdrawn[1] as string;
    const refunded = /^refunded: (0x[0-9a-f]{64})/m.exec(text);
    if (refunded) found.RefundHash = refunded[1] as string;
    if (name === "live:new-key") found.AgentAddress = /address: (0x[0-9a-fA-F]{40})/.exec(text)?.[1] ?? "";
    const intent = /intent (0x[0-9a-f]{64}) is queued/.exec(text);
    if (intent) found.IntentId = intent[1] as string;
  }

  /** The proxy's settings, written by the page's own three lines: by PowerShell on Windows, so that what it writes is what is read. */
  function writeConfig(lines: string[]): void {
    const config = join(work, ".local-mainnet", "sluice.config.json");
    if (process.platform === "win32") {
      const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${lines.join("; ")}`], { cwd: work, encoding: "utf8", timeout: 60_000 });
      expect(out.status, `${out.stdout}\n${out.stderr}`).to.equal(0);
      expect(readFileSync(config)[0], "no byte-order mark").to.equal("{".charCodeAt(0));
      return;
    }
    const text = lines.join("\n");
    const value = (name: string) => new RegExp(`${name} = "([^"]*)"`).exec(text)?.[1] as string;
    const payee = value("payee");
    writeFileSync(config, JSON.stringify({
      upstream: { url: value("url") }, router: value("router"), payer: value("payer"),
      budget: { perCallCap: value("perCallCap"), totalCap: value("totalCap"), expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(), allowedTools: ["dex_quote", "contract_lookup", "token_risk_check"].map((tool) => ({ tool, payee })) },
      logFile: value("logFile"), stateFile: value("stateFile"),
    }));
  }

  async function block(b: Block): Promise<void> {
    const window = b.section.startsWith("Step 2") ? "A" : b.section.startsWith("Step 3") ? "B" : "C";
    const session = windows[window];
    const configLines: string[] = [];
    for (const raw of b.lines) {
      const line = substitute(raw);
      const set = /^\$env:([A-Z_][A-Z0-9_]*) = "([^"]*)"$/.exec(line);
      const key = /^\$env:([A-Z_][A-Z0-9_]*) = \(Get-Content (\.\\[\w.\\-]+) -Raw\)\.Trim\(\)$/.exec(line);
      if (set) session[set[1] as string] = set[2] as string;
      else if (key) session[key[1] as string] = readFileSync(inWork(key[2] as string), "utf8").trim();
      else if (line === "New-Item -ItemType Directory -Force .local-mainnet | Out-Null") mkdirSync(join(work, ".local-mainnet"), { recursive: true });
      else if (/^Remove-Item Env:[A-Z_]+(, Env:[A-Z_]+)*( -ErrorAction SilentlyContinue)?$/.test(line)) {
        for (const m of line.matchAll(/Env:([A-Z_]+)/g)) delete session[m[1] as string];
      } else if (/^(\$tools = |\$config = |\[IO\.File\]::WriteAllText\()/.test(line)) {
        configLines.push(line);
        if (line.startsWith("[IO.File]")) writeConfig(configLines);
      } else if (/^\(Invoke-RestMethod (http:\/\/127\.0\.0\.1:\d+\/status\/0x[0-9a-f]{64})\)\.transaction$/.test(line)) {
        const url = /(http:\S+)\)/.exec(line)?.[1] as string;
        // The page says to wait half a minute: here the status is asked until the batch is in.
        let status: { status?: string; transaction?: string } = {};
        for (let i = 0; i < 120 && status.status !== "settled"; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 500));
          status = (await (await fetch(url)).json()) as typeof status;
        }
        expect(status.status, "the last call's payment settled").to.equal("settled");
        expect(status.transaction).to.match(/^0x[0-9a-f]{64}$/);
      } else if (/^pnpm [\w:-]+( [^"']+)?$/.test(line)) await pnpm(window, line.slice(5).split(/\s+/));
      else throw new Error(`this test does not know the line: ${raw}`);
    }
  }

  return {
    work, rpc, ports, wallets, routerAddress, qusdc, found, windows, ran, evidence, processes, block,
    feeRecipient: feeRecipient.address,
    async stop() {
      processes.tools?.child.kill("SIGKILL");
      await processes.facilitator?.kill();
      await explorer.close();
      await rpc.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

type Run = Awaited<ReturnType<typeof pageRun>>;

const ALL = blocks(GUIDE);
const of = (...sections: string[]): Block[] => ALL.filter((b) => sections.some((s) => b.section.startsWith(s)));
const output = (run: Run, command: RegExp): string => run.ran.filter((r) => command.test(r.command)).map((r) => r.text).join("\n");
const money = async (run: Run) => {
  const provider = rpcProvider(run.rpc.url);
  const router = new Contract(run.routerAddress, ["function earnings(address) view returns (uint256)", "function payerBalance(address) view returns (uint256)"], provider);
  const token = new Contract(QUSDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
  const out = {
    payerWallet: (await token.getFunction("balanceOf")(run.wallets.payer.address)) as bigint,
    payerPrepaid: (await router.getFunction("payerBalance")(run.wallets.payer.address)) as bigint,
    builderWallet: (await token.getFunction("balanceOf")(run.wallets.builder.address)) as bigint,
    builderEarnings: (await router.getFunction("earnings")(run.wallets.builder.address)) as bigint,
    feeEarnings: (await router.getFunction("earnings")(run.feeRecipient)) as bigint,
    relayerSpent: parseEther("0.1") - (await provider.getBalance(run.wallets.relayer.address)),
  };
  provider.destroy();
  return out;
};

describe("The local run against mainnet: the page itself", () => {
  it("says what it is, and says about mainnet only what the evidence file records", () => {
    expect(GUIDE).to.contain("**This is a local run against mainnet, not a hosted product.**");
    // While no mainnet row is one of this page's steps, it says it has not been run. Once one is, it points at the file as the record, says
    // whose the rows are, and says what a row cannot show.
    const rows = parseEvidenceStrict(readFileSync(join(ROOT, "docs", "EVIDENCE.md"), "utf8"));
    const kinds = new Set(rows.filter((r) => r.network === "mainnet").map((r) => (r.claim ?? "").split(" ")[0]));
    if (!["relayed-start", "paid-call-settlement", "refund"].some((k) => kinds.has(k))) {
      expect(GUIDE).to.contain("**It has not been run on mainnet.**");
      return;
    }
    expect(GUIDE).to.not.contain("It has not been run on mainnet");
    expect(GUIDE).to.contain("**What has happened on mainnet is what [EVIDENCE.md](EVIDENCE.md) records.**");
    expect(GUIDE).to.contain("all founder-run");
    expect(GUIDE).to.contain("it does not show which program signed it or whether these steps were followed as written");
    // Every kind of row the opening names is in the file.
    for (const kind of ["relayed-start", "paid-call-settlement", "withdraw", "refund"]) expect(kinds.has(kind), kind).to.equal(true);
  });

  it("has the steps in order, each with its blocks", () => {
    const headings = GUIDE.split("\n").filter((l) => /^## (Step \d+|Through the proxy)/.test(l)).map((l) => l.slice(3));
    expect(headings.map((h) => /^Step (\d+)/.exec(h)?.[1] ?? "proxy")).to.deep.equal(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "proxy"]);
    for (const h of headings) expect(ALL.some((b) => b.section === h), h).to.equal(true);
  });

  it("states what each step that does something spends and whether it can be undone", () => {
    const sections = GUIDE.split(/^## /m).slice(1);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const body = sections.find((s) => s.startsWith(`Step ${n}:`)) as string;
      expect(body, `step ${n} says what it spends`).to.match(/^Spends: /m);
      if ([1, 2, 3, 5, 6, 8, 9].includes(n)) expect(body, `step ${n} says whether it can be undone`).to.match(/Undo: /);
    }
  });

  it("gives the payee, the relayer's key from its file into the session only, and the approval of each program", () => {
    expect(GUIDE).to.contain('$env:SLUICE_PAYEE = "0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E"');
    expect(GUIDE).to.contain("$env:SLUICE_RELAYER_KEY = (Get-Content .\\relayer-mainnet.key -Raw).Trim()");
    expect(GUIDE).to.contain('$env:SLUICE_APPROVE = "facilitator"');
    expect(GUIDE).to.contain("Remove-Item Env:SLUICE_KEY, Env:SLUICE_APPROVE, Env:SLUICE_RELAYER_KEY, Env:SLUICE_AGENT_KEY -ErrorAction SilentlyContinue");
    // No key, no 32-byte value, anywhere in the page.
    expect(GUIDE).to.not.match(/0x[0-9a-fA-F]{64}/);
  });

  it("has no double or single quote in a pnpm command, which Windows PowerShell would alter on the way", () => {
    for (const b of ALL) for (const line of b.lines.filter((l) => l.startsWith("pnpm "))) expect(line, line).to.not.match(/["']/);
  });

  it("holds PowerShell that PowerShell can read (Windows only)", function () {
    if (process.platform !== "win32") return this.skip();
    this.timeout(60_000);
    const dir = mkdtempSync(join(tmpdir(), "sluice-ps-"));
    try {
      writeFileSync(join(dir, "blocks.ps1"), ALL.map((b) => b.lines.join("\r\n")).join("\r\n"));
      const check = "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'blocks.ps1'), [ref]$null, [ref]$errors) | Out-Null; $errors | ForEach-Object { $_.Message }; exit $errors.Count";
      const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { cwd: dir, encoding: "utf8", timeout: 50_000 });
      expect(out.status, out.stdout + out.stderr).to.equal(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("The local run against mainnet: steps 1 to 11 as written, on a local chain", function () {
  this.timeout(600_000);
  let run: Run;
  before(async () => {
    run = await pageRun();
  });
  after(async () => {
    await run?.stop();
  });
  const step = async (n: number) => {
    for (const b of of(`Step ${n}:`)) await run.block(b);
  };

  it("step 1 reads the wallets as the page expects to find them", async () => {
    await step(1);
    const text = output(run, /^live:balances/);
    expect(text).to.contain(`${run.wallets.payer.address}  QIE 0  QUSDC in wallet 0.050000`);
    expect(text).to.contain(`${run.wallets.relayer.address}  QIE 0.1 `);
  });

  it("steps 2 and 3 start both programs in mainnet mode with the page's settings and caps", async () => {
    await step(2);
    await step(3);
    const started = run.processes.facilitator!.lines.find((l) => l.includes('"msg":"started"')) as string;
    for (const part of [`"relayer":"${run.wallets.relayer.address}"`, '"network":"mainnet"', '"chainId":1990', '"store":"journal"', '"dailyBudgetWei":"3000000000000000"', `"router":"${run.routerAddress}"`]) expect(started, part).to.contain(part);
    const tools = run.processes.tools!.lines.find((l) => l.includes('"msg":"started"')) as string;
    expect(tools).to.contain(`"payee":"${run.wallets.builder.address}"`).and.to.contain('"network":"mainnet"');
    expect(existsSync(join(run.work, ".local-mainnet", "queue.jsonl"))).to.equal(true);
    expect(run.windows.A.SLUICE_APPROVE).to.equal("facilitator");
    expect(run.windows.B).to.not.have.property("SLUICE_RELAYER_KEY");
    expect(run.windows.C).to.not.have.property("SLUICE_RELAYER_KEY");
  });

  it("step 4's host check passes every line", async () => {
    await step(4);
    expect(output(run, /^live:hostcheck/)).to.match(/hostcheck: \d+ passed, 0 failed, 0 warnings/);
  });

  it("step 5 starts the payer with no QIE, and records it", async () => {
    await step(5);
    const text = output(run, /^client:owner start/);
    for (const part of ["top-up from the facilitator: 0x", "approval: 0x", "deposit:  0x", "done: 0.020000 QUSDC is in the router"]) expect(text).to.contain(part);
    expect(output(run, /relayed-start/)).to.contain("recorded 1 row");
    expect((await money(run)).payerPrepaid).to.equal(20_000n);
  });

  it("step 6 pays three tools with the payer's key, and step 7 records each settlement and its batch", async () => {
    await step(6);
    const text = output(run, /^client:call/);
    expect(text.match(/settlement: settled, transaction 0x/g)).to.have.length(3);
    for (const price of ["0.002000", "0.005000", "0.010000"]) expect(text).to.contain(`signed a payment of ${price} QUSDC to ${run.wallets.builder.address}`);
    await step(7);
    expect(run.ran.filter((r) => /--claim (paid-call-settlement|settle-batch)/.test(r.command)).map((r) => /recorded 1 row/.test(r.text))).to.deep.equal([true, true, true, true, true, true]);
    const now = await money(run);
    expect(now).to.include({ payerPrepaid: 3_000n, builderEarnings: 16_830n, feeEarnings: 170n });
  });

  it("steps 8 and 9 pay the builder and return the rest to the payer, and the amounts are the page's", async () => {
    await step(8);
    expect(output(run, /^live:balances --address \S+$/)).to.contain("earnings in router 0.016830");
    await step(9);
    const now = await money(run);
    expect(now).to.include({ payerWallet: 33_000n, payerPrepaid: 0n, builderWallet: 16_830n, builderEarnings: 0n });
    // The page says about 0.001 QIE of the relayer's, inside a cap of 0.003.
    expect(now.relayerSpent > parseEther("0.0006") && now.relayerSpent < parseEther("0.0013"), `the relayer spent ${now.relayerSpent} wei`).to.equal(true);
  });

  it("step 10 checks every recorded row, and step 11 clears the secrets", async () => {
    await step(10);
    expect(output(run, /^evidence:check/)).to.not.match(/^(FAIL|SKIP)/m);
    expect(output(run, /^evidence:check/).match(/^PASS/gm)).to.have.length(9);
    expect(output(run, /^evidence:record --claim refund/)).to.contain("recorded 1 row for the refund claim");
    await step(11);
    for (const name of ["SLUICE_KEY", "SLUICE_APPROVE", "SLUICE_AGENT_KEY"]) expect(run.windows.C).to.not.have.property(name);
    expect(run.processes.facilitator!.lines.join("\n")).to.not.contain(run.wallets.relayer.privateKey.slice(2));
  });
});

describe("The local run against mainnet: the same through the proxy, as written, on a local chain", function () {
  this.timeout(600_000);
  let run: Run;
  before(async () => {
    run = await pageRun();
  });
  after(async () => {
    await run?.stop();
  });

  it("authorises an agent key, makes the three calls through the proxy, ends the session and returns the rest", async () => {
    for (const n of [1, 2, 3, 4, 5]) for (const b of of(`Step ${n}:`)) await run.block(b);
    const proxy = of("Through the proxy");
    // The proxy section's last block ends the session. Its status lookup needs an intent id, which the last call printed.
    for (const b of proxy) await run.block(b);
    expect(output(run, /^client:owner authorize/)).to.match(/authorised: 0x[0-9a-f]{64}/);
    const calls = output(run, /^client:smoke/);
    expect(calls.match(/step 6: payment response: success true/g)).to.have.length(3);
    expect(output(run, /^client:owner revoke/)).to.match(/revoked: 0x[0-9a-f]{64}/);
    for (const b of of("Step 9:")) await run.block(b);
    const now = await money(run);
    expect(now).to.include({ payerWallet: 33_000n, payerPrepaid: 0n, builderEarnings: 16_830n, feeEarnings: 170n });
    expect(now.relayerSpent < parseEther("0.0016"), `the relayer spent ${now.relayerSpent} wei`).to.equal(true);
    const vault = new Contract((await new Contract(run.routerAddress, ["function vault() view returns (address)"], ethers.provider).getFunction("vault")()) as string, ["function remainingBudget(address,address) view returns (uint256)"], ethers.provider);
    expect(await vault.getFunction("remainingBudget")(run.wallets.payer.address, run.found.AgentAddress)).to.equal(0n);
    // The journal the guide says to keep holds the three settled payments.
    copyFileSync(join(run.work, ".local-mainnet", "queue.jsonl"), join(run.work, "queue.copy"));
    expect(readFileSync(join(run.work, "queue.copy"), "utf8").match(/"status":"settled"/g)).to.have.length(3);
  });
});
