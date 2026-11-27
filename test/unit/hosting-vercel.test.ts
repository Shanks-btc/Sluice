// The files that put the facilitator and the tool server on Vercel, and the guide that tells a person how, held to the code: the two
// vercel.json files, the ignore file, the GitHub workflow (run here with a stand-in for curl), and the guide's tables of variables, which
// are given to the real settings readers. Nothing here touches a network or a host.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "chai";
import { getAddress } from "ethers";
import { DEFAULT_CAPS, SHARED_DATABASE_ACCEPTED, readEnv, redisPrefix } from "../../packages/facilitator/src";
import * as facilitatorFunction from "../../packages/facilitator/src/vercel";
import { readToolServerEnv } from "../../examples/paid-tools/src";
import * as toolsFunction from "../../examples/paid-tools/src/vercel";
import { DEFAULT_TIMEOUT_SECONDS, FACILITATOR_KEY_PREFIX, TOOLS_KEY_PREFIX, TOOLS_MARKER_KEY, readRedisCredentials } from "../../packages/sdk/src";
import { PAYMENT_RESENDS } from "../../apps/web/src/lib/paid-call";

const ROOT = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const ROUTER = getAddress(`0x${"12".repeat(20)}`);
const BUILDER = getAddress(`0x${"56".repeat(20)}`);
const FAKE_KEY = `0x${"7e".repeat(32)}`;
const guide = read("docs/HOSTING-VERCEL.md");

const PROJECTS = [
  { dir: "packages/facilitator", name: "@sluice/facilitator", maxDuration: facilitatorFunction.MAX_DURATION_SECONDS },
  { dir: "examples/paid-tools", name: "@sluice/paid-tools", maxDuration: toolsFunction.MAX_DURATION_SECONDS },
] as const;

describe("Vercel: the two function projects", () => {
  for (const { dir, name, maxDuration } of PROJECTS) {
    it(`${dir}: one function for every path, built from the workspace, allowed the time the code counts on`, () => {
      const config = json(`${dir}/vercel.json`);
      expect(config.framework).to.equal(null);
      expect(config.buildCommand).to.equal(`pnpm --filter ${name}... run build`);
      expect(config.outputDirectory).to.equal("public");
      expect(config.functions).to.deep.equal({ "api/index.js": { maxDuration } });
      expect(config.rewrites).to.deep.equal([{ source: "/(.*)", destination: "/api/index" }]);
      expect(read(`${dir}/api/index.js`).trim().split("\n").at(-1)).to.equal('module.exports = require("../dist/vercel").default;');
      // What the function requires is what the build writes.
      const compiled = json(`${dir}/tsconfig.json`) as { compilerOptions: { outDir: string; rootDir: string } };
      expect([compiled.compilerOptions.outDir, compiled.compilerOptions.rootDir]).to.deep.equal(["dist", "src"]);
      expect(existsSync(join(ROOT, dir, "src", "vercel.ts"))).to.equal(true);
      expect(json(`${dir}/package.json`).name).to.equal(name);
      expect(read(`${dir}/public/robots.txt`)).to.match(/Disallow: \//);
      expect(JSON.stringify(config), "no variable and no secret is set from the repository").to.not.match(/"env"|"build":|SLUICE_|0x[0-9a-fA-F]{64}/);
    });
  }

  it("asks the facilitator for one cron call a day, which the plan allows, and the tool server for none", () => {
    const crons = json("packages/facilitator/vercel.json").crons as Array<{ path: string; schedule: string }>;
    expect(crons).to.have.length(1);
    expect(crons[0]?.path).to.equal("/internal/drain");
    expect(crons[0]?.schedule, "a minute and an hour as numbers: once a day").to.match(/^([0-5]?\d) (1?\d|2[0-3]) \* \* \*$/);
    expect(json("examples/paid-tools/vercel.json").crons).to.equal(undefined);
  });

  it("pins the one platform library the facilitator adds", () => {
    const dependencies = json("packages/facilitator/package.json").dependencies as Record<string, string>;
    expect(dependencies["@vercel/functions"]).to.match(/^\d+\.\d+\.\d+$/);
  });

  it("leaves key files, settings files and the deployment record out of anything uploaded from a working folder", () => {
    const lines = read(".vercelignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const pattern of ["*.key", "*.keystore", "*.pem", ".env", ".env.*", "deployment.json", ".local-mainnet", ".rehearsal", "*.jsonl"]) expect(lines, pattern).to.include(pattern);
    expect(lines.filter((l) => l.startsWith("!")), "nothing is let back in").to.deep.equal([]);
  });
});

describe("Vercel: the five-minute sweeper's workflow", function () {
  this.timeout(60_000);
  const workflow = read(".github/workflows/sluice-drain.yml");
  /** The shell script of the one step: the lines under `run: |`, without their indentation. */
  const script = (() => {
    const lines = workflow.split("\n");
    const at = lines.findIndex((l) => /^\s*run: \|$/.test(l));
    const body: string[] = [];
    const indent = /^(\s*)/.exec(lines[at + 1] ?? "")?.[1] as string;
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== "" && !l.startsWith(indent)) break;
      body.push(l.slice(indent.length));
    }
    return body.join("\n");
  })();

  it("runs every five minutes and by hand, with no permission on the repository and no action from anyone else", () => {
    expect(workflow).to.match(/^ {4}- cron: "\*\/5 \* \* \* \*"$/m);
    expect(workflow).to.match(/^ {2}workflow_dispatch: \{\}$/m);
    expect(workflow).to.match(/^permissions: \{\}$/m);
    expect(workflow).to.not.match(/\buses:/);
    expect(workflow).to.match(/^concurrency:$/m);
  });

  it("takes its two secrets into the environment of the one step, and puts no secret anywhere else", () => {
    const naming = workflow.split("\n").filter((l) => l.includes("secrets."));
    expect(naming.map((l) => l.trim())).to.deep.equal([
      "FACILITATOR_URL: ${{ secrets.SLUICE_FACILITATOR_URL }}",
      "SWEEP_SECRET: ${{ secrets.SLUICE_FACILITATOR_SWEEP_SECRET }}",
    ]);
    expect(script).to.not.contain("${{");
    expect(script).to.not.match(/set -[a-wyz]*x|curl[^\n]*--verbose|curl[^\n]* -v\b/);
    expect(script.split("\n").filter((l) => l.includes("$SWEEP_SECRET") && !l.trim().startsWith("if "))).to.deep.equal([`printf 'Authorization: Bearer %s\\n' "$SWEEP_SECRET" |`]);
  });

  /** Runs the step's script with a stand-in for curl that writes down what it was given. Undefined when this machine cannot run it. */
  function run(env: Record<string, string>): { status: number | null; out: string; args?: string[]; stdin?: string } | undefined {
    const bin = mkdtempSync(join(tmpdir(), "sluice-drain-"));
    try {
      writeFileSync(join(bin, "curl"), `#!/bin/sh\nhere=$(dirname "$0")\nfor a in "$@"; do printf '%s\\n' "$a"; done > "$here/args"\ncat > "$here/stdin"\necho '{"settled":0}'\n`);
      chmodSync(join(bin, "curl"), 0o755);
      writeFileSync(join(bin, "probe-stand-in"), "#!/bin/sh\necho stand-in\n");
      chmodSync(join(bin, "probe-stand-in"), 0o755);
      const full = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FACILITATOR_URL: "", SWEEP_SECRET: "", ...env };
      const shell = ["bash", "sh"].find((s) => {
        const probe = spawnSync(s, ["-c", "set -o pipefail && probe-stand-in && command -v curl"], { env: full, encoding: "utf8" });
        return probe.status === 0 && probe.stdout.startsWith("stand-in") && probe.stdout.includes("sluice-drain-");
      });
      if (!shell) return undefined;
      const done = spawnSync(shell, ["-c", script], { env: full, encoding: "utf8" });
      const given = existsSync(join(bin, "args")) ? readFileSync(join(bin, "args"), "utf8").replace(/\r/g, "").trim().split("\n") : undefined;
      const stdin = existsSync(join(bin, "stdin")) ? readFileSync(join(bin, "stdin"), "utf8").replace(/\r/g, "") : undefined;
      return { status: done.status, out: `${done.stdout}${done.stderr}`.replace(/\r/g, ""), args: given, stdin };
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }
  const secret = "s".repeat(40);

  it("warns and sends nothing while neither secret is set", function () {
    const r = run({});
    if (!r) return this.skip();
    expect(r.status).to.equal(0);
    expect(r.out).to.contain("::warning::not configured");
    expect(r.args).to.equal(undefined);
  });

  it("fails, sending nothing, with one secret missing or an address that is not https", function () {
    const cases: Array<Record<string, string>> = [{ FACILITATOR_URL: "https://f.example" }, { SWEEP_SECRET: secret }, { FACILITATOR_URL: "http://f.example", SWEEP_SECRET: secret }, { FACILITATOR_URL: "f.example", SWEEP_SECRET: secret }];
    for (const env of cases) {
      const r = run(env);
      if (!r) return this.skip();
      expect(r.status, JSON.stringify(Object.keys(env))).to.equal(1);
      expect(r.out).to.contain("::error::");
      expect(r.out).to.not.contain(secret);
      expect(r.args).to.equal(undefined);
    }
  });

  it("posts to the drain path with the secret on curl's input, in no argument and in no output", function () {
    const r = run({ FACILITATOR_URL: "https://f.example/", SWEEP_SECRET: secret });
    if (!r) return this.skip();
    expect(r.status).to.equal(0);
    expect(r.args).to.deep.equal(["--silent", "--show-error", "--fail", "--max-time", "150", "--request", "POST", "--header", "@-", "https://f.example/internal/drain"]);
    expect(r.stdin).to.equal(`Authorization: Bearer ${secret}\n`);
    expect(r.out).to.not.contain(secret);
    expect(150, "curl waits longer than the function may run").to.be.greaterThan(facilitatorFunction.MAX_DURATION_SECONDS);
  });
});

// ------------------------------------------------------------------------------------------------------------ the guide's tables

type Row = { name: string; kind: string; value: string };

function tableAfter(heading: string): Row[] {
  const at = guide.indexOf(`\n${heading}\n`);
  if (at < 0) throw new Error(`no heading ${heading}`);
  const rows: Row[] = [];
  for (const l of guide.slice(at).split("\n").slice(2)) {
    if (/^#{1,3} /.test(l)) break;
    const m = /^\| `([A-Z0-9_]+)` \| ([^|]+) \| ([^|]*) \| .* \|$/.exec(l);
    if (m) rows.push({ name: m[1] as string, kind: (m[2] as string).trim(), value: (m[3] as string).trim() });
  }
  return rows;
}

/** What a person would type for a row: the value in backticks, or something of the kind the words ask for. */
function typed(row: Row): string {
  const literal = /^`([^`]*)`$/.exec(row.value)?.[1];
  if (literal !== undefined) return literal;
  if (row.name === "SLUICE_ROUTER") return ROUTER;
  if (row.name === "SLUICE_PAYEE") return BUILDER;
  if (row.name === "SLUICE_RELAYER_KEY") return FAKE_KEY;
  if (row.name === "SLUICE_FACILITATOR_SWEEP_SECRET") return "a".repeat(44);
  if (row.name === "CRON_SECRET") return "b".repeat(44);
  if (row.name === "SLUICE_FACILITATOR_URL") return "https://sluice-facilitator.vercel.app";
  if (row.name.endsWith("_CORS_ORIGINS")) return "https://sluice.vercel.app";
  throw new Error(`the test does not know what to type for ${row.name}`);
}

describe("Vercel: the guide's variables are the ones the functions read", () => {
  const facilitator = tableAfter("### The facilitator's variables on Vercel");
  const tools = tableAfter("### The tool server's variables on Vercel");
  const database = { SLUICE_REDIS_REST_URL: "https://db.example", SLUICE_REDIS_REST_TOKEN: "t".repeat(40) };
  const platform = ["NODEJS_HELPERS", "ENABLE_EXPERIMENTAL_COREPACK"];

  it("start the facilitator's settings reader, with the caps the guide shows being the ones in code", () => {
    const env = readEnv({ ...Object.fromEntries(facilitator.map((r) => [r.name, typed(r)])), ...database }, "serverless");
    expect(env).to.deep.include({ network: "mainnet", chainId: 1990, router: ROUTER, killSwitch: false, trustedProxyHops: 1, statePath: undefined });
    expect(env.drainSecrets()).to.have.length(2);
    expect(env.corsOrigins).to.deep.equal(["https://sluice.vercel.app"]);
    expect(env.caps).to.deep.equal(DEFAULT_CAPS);
  });

  it("start the tool server's settings reader", () => {
    const typedIn = Object.fromEntries(tools.map((r) => [r.name, r.name === "SLUICE_FACILITATOR_URL" ? "https://sluice-facilitator.vercel.app" : typed(r)]));
    const env = readToolServerEnv({ ...typedIn, ...database });
    expect(env).to.deep.include({ network: "mainnet", chainId: 1990, router: ROUTER, payee: BUILDER });
    expect(readRedisCredentials({ ...typedIn, ...database })?.url).to.equal("https://db.example");
  });

  it("mark the relayer's key, the two secrets and every cap as secret, and nothing in the tool server's table", () => {
    expect(facilitator.filter((r) => r.kind === "**secret**").map((r) => r.name).sort()).to.deep.equal(
      [
        "CRON_SECRET",
        "SLUICE_FACILITATOR_DAILY_QUSDC",
        "SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC",
        "SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE",
        "SLUICE_FACILITATOR_MAX_TOPUP_QIE",
        "SLUICE_FACILITATOR_PAYER_DAILY_QUSDC",
        "SLUICE_FACILITATOR_SWEEP_SECRET",
        "SLUICE_MAX_QIE",
        "SLUICE_RELAYER_KEY",
      ],
    );
    expect(tools.filter((r) => r.kind === "**secret**")).to.deep.equal([]);
    expect(tools.map((r) => r.name)).to.not.include.members(["SLUICE_RELAYER_KEY"]);
    for (const r of [...facilitator, ...tools]) {
      expect(["public", "**secret**", "you fill in"], r.name).to.include(r.kind);
      if (r.kind !== "**secret**") expect(r.name, r.name).to.not.match(/(KEY|SECRET|TOKEN|PASSWORD)$/);
    }
  });

  it("name no variable the code does not read, apart from the two that are the platform's", () => {
    const code = ["packages/facilitator/src/env.ts", "examples/paid-tools/src/host.ts", "packages/sdk/src/redis.ts"].map(read).join("\n");
    for (const r of [...facilitator, ...tools]) {
      if (platform.includes(r.name)) continue;
      expect(code, r.name).to.contain(r.name);
    }
    for (const name of ["SLUICE_REDIS_REST_URL", "SLUICE_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) expect(guide, name).to.contain(`\`${name}\``);
  });

  it("never asks for a key in a file, a chat or a command line", () => {
    for (const block of guide.split("```").filter((_, i) => i % 2 === 1)) {
      expect(block).to.not.match(/SLUICE_RELAYER_KEY\s*=/);
      expect(block).to.not.match(/0x[0-9a-fA-F]{64}/);
      expect(block, "a secret is made onto the clipboard, not into a file").to.not.match(/Out-File|Set-Content|Add-Content|>\s*\.\\/);
    }
    expect(guide).to.contain("(Get-Content .\\relayer-mainnet.key -Raw).Trim() | Set-Clipboard");
    expect(guide).to.contain("Never paste a key into a chat");
  });

  it("says plainly, in the guide and in the risks, that both services share one token and what that gives up", () => {
    const risks = read("docs/RISKS.md").replace(/\n/g, " ");
    for (const text of [guide.replace(/\n/g, " "), risks]) {
      expect(text).to.contain("Both services share one token");
      expect(text).to.match(/a bug or a compromise in the tool server's code/);
      expect(text).to.match(/Separate databases are the stronger setup/i);
      expect(text).to.match(/once (there is|a) paid plan/);
    }
    expect(guide).to.contain(`set \`SLUICE_FACILITATOR_SHARED_DATABASE\` to \`${SHARED_DATABASE_ACCEPTED}\``);
    expect(guide).to.contain("`sluice:facilitator:`").and.contain("`sluice:tools:`").and.contain(`\`${TOOLS_MARKER_KEY}\``);
    expect([FACILITATOR_KEY_PREFIX, TOOLS_KEY_PREFIX]).to.deep.equal(["sluice:facilitator:", "sluice:tools:"]);
    // The setting is the switch to rely on, and comes before the key in the database.
    const stopping = guide.slice(guide.indexOf("### Stopping it"), guide.indexOf("### What settles a payment"));
    expect(stopping).to.contain("The one to rely on: the setting").and.contain("does not depend on the database");
    expect(stopping.indexOf("SLUICE_FACILITATOR_KILL_SWITCH")).to.be.lessThan(stopping.indexOf(":kill 1"));
  });

  it("adds up the free plan's estimate rightly, from the numbers it shows", () => {
    const section = guide.slice(guide.indexOf("## The free plan's daily commands, estimated"), guide.indexOf("## What this does not verify"));
    const number = (text: string) => Number(text.replace(/[,*]/g, "").trim());
    const rows = section.split("\n").filter((l) => /^\| [^|*-]+ \| [\d,]+ \| [\d,]+ \| [\d,]+ \| [\d,]+ \| [\d,]+ \|$/.test(l)).map((l) => l.split("|").slice(2, 7).map(number));
    expect(rows.length).to.equal(5);
    for (const [times, one, all, dayOne, dayAll] of rows as number[][]) {
      expect([times! * one!, times! * all!]).to.deep.equal([dayOne, dayAll]);
    }
    const before = [3, 4].map((i) => rows.reduce((sum, r) => sum + (r[i] as number), 0));
    const total = /\| \*\*Before any paid call\*\* \| \| \| \| \*\*([\d,]+)\*\* \| \*\*([\d,]+)\*\* \|/.exec(section);
    expect([number(total![1]!), number(total![2]!)]).to.deep.equal(before);
    const call = /used (\d+) commands with a script as one, and (\d+) counting every command/.exec(section)!;
    const day = 500_000 / 31;
    expect(day).to.be.within(16_100, 16_200);
    const calls = [(day - before[0]!) / Number(call[1]), (day - before[1]!) / Number(call[2])];
    const said = /\*\*about (\d+) calls a day\*\* with a script as one command, or \*\*about (\d+) a day\*\*/.exec(section)!;
    expect(calls[0]).to.be.within(Number(said[1]) - 5, Number(said[1]) + 5);
    expect(calls[1]).to.be.within(Number(said[2]) - 5, Number(said[2]) + 5);
    // The sweeps are the workflow's, every five minutes.
    expect(rows[0]![0]).to.equal((24 * 60) / 5);
    // One caller at the tool server's own limits, as the guide says.
    expect(500_000 / (60 * 24 * 60 * 2)).to.be.within(2.5, 3.5);
    expect(500_000 / (300 * 24 * 60)).to.be.lessThan(2);
    expect(guide).to.contain("one address uses it in about three days").and.contain("in under two");
  });

  it("states the kill switch's key, the times and the limits as the code has them", () => {
    const key = `${redisPrefix("mainnet", ROUTER)}kill`;
    expect(guide).to.contain(key.replace(ROUTER.toLowerCase(), "<router address in lower case>"));
    expect(guide).to.contain(`(${facilitatorFunction.MAX_DURATION_SECONDS} seconds)`);
    expect(guide).to.contain(`allows a function ${toolsFunction.MAX_DURATION_SECONDS} seconds`);
    expect(guide).to.contain(`The functions ask for ${facilitatorFunction.MAX_DURATION_SECONDS} seconds (facilitator) and ${toolsFunction.MAX_DURATION_SECONDS} (tool server)`);
    expect(DEFAULT_TIMEOUT_SECONDS).to.equal(5 * 60);
    expect(guide).to.contain("expires, by default, five minutes after it is signed");
    // A paid call: held, run, captured. The facilitator answers "pending" before the tool server stops waiting for it, and the tool server
    // answers before its function's time is up.
    expect(guide).to.contain(`longer than the facilitator waits (${facilitatorFunction.CAPTURE_WAIT_MS / 1000} seconds)`);
    expect(guide).to.contain(`within the tool server's ${toolsFunction.HANDLER_TIMEOUT_MS / 1000} seconds`);
    expect(guide).to.contain("`sluice_payment_pending`");
    expect(guide).to.contain("up to three times");
    expect(PAYMENT_RESENDS).to.equal(3);
    expect(read("packages/proxy/src/proxy.ts")).to.contain("const PAYMENT_RESENDS = 3;");
    expect(facilitatorFunction.CAPTURE_WAIT_MS, "shorter than the client's wait for a capture").to.be.lessThan(30_000);
    expect(read("packages/sdk/src/facilitator-client.ts")).to.contain("options.captureTimeoutMs ?? 30_000");
    expect(30_000).to.be.lessThan(toolsFunction.HANDLER_TIMEOUT_MS);
    expect(guide).to.contain("at about 03:17 UTC");
    expect((json("packages/facilitator/vercel.json").crons as Array<{ schedule: string }>)[0]?.schedule).to.equal("17 3 * * *");
    expect(guide).to.contain("restricted to non-commercial, personal use");
  });
});
