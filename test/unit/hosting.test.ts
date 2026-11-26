// What the two hosting guides promise, held to the code: the Dockerfiles, the entrypoint's shell line, and the variables the guides tell a person
// to set. The strongest check is the last kind: the lines the guide has the person paste, with the values `pnpm live:wire` writes, are given to
// the real settings readers of the facilitator and the tool server, which must accept them. Nothing here touches a network or a host.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "chai";
import { getAddress } from "ethers";
import { readEnv } from "../../packages/facilitator/src";
import { readToolServerEnv } from "../../examples/paid-tools/src";
import { PUBLIC_ENV_NAMES } from "../../apps/web/src/lib/config";
import { QUSDC_ADDRESS } from "../../src/guard";
import { safeReaddir } from "../../src/secret-paths";
import { NOT_WRITTEN, wire } from "../../src/wire";

const ROOT = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const ROUTER = getAddress(`0x${"12".repeat(20)}`);
const VAULT = getAddress(`0x${"34".repeat(20)}`);
const BUILDER = getAddress(`0x${"56".repeat(20)}`);
const FAKE_KEY = `0x${"7e".repeat(32)}`;

// -------------------------------------------------------------------------------------------------------------- the Dockerfiles

/** The instructions of a Dockerfile, one per entry, with comments dropped. */
function instructions(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
/** The shell line inside an ENTRYPOINT ["/bin/sh", "-c", "<line>", "<name>"] instruction. */
function entrypointLine(text: string): { shell: string; line: string; name: string } {
  const instruction = instructions(text).find((l) => l.startsWith("ENTRYPOINT "));
  if (!instruction) throw new Error("no ENTRYPOINT");
  const parts = JSON.parse(instruction.slice("ENTRYPOINT ".length)) as string[];
  expect(parts).to.have.length(4);
  expect(parts[1]).to.equal("-c");
  return { shell: parts[0] as string, line: parts[2] as string, name: parts[3] as string };
}

describe("Hosting: the Dockerfiles", () => {
  const facilitator = read("packages/facilitator/Dockerfile");
  const tools = read("examples/paid-tools/Dockerfile");

  it("have no VOLUME line, which Railway's builds have been reported to refuse, and the volume is attached by the platform or `docker run -v`", () => {
    for (const text of [facilitator, tools]) expect(instructions(text).filter((l) => /^VOLUME\b/.test(l))).to.deep.equal([]);
    expect(facilitator).to.contain("There is no VOLUME line");
  });

  it("start the facilitator as root only to hand /data to node, and the tool server as node", () => {
    const f = instructions(facilitator);
    expect(f.filter((l) => /^USER\b/.test(l)), "the facilitator has no USER line: it drops privileges itself").to.deep.equal([]);
    expect(f.join("\n")).to.match(/RUN apk add --no-cache su-exec && mkdir \/data && chown node:node \/data/);
    const t = instructions(tools);
    expect(t.filter((l) => /^USER\b/.test(l))).to.deep.equal(["USER node"]);
    expect(t.join("\n")).to.not.contain("su-exec");
  });

  it("listen on every address, on the ports the guides name, with the queue on the volume", () => {
    expect(facilitator).to.match(/SLUICE_FACILITATOR_HOST=0\.0\.0\.0/);
    expect(facilitator).to.match(/SLUICE_FACILITATOR_PORT=8402/);
    expect(facilitator).to.match(/SLUICE_FACILITATOR_STATE=\/data\/queue\.jsonl/);
    expect(facilitator).to.match(/EXPOSE 8402/);
    expect(tools).to.match(/SLUICE_TOOLS_HOST=0\.0\.0\.0/);
    expect(tools).to.match(/SLUICE_TOOLS_PORT=8403/);
    expect(tools).to.match(/EXPOSE 8403/);
  });

  it("hold no key and no secret: no ARG or ENV names one, and the build is given nothing", () => {
    for (const text of [facilitator, tools]) {
      const lines = instructions(text).filter((l) => /^(ARG|ENV)\b/.test(l)).join("\n");
      expect(lines).to.not.match(/KEY|TOKEN|SECRET|PASSWORD|0x[0-9a-fA-F]{64}/);
      expect(lines).to.not.contain("SLUICE_APPROVE");
    }
    expect(instructions(facilitator).filter((l) => l.startsWith("ARG")).join("\n")).to.equal("ARG NODE_IMAGE=node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114");
  });

  it("keep the keys, the settings files and the deployment record out of the build context", () => {
    const ignore = read(".dockerignore");
    for (const pattern of ["**/*.key", ".env.*", "**/deployment.json", "**/*.jsonl", "**/KILL"]) expect(ignore, pattern).to.contain(pattern);
  });
});

// ---------------------------------------------------------------------------------------------- the entrypoint, run on stand-ins

/**
 * Runs an entrypoint's shell line with stand-ins for `id`, `chown`, `su-exec` and the program, which print what they were asked. Undefined
 * when this machine has no `sh` that can run them, so the check is skipped there and does not pretend.
 */
function runEntrypoint(line: string, name: string, env: Record<string, string>, uid: string): { out: string } | undefined {
  const bin = mkdtempSync(join(tmpdir(), "sluice-entrypoint-"));
  try {
    const script = (file: string, body: string): void => {
      writeFileSync(join(bin, file), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, file), 0o755);
    };
    script("id", `echo ${uid}`);
    script("chown", 'echo "chown $*"');
    script("su-exec", 'echo "su-exec $1"; shift; exec "$@"');
    script("app", 'echo "app port=$SLUICE_FACILITATOR_PORT toolsport=$SLUICE_TOOLS_PORT args=$*"');
    const probe = spawnSync("sh", ["-c", "id -u"], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }, encoding: "utf8" });
    if (probe.status !== 0 || probe.stdout.trim() !== uid) return undefined;
    const run = spawnSync("sh", ["-c", line, name, "app", "dist/cli.js"], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, ...env }, encoding: "utf8" });
    return { out: `${run.stdout}${run.stderr}`.replace(/\r/g, "").trim() };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("Hosting: what the images' entrypoints do", function () {
  this.timeout(60_000);
  const facilitator = entrypointLine(read("packages/facilitator/Dockerfile"));
  const tools = entrypointLine(read("examples/paid-tools/Dockerfile"));
  const base = { SLUICE_FACILITATOR_PORT: "8402", SLUICE_TOOLS_PORT: "8403" };

  it("use /bin/sh and a line that holds no key", () => {
    expect(facilitator.shell).to.equal("/bin/sh");
    expect(tools.shell).to.equal("/bin/sh");
    for (const e of [facilitator, tools]) expect(e.line).to.not.match(/KEY|SECRET|TOKEN|0x[0-9a-f]{64}/);
  });

  it("the facilitator, started as root: gives /data and the volume's mount path to node, then runs the program as node with the platform's PORT", function () {
    const r = runEntrypoint(facilitator.line, facilitator.name, { ...base, PORT: "9091", RAILWAY_VOLUME_MOUNT_PATH: "/mnt/vol" }, "0");
    if (!r) return this.skip();
    expect(r.out.split("\n")).to.deep.equal(["chown -R node:node /data /mnt/vol", "su-exec node", "app port=9091 toolsport=8403 args=dist/cli.js"]);
  });

  it("the facilitator, started as root with no PORT and no volume path: hands over /data only, and keeps its own port", function () {
    const r = runEntrypoint(facilitator.line, facilitator.name, { ...base, PORT: "", RAILWAY_VOLUME_MOUNT_PATH: "" }, "0");
    if (!r) return this.skip();
    expect(r.out.split("\n")).to.deep.equal(["chown -R node:node /data", "su-exec node", "app port=8402 toolsport=8403 args=dist/cli.js"]);
  });

  it("the facilitator, started as another user: does not chown and does not switch user, and runs the program as it was started", function () {
    const r = runEntrypoint(facilitator.line, facilitator.name, { ...base, PORT: "" }, "1000");
    if (!r) return this.skip();
    expect(r.out.split("\n")).to.deep.equal(["app port=8402 toolsport=8403 args=dist/cli.js"]);
  });

  it("the tool server uses the platform's PORT when there is one, and runs the program directly", function () {
    const withPort = runEntrypoint(tools.line, tools.name, { ...base, PORT: "7777" }, "1000");
    if (!withPort) return this.skip();
    expect(withPort.out).to.equal("app port=8402 toolsport=7777 args=dist/cli.js");
    const without = runEntrypoint(tools.line, tools.name, { ...base, PORT: "" }, "1000");
    expect(without?.out).to.equal("app port=8402 toolsport=8403 args=dist/cli.js");
  });
});

// ------------------------------------------------------------------------------------------------------------ the guides' tables

type Row = { name: string; kind: string; value: string; what: string };

/** The rows of the table that follows a heading: `| \`NAME\` | kind | value | what |`. */
function tableAfter(markdown: string, heading: string): Row[] {
  const at = markdown.indexOf(`\n${heading}\n`);
  if (at < 0) throw new Error(`no heading ${heading}`);
  const rows: Row[] = [];
  for (const l of markdown.slice(at).split("\n").slice(2)) {
    if (/^#{1,3} /.test(l)) break;
    const m = /^\| `([A-Z0-9_]+)` \| ([^|]+) \| ([^|]*) \| (.*) \|$/.exec(l);
    if (m) rows.push({ name: m[1] as string, kind: (m[2] as string).trim(), value: (m[3] as string).trim(), what: (m[4] as string).trim() });
  }
  return rows;
}
/** The `NAME=value` lines of the first ```text block after a heading. */
function pastedAfter(markdown: string, heading: string): Record<string, string> {
  const at = markdown.indexOf(heading);
  const open = markdown.indexOf("```text\n", at);
  const close = markdown.indexOf("\n```", open + 8);
  if (at < 0 || open < 0 || close < 0) throw new Error(`no text block after ${heading}`);
  const out: Record<string, string> = {};
  for (const l of markdown.slice(open + 8, close).split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

describe("Hosting: the Railway guide's variables are the ones the code reads and `pnpm live:wire` writes", () => {
  const railway = read("docs/HOSTING-RAILWAY.md");
  const files = wire({ network: "mainnet", chainId: 1990, router: ROUTER, vault: VAULT, block: 12119118, token: getAddress(QUSDC_ADDRESS) });
  const entriesOf = (suffix: string) => (files.find((f) => f.file.endsWith(suffix)) as (typeof files)[number]).entries;
  const facilitatorRows = tableAfter(railway, "### The facilitator variables");
  const toolRows = tableAfter(railway, "### The tool server variables");

  it("lists every setting live:wire writes for the facilitator and the tool server, with the same kind", () => {
    const kindWord = { public: "public", secret: "**secret**", you: "you fill in" } as const;
    for (const [suffix, rows] of [[".facilitator", facilitatorRows], [".tool-server", toolRows]] as const) {
      for (const entry of entriesOf(suffix)) {
        const row = rows.find((r) => r.name === entry.name);
        expect(row, `${suffix}: ${entry.name} is in the table`).to.not.equal(undefined);
        expect(row?.kind, `${suffix}: ${entry.name}`).to.equal(kindWord[entry.kind]);
      }
    }
  });

  it("adds what live:wire leaves out on purpose (the approval and the relayer's key), and nothing that is not read", () => {
    const left = NOT_WRITTEN.map(([name]) => name.split("=")[0] as string);
    expect(left).to.include.members(["SLUICE_APPROVE", "SLUICE_RELAYER_KEY"]);
    expect(facilitatorRows.map((r) => r.name)).to.include.members(["SLUICE_APPROVE", "SLUICE_RELAYER_KEY"]);
    const facilitatorCode = read("packages/facilitator/src/env.ts");
    const toolCode = read("examples/paid-tools/src/host.ts");
    for (const [rows, code] of [[facilitatorRows, facilitatorCode], [toolRows, toolCode]] as const) {
      for (const row of rows.filter((r) => r.name.startsWith("SLUICE_"))) {
        const read_ = code.includes(row.name);
        // A name the code does not read must say so in its row, and the only one is SLUICE_TOKEN.
        if (!read_) {
          expect(row.name).to.equal("SLUICE_TOKEN");
          expect(row.what).to.match(/Not read by/);
        }
      }
    }
  });

  it("marks exactly the relayer's key and the metrics tokens as secret, and no other row is called a key or a token", () => {
    const secret = [...facilitatorRows, ...toolRows].filter((r) => r.kind === "**secret**").map((r) => r.name).sort();
    expect(secret).to.deep.equal(["SLUICE_FACILITATOR_METRICS_TOKEN", "SLUICE_RELAYER_KEY", "SLUICE_TOOLS_METRICS_TOKEN"]);
    for (const row of [...facilitatorRows, ...toolRows].filter((r) => r.kind !== "**secret**")) {
      expect(row.name, row.name).to.not.match(/(KEY|SECRET|PASSWORD)$/);
    }
    expect(railway).to.contain("never goes in a file in the repository");
    expect(railway).to.match(/choose \*\*Seal\*\*/);
  });

  it("starts the real facilitator's settings reader with the lines it has the person paste, the values live:wire writes, and the three things only the person knows", () => {
    const pasted = pastedAfter(railway, "6. In **Variables**, choose **RAW Editor**, paste those lines");
    const wired = Object.fromEntries(entriesOf(".facilitator").filter((e) => e.kind === "public").map((e) => [e.name, e.value]));
    const env = readEnv({
      ...wired,
      ...pasted,
      SLUICE_RELAYER_KEY: FAKE_KEY,
      SLUICE_FACILITATOR_URL: "https://sluice-facilitator-production.up.railway.app",
      SLUICE_FACILITATOR_CORS_ORIGINS: "https://sluice.vercel.app",
      SLUICE_FACILITATOR_HOST: "0.0.0.0",
    });
    expect(env).to.deep.include({ network: "mainnet", chainId: 1990, router: ROUTER, statePath: "/data/queue.jsonl", killFile: "/data/KILL", trustedProxyHops: 1, host: "0.0.0.0" });
    expect(env.corsOrigins).to.deep.equal(["https://sluice.vercel.app"]);
    expect(env.caps.dailyBudgetWei).to.equal(5n * 10n ** 17n);
    expect(env.publicUrl).to.equal("https://sluice-facilitator-production.up.railway.app");
    // The settings the Dockerfile and the guide agree on: the queue is on the volume at /data.
    expect(read("packages/facilitator/Dockerfile")).to.contain(`SLUICE_FACILITATOR_STATE=${env.statePath}`);
    // A wildcard, a path, plain http and a missing queue are each refused, which is what the guide says.
    for (const bad of ["*", "https://sluice.vercel.app/", "http://sluice.vercel.app"]) {
      expect(() => readEnv({ ...wired, ...pasted, SLUICE_RELAYER_KEY: FAKE_KEY, SLUICE_FACILITATOR_CORS_ORIGINS: bad }), bad).to.throw(/refusing to start/);
    }
    expect(() => readEnv({ ...wired, ...pasted, SLUICE_RELAYER_KEY: FAKE_KEY, SLUICE_FACILITATOR_STATE: "" })).to.throw(/SLUICE_FACILITATOR_STATE/);
    expect(() => readEnv({ ...wired, ...pasted, SLUICE_RELAYER_KEY: FAKE_KEY, SLUICE_APPROVE: "" })).to.throw(/SLUICE_APPROVE/);
  });

  it("starts the real tool server's settings reader with the lines it has the person paste", () => {
    const pasted = pastedAfter(railway, "4. In **RAW Editor**, paste those lines and add these.");
    const wired = Object.fromEntries(entriesOf(".tool-server").filter((e) => e.kind === "public").map((e) => [e.name, e.value]));
    const env = readToolServerEnv({
      ...wired,
      ...pasted,
      SLUICE_PAYEE: BUILDER,
      SLUICE_FACILITATOR_URL: "https://sluice-facilitator-production.up.railway.app",
      SLUICE_TOOLS_CORS_ORIGINS: "https://sluice.vercel.app",
      SLUICE_TOOLS_HOST: "0.0.0.0",
    });
    expect(env).to.deep.include({ network: "mainnet", chainId: 1990, router: ROUTER, payee: BUILDER, trustedProxyHops: 1 });
    expect(env.corsOrigins).to.deep.equal(["https://sluice.vercel.app"]);
    for (const bad of ["*", "https://sluice.vercel.app/path", "http://sluice.vercel.app"]) {
      expect(() => readToolServerEnv({ ...wired, ...pasted, SLUICE_PAYEE: BUILDER, SLUICE_TOOLS_CORS_ORIGINS: bad }), bad).to.throw(/refusing to start/);
    }
    // Railway's private network is plain http, which the tool server refuses for the facilitator.
    expect(() => readToolServerEnv({ ...wired, ...pasted, SLUICE_PAYEE: BUILDER, SLUICE_FACILITATOR_URL: "http://sluice-facilitator.railway.internal:8402" })).to.throw(/SLUICE_FACILITATOR_URL must be https/);
  });

  it("points each service at its own Dockerfile, which exists, builds from the repository root, and gives the tool server no volume", () => {
    expect(railway).to.contain("`/packages/facilitator/Dockerfile`");
    expect(railway).to.contain("`/examples/paid-tools/Dockerfile`");
    expect(existsSync(join(ROOT, "packages/facilitator/Dockerfile"))).to.equal(true);
    expect(existsSync(join(ROOT, "examples/paid-tools/Dockerfile"))).to.equal(true);
    expect(railway).to.match(/Leave the Root Directory empty/);
    expect(railway).to.match(/Do not add a volume/);
    // The tool server writes no file, so the claim that it needs no volume is checked in its source.
    const sources = safeReaddir(join(ROOT, "examples/paid-tools/src")).filter((f) => f.endsWith(".ts")).map((f) => read(`examples/paid-tools/src/${f}`)).join("\n");
    expect(sources).to.not.match(/writeFile|appendFile|createWriteStream|mkdirSync/);
  });

  it("names the health check path both services answer, and the drain time the facilitator's own shutdown wait fits inside", () => {
    expect(railway.match(/\*\*Healthcheck Path\*\* to `\/health`/g)).to.have.length(2);
    expect(read("packages/facilitator/src/server.ts")).to.contain('path === "/health"');
    expect(read("examples/paid-tools/src/host.ts")).to.contain('"/health"');
    const draining = Number(/`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` \| Railway setting \| `(\d+)`/.exec(railway)?.[1]);
    const shutdownMs = 30_000; // the facilitator's default wait for a batch in progress (SLUICE_FACILITATOR_SHUTDOWN_MS)
    expect(read("packages/facilitator/src/env.ts")).to.contain("env.SLUICE_FACILITATOR_SHUTDOWN_MS, 30_000");
    expect(draining * 1000).to.be.greaterThan(shutdownMs);
  });

  it("never tells a person to put the relayer key in a file in the repository, or to type it on a command line", () => {
    for (const block of railway.split("```").filter((_, i) => i % 2 === 1)) {
      expect(block).to.not.match(/SLUICE_RELAYER_KEY\s*=\s*['"]?0x/);
      expect(block).to.not.match(/0x[0-9a-fA-F]{64}/);
    }
    expect(railway).to.contain("(Get-Content .\\relayer-mainnet.key -Raw).Trim() | Set-Clipboard");
    expect(railway).to.not.match(/write the key to a file|save the key in/i);
  });
});

describe("Hosting: the Vercel guide's variables are the ones the web app reads and `pnpm live:wire` writes", () => {
  const vercel = read("docs/HOSTING-VERCEL.md");
  const files = wire({ network: "mainnet", chainId: 1990, router: ROUTER, vault: VAULT, block: 12119118, token: getAddress(QUSDC_ADDRESS) });
  const web = (files.find((f) => f.file.endsWith(".web")) as (typeof files)[number]).entries;
  const rows = [...tableAfter(vercel, "### The values from `.env.mainnet.web`"), ...tableAfter(vercel, "### What you fill in, now that the two Railway addresses exist")];

  it("lists every setting live:wire writes for the web app, with the same kind", () => {
    const kindWord = { public: "public", secret: "**secret**", you: "you fill in" } as const;
    for (const entry of web) {
      const row = rows.find((r) => r.name === entry.name);
      expect(row, entry.name).to.not.equal(undefined);
      expect(row?.kind, entry.name).to.equal(kindWord[entry.kind]);
    }
  });

  it("names every public setting the app reads, and none it does not", () => {
    for (const name of PUBLIC_ENV_NAMES) expect(vercel, name).to.contain(`\`${name}\``);
    for (const m of vercel.matchAll(/`(NEXT_PUBLIC_[A-Z0-9_]+)`/g)) expect(PUBLIC_ENV_NAMES as readonly string[], m[1]).to.include(m[1]);
  });

  it("says nothing secret goes in the project, and names the secrets that must never be set there", () => {
    expect(vercel).to.contain("every `NEXT_PUBLIC_` value reaches the browser");
    for (const name of ["SLUICE_KEY", "SLUICE_RELAYER_KEY", "SLUICE_AGENT_KEY", "SLUICE_APPROVE"]) expect(vercel).to.contain(`\`${name}\``);
    expect(rows.filter((r) => r.kind === "**secret**")).to.deep.equal([]);
  });

  it("gives the settings DEPLOY-WEB.md gives for the root directory, the install and the build", () => {
    const deployWeb = read("docs/DEPLOY-WEB.md");
    for (const setting of ["apps/web", "pnpm install --frozen-lockfile", "pnpm run build", "24.x"]) {
      expect(vercel, setting).to.contain(setting);
      expect(deployWeb, setting).to.contain(setting);
    }
  });

  it("hands the web app's origin to both Railway services, and never a wildcard", () => {
    expect(vercel).to.contain("`SLUICE_FACILITATOR_CORS_ORIGINS`");
    expect(vercel).to.contain("`SLUICE_TOOLS_CORS_ORIGINS`");
    expect(vercel).to.match(/Never a wildcard/);
    expect(read("docs/HOSTING-RAILWAY.md")).to.match(/\*\*never a wildcard\*\*/);
  });
});

describe("Hosting: the commands in the guides use options the host check has", () => {
  const optionsOfScript = new Set([...read("scripts/live/hostcheck.ts").matchAll(/"(--[a-z]+)"/g)].map((m) => m[1] as string));

  it("every pnpm live:hostcheck line in the guides uses only --facilitator, --tools, --router and --origin", () => {
    expect([...optionsOfScript].sort()).to.deep.equal(["--facilitator", "--origin", "--router", "--tools"]);
    let seen = 0;
    for (const file of ["docs/HOSTING-RAILWAY.md", "docs/HOSTING-VERCEL.md", "docs/OPERATIONS.md"]) {
      for (const m of read(file).matchAll(/^\s*pnpm live:hostcheck (.*)$/gm)) {
        seen += 1;
        for (const flag of (m[1] as string).match(/--[a-z]+/g) ?? []) expect(optionsOfScript.has(flag), `${file}: ${flag}`).to.equal(true);
        expect(m[1], file).to.match(/--facilitator https:\/\/\S+ --tools https:\/\/\S+/);
      }
    }
    expect(seen).to.be.greaterThan(3);
  });

  it("is a script in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["live:hostcheck"]).to.equal("ts-node scripts/live/hostcheck.ts");
  });
});
