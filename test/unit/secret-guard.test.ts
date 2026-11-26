// No test run opens a secret file. Three things hold that: every walk over the repository skips secret names by their path
// (src/secret-paths.js), the guard refuses to open one outside the temp folder and fails the run that tried (test/helpers/secret-guard.js,
// installed by hardhat.config.ts), and the checks here read the code for a walk or a path that would get round them.
//
// Nothing here opens a real secret file. The paths the guard is tried on are in a folder that does not exist, and the refusal comes before
// the file system is asked.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { copyable, isSecretName, isSecretPath, safeEntries, safeReaddir } from "../../src/secret-paths";
import * as guard from "../helpers/secret-guard";
import { inheritedEnv } from "../helpers/spawn";

const ROOT = join(__dirname, "..", "..");
const NOWHERE = "no-such-folder-for-the-secret-guard";
const SECRET_NAMES = ["x.key", "DEPLOYER-MAINNET.KEY", ".env", ".env.local", ".env.mainnet.web", ".env.example.bak", "deployment.json", "Deployment.json", ".local-mainnet"];

// A hook outside every describe block runs after all the tests of the run, whichever file they are in.
after("no test opened a secret file", () => {
  const refused = guard.violations();
  if (refused.length > 0) throw new Error(`a secret file was reached for during the run: ${refused.map((v) => `${v.operation} ${v.path}`).join("; ")}`);
});

describe("Secret files: which names are secret", () => {
  it("knows the key files, the env files, the deployment record and the local run's folder, in any case", () => {
    for (const name of SECRET_NAMES) expect(isSecretName(name), name).to.equal(true);
    for (const path of [".local-mainnet/queue.jsonl", ".local-mainnet\\agent.key", "a/b/.env", "C:\\somewhere\\relayer.key", "keys.key/inside.txt"]) expect(isSecretPath(path), path).to.equal(true);
  });

  it("leaves the example env file and ordinary names alone", () => {
    for (const name of [".env.example", "env", "environment.ts", "key.md", "keys.ts", "deployment.json.md", "testnet-token.json", "local-mainnet", "docs/DEPLOY-WEB.md"]) {
      expect(isSecretPath(name), name).to.equal(false);
    }
  });

  it("walks a folder without reaching a secret file, and copies one without reading it", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "sluice-walk-"));
    try {
      const from = join(dir, "from");
      for (const sub of [from, join(from, ".local-mainnet"), join(from, "kept")]) fs.mkdirSync(sub);
      for (const file of ["a.ts", ".env.example", "a.key", ".env", ".env.mainnet.web", "deployment.json", join(".local-mainnet", "queue.jsonl"), join("kept", "b.ts"), join("kept", "b.key")]) {
        fs.writeFileSync(join(from, file), "throwaway");
      }
      expect(safeReaddir(from).sort()).to.deep.equal([".env.example", "a.ts", "kept"]);
      expect(safeEntries(from).map((e) => e.name).sort()).to.deep.equal([".env.example", "a.ts", "kept"]);
      expect(safeReaddir(join(from, ".local-mainnet"))).to.deep.equal([]);
      const to = join(dir, "to");
      fs.cpSync(from, to, { recursive: true, filter: copyable });
      expect(fs.readdirSync(to).sort()).to.deep.equal([".env.example", "a.ts", "kept"]);
      expect(fs.readdirSync(join(to, "kept"))).to.deep.equal(["b.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Secret files: the guard of the test run", () => {
  type Attempt = [string, (path: string) => unknown];
  const elsewhere = join(ROOT, "package.json");
  const out = join(tmpdir(), "sluice-guard-never-written");
  const synchronous: Attempt[] = [
    ["readFileSync", (p) => fs.readFileSync(p, "utf8")],
    ["readFile", (p) => fs.readFile(p, () => undefined)],
    ["openSync", (p) => fs.openSync(p, "r")],
    ["open", (p) => fs.open(p, "r", () => undefined)],
    ["createReadStream", (p) => fs.createReadStream(p)],
    ["createWriteStream", (p) => fs.createWriteStream(p)],
    ["writeFileSync", (p) => fs.writeFileSync(p, "x")],
    ["appendFileSync", (p) => fs.appendFileSync(p, "x")],
    ["copyFileSync", (p) => fs.copyFileSync(p, out)],
    ["copyFileSync", (p) => fs.copyFileSync(elsewhere, p)],
    ["cpSync", (p) => fs.cpSync(p, out, { recursive: true })],
  ];
  const promised: Attempt[] = [
    ["readFile", (p) => fs.promises.readFile(p)],
    ["open", (p) => fs.promises.open(p)],
    ["writeFile", (p) => fs.promises.writeFile(p, "x")],
    ["copyFile", (p) => fs.promises.copyFile(p, out)],
    ["cp", (p) => fs.promises.cp(p, out, { recursive: true })],
  ];
  const probePath = (name: string) => join(ROOT, NOWHERE, name);

  it("is installed for this run", () => {
    expect(guard.installed()).to.equal(true);
  });

  it("refuses every way of opening a secret file in the repository, before the file is touched", () => {
    for (const name of ["x.key", ".env", ".env.mainnet.web", "deployment.json", join(".local-mainnet", "queue.jsonl")]) {
      for (const [operation, attempt] of synchronous) {
        const tried = guard.probe(() => attempt(probePath(name)));
        expect(tried.error?.code, `${operation} ${name}`).to.equal("ESECRETFILE");
        expect(tried.refused.map((r) => [r.operation, r.path]), `${operation} ${name}`).to.deep.equal([[operation, probePath(name)]]);
      }
    }
    expect(fs.existsSync(join(ROOT, NOWHERE)), "nothing was made").to.equal(false);
    expect(fs.existsSync(out), "nothing was copied").to.equal(false);
  });

  it("refuses the forms that give a promise as well", async () => {
    for (const [operation, attempt] of promised) {
      const tried = guard.probe(() => attempt(probePath("x.key")) as Promise<unknown>);
      const failure = await tried.result?.then(() => undefined, (e: Error & { code?: string }) => e);
      expect(failure?.code, operation).to.equal("ESECRETFILE");
      expect(tried.refused.map((r) => r.operation), operation).to.deep.equal([operation]);
    }
  });

  it("refuses a relative path, a URL, and a secret file anywhere else that is not the temp folder", () => {
    const relativeToHere = relative(process.cwd(), probePath("x.key"));
    for (const target of [relativeToHere, pathToFileURL(probePath(".env")), join(homedir(), NOWHERE, "x.key")]) {
      expect(guard.probe(() => fs.readFileSync(target)).error?.code, String(target)).to.equal("ESECRETFILE");
    }
  });

  it("says the path in a refusal and nothing from any file", () => {
    const tried = guard.probe(() => fs.readFileSync(probePath("x.key"), "utf8"));
    expect(tried.error?.message).to.equal(`secret file guard: refused to readFileSync ${probePath("x.key")}. A test run opens no secret file outside the temp folder.`);
  });

  it("lets a test make and read a throwaway key file in the temp folder, and read the files that are not secret", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "sluice-guard-"));
    try {
      const tried = guard.probe(() => {
        fs.writeFileSync(join(dir, "throwaway.key"), "throwaway");
        fs.writeFileSync(join(dir, ".env.mainnet.web"), "A=1\n");
        return [fs.readFileSync(join(dir, "throwaway.key"), "utf8"), fs.readFileSync(join(dir, ".env.mainnet.web"), "utf8")];
      });
      expect(tried.result).to.deep.equal(["throwaway", "A=1\n"]);
      expect(tried.refused).to.deep.equal([]);
      const ordinary = guard.probe(() => [fs.readFileSync(join(ROOT, ".env.example")).length > 0, fs.readFileSync(elsewhere).length > 0]);
      expect(ordinary.result).to.deep.equal([true, true]);
      expect(ordinary.refused).to.deep.equal([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("goes with every program a test starts, and with the programs those start, whatever environment they are given", function () {
    this.timeout(60_000);
    const dir = fs.mkdtempSync(join(tmpdir(), "sluice-guard-child-"));
    try {
      const log = join(dir, "refused.log");
      const target = probePath("x.key");
      const attempt = `try { require("node:fs").readFileSync(${JSON.stringify(target)}); console.log("opened"); } catch (e) { console.log(e.code); }`;
      // The child starts a grandchild with nothing but the variables a program needs to start: no setting of the guard's is passed by hand.
      const child = `${attempt}
        const env = {}; for (const n of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[n] !== undefined) env[n] = process.env[n];
        process.stdout.write(require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(attempt)}], { env, encoding: "utf8" }).stdout);`;
      // The child's refusals go to a log of this test's own, so that they do not count against the run.
      const run = spawnSync(process.execPath, ["-e", child], { cwd: ROOT, env: { ...inheritedEnv(), [guard.LOG_ENV]: log }, encoding: "utf8" });
      expect(run.status, run.stderr).to.equal(0);
      expect(run.stdout.trim().split(/\r?\n/)).to.deep.equal(["ESECRETFILE", "ESECRETFILE"]);
      const written = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { operation: string; path: string; pid: number });
      expect(written.map((w) => [w.operation, w.path])).to.deep.equal([["readFileSync", target], ["readFileSync", target]]);
      expect(new Set(written.map((w) => w.pid)).size, "two different programs").to.equal(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ reading the code

/** Every TypeScript file of the programs, the scripts, the tests and the web app. */
function typescriptFiles(): string[] {
  const walk = (dir: string): string[] =>
    safeEntries(join(ROOT, dir)).flatMap((entry) => {
      if (["node_modules", "dist", ".next", "artifacts", "cache", "generated"].includes(entry.name)) return [];
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  return ["src", "scripts", "test", "packages", "examples", "apps/web/src", "apps/web/test-support"].filter((dir) => fs.existsSync(join(ROOT, dir))).flatMap(walk);
}

/** `file:line` for every line the rule matches. This file is left out: it states the rules, and tries the guard on purpose. */
function linesWhere(files: string[], rule: (line: string) => boolean): string[] {
  return files
    .filter((file) => file !== "test/unit/secret-guard.test.ts")
    .flatMap((file) => fs.readFileSync(join(ROOT, file), "utf8").split("\n").flatMap((line, i) => (rule(line) ? [`${file}:${i + 1}`] : [])));
}

const readsAFolderItself = (line: string): boolean => /\b(readdirSync|readdir|opendirSync|opendir|globSync)\s*\(/.test(line);
const copiesWithoutTheFilter = (line: string): boolean => /\b(cpSync|promises\.cp|fs\.cp)\s*\(/.test(line) && !line.includes("filter: copyable");
/** A path that names a secret file of the repository: joined to the repository's folder, or a relative name handed to a function that reads. */
const namesARepositorySecret = (line: string): boolean => {
  const joined = [...line.matchAll(/\b(?:join|resolve)\(\s*(?:ROOT|__dirname)\b([^()]*)\)/g)].flatMap((m) => [...(m[1] as string).matchAll(/["'`]([^"'`]*)["'`]/g)].map((s) => s[1] as string));
  const read = [...line.matchAll(/\b(?:read|readFileSync|readFile|openSync|createReadStream)\(\s*["'`]([^"'`$]+)["'`]/g)].map((m) => m[1] as string);
  return [...joined, ...read].some(isSecretPath);
};

describe("Secret files: the code cannot get round the filter", () => {
  const files = typescriptFiles();
  const testFiles = files.filter((file) => file.startsWith("test/"));

  it("looks at the code it should", () => {
    expect(files).to.include.members(["src/vaultcheck.ts", "test/unit/docs.test.ts", "test/fork/live.fork.test.ts", "scripts/live/hostcheck.ts", "apps/web/src/lib/config.ts"]);
    expect(testFiles.length).to.be.greaterThan(40);
  });

  it("reads folders only through safeReaddir and safeEntries", () => {
    expect(linesWhere(files, readsAFolderItself)).to.deep.equal([]);
  });

  it("gives every recursive copy the filter", () => {
    expect(linesWhere(files, copiesWithoutTheFilter)).to.deep.equal([]);
  });

  it("has no test file, in any test folder, that names a secret file of the repository to open it", () => {
    expect(linesWhere(testFiles, namesARepositorySecret)).to.deep.equal([]);
  });

  it("controls: the rules catch what they should, and leave a throwaway file in a temp folder alone", () => {
    for (const bad of ["readdirSync(dir)", "await readdir (dir)", "fs.opendirSync(root)", "globSync(`**/*`)"]) expect(readsAFolderItself(bad), bad).to.equal(true);
    for (const good of ["safeReaddir(dir)", "safeEntries(dir)", 'import { readdirSync } from "node:fs";']) expect(readsAFolderItself(good), good).to.equal(false);
    expect(copiesWithoutTheFilter("cpSync(from, to, { recursive: true });")).to.equal(true);
    expect(copiesWithoutTheFilter("cpSync(from, to, { recursive: true, filter: copyable });")).to.equal(false);
    for (const bad of ['readFileSync(join(ROOT, "deployer-mainnet.key"), "utf8")', 'read(".env.mainnet.web")', 'join(__dirname, "..", "..", "deployment.json")', 'openSync(".local-mainnet/agent.key")']) {
      expect(namesARepositorySecret(bad), bad).to.equal(true);
    }
    for (const good of ['readFileSync(join(dir, "deployer-mainnet.key"))', 'read(".env.example")', 'writeFileSync(join(work, ".env.mainnet.web"), "")', 'join(ROOT, "docs", "EVIDENCE.md")']) {
      expect(namesARepositorySecret(good), good).to.equal(false);
    }
  });
});
