// The guard of a test run. It refuses to open a secret file (see src/secret-paths.js) to read, write or copy it, everywhere but in the
// temp folder, where the tests make throwaway ones. The refusal comes before the file is touched. Each refusal is also written down, so
// that a run fails even when the program that tried swallowed the error.
//
// hardhat.config.ts installs it before any test file is loaded. It hands itself on to every program the run starts, and to the programs
// those start, through NODE_OPTIONS. This is plain JavaScript so that Node can load it into them before TypeScript is set up.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { promisify } = require("node:util");
const { fileURLToPath } = require("node:url");
const { isSecretPath } = require("../../src/secret-paths");

/**
 * The file the refusals are written to. A program the run starts is told it, and installs the guard as soon as it loads this file. The
 * variable's name must not look like a secret's: a test holds that no such name reaches the program behind the payment proxy.
 */
const LOG_ENV = "FILE_GUARD_LOG";
const ROOT = path.resolve(__dirname, "..", "..");
const REQUIRE = `--require "${__filename.split("\\").join("/")}"`;
const KEY = Symbol.for("sluice.secretGuard");

function build(logFile) {
  const seen = [];
  let probing;
  const appendToLog = fs.appendFileSync;
  const readLog = fs.readFileSync;
  const temps = [os.tmpdir()];
  try {
    temps.push(fs.realpathSync.native(os.tmpdir()));
  } catch {
    // the temp folder as it is named is enough
  }

  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const within = (file, dir) => {
    const rel = path.relative(fold(dir), fold(file));
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const asPath = (value) => {
    if (typeof value === "string") return value;
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
    return undefined; // a file descriptor or an open handle: its path was checked when it was opened
  };

  /** The full path, when it may not be opened. */
  function blocked(value) {
    const text = asPath(value);
    if (text === undefined) return undefined;
    // Windows has a long form of a path that starts \\?\, which a recursive copy hands to its filter.
    const full = path.resolve(text.startsWith("\\\\?\\") ? text.slice(4) : text);
    const inRepository = within(full, ROOT);
    if (!inRepository && temps.some((temp) => within(full, temp))) return undefined;
    return isSecretPath(inRepository ? path.relative(ROOT, full) : full) ? full : undefined;
  }

  /** Writes the refusal down, and gives the error to throw. It holds the path and never anything from the file. */
  function refuse(operation, full) {
    const record = { operation, path: full, pid: process.pid };
    if (probing) probing.push(record);
    else {
      seen.push(record);
      try {
        appendToLog(logFile, `${JSON.stringify(record)}\n`);
      } catch {
        // the record in memory still fails this process's run
      }
    }
    const error = new Error(`secret file guard: refused to ${operation} ${full}. A test run opens no secret file outside the temp folder.`);
    error.code = "ESECRETFILE";
    return error;
  }

  /** The first of these arguments that may not be opened. */
  const firstBlocked = (args, which) => {
    for (const i of which) {
      const full = blocked(args[i]);
      if (full !== undefined) return full;
    }
    return undefined;
  };

  /** Replaces `target[name]` with one that looks at its path arguments first. `rejects` is for the functions that give a promise. */
  function guard(target, name, which, rejects = false) {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function guarded(...args) {
      const full = firstBlocked(args, which);
      if (full === undefined) return original.apply(this, args);
      const error = refuse(name, full);
      if (rejects) return Promise.reject(error);
      throw error;
    };
    Object.assign(wrapped, original); // the properties some of them carry, like realpath.native
    if (original[promisify.custom]) wrapped[promisify.custom] = original[promisify.custom];
    target[name] = wrapped;
  }

  for (const name of ["readFileSync", "readFile", "openSync", "open", "createReadStream", "createWriteStream", "writeFileSync", "writeFile", "appendFileSync", "appendFile"]) guard(fs, name, [0]);
  for (const name of ["copyFileSync", "copyFile"]) guard(fs, name, [0, 1]);
  guard(fs, "openAsBlob", [0], true);
  for (const name of ["readFile", "open", "writeFile", "appendFile"]) guard(fs.promises, name, [0], true);
  guard(fs.promises, "copyFile", [0, 1], true);

  // A recursive copy reads files without calling any function above, so each entry is looked at through the copy's own filter.
  function guardCopy(target, name, rejects) {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function guardedCopy(source, destination, ...rest) {
      const full = firstBlocked([source, destination], [0, 1]);
      if (full !== undefined) {
        const error = refuse(name, full);
        if (rejects) return Promise.reject(error);
        throw error;
      }
      const options = typeof rest[0] === "function" ? undefined : rest.shift();
      const wanted = options?.filter;
      const allowed = (from, to) => {
        const bad = firstBlocked([from, to], [0, 1]);
        if (bad === undefined) return true;
        refuse(name, bad); // written down, and passed over
        return false;
      };
      const filter = (from, to) => {
        const answer = wanted ? wanted(from, to) : true;
        if (answer && typeof answer.then === "function") return answer.then((yes) => Boolean(yes) && allowed(from, to));
        return Boolean(answer) && allowed(from, to);
      };
      return original.call(this, source, destination, { ...(options ?? {}), filter }, ...rest);
    };
  }
  guardCopy(fs, "cpSync", false);
  guardCopy(fs, "cp", false);
  guardCopy(fs.promises, "cp", true);

  // Every program started from here gets the guard too, whatever environment it is given.
  const guardedEnv = (env) => {
    const out = { ...(env ?? process.env) };
    const options = out.NODE_OPTIONS ?? "";
    if (!options.includes(REQUIRE)) out.NODE_OPTIONS = `${options} ${REQUIRE}`.trim();
    if (!out[LOG_ENV]) out[LOG_ENV] = logFile;
    return out;
  };
  /** The arguments of a child_process call, with the options (made if there were none) holding the guarded environment. */
  const withEnv = (args) => {
    const out = [...args];
    const callback = typeof out[out.length - 1] === "function" ? out.pop() : undefined;
    let at = out.findIndex((a, i) => i > 0 && a !== null && typeof a === "object" && !Array.isArray(a));
    if (at === -1) {
      at = Array.isArray(out[1]) ? 2 : 1;
      while (out.length > at && (out[at] === undefined || out[at] === null)) out.splice(at, 1);
    }
    out[at] = { ...(out[at] ?? {}), env: guardedEnv(out[at]?.env) };
    if (callback) out.push(callback);
    return out;
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = childProcess[name];
    const wrapped = function guardedStart(...args) {
      return original.apply(this, withEnv(args));
    };
    const custom = original[promisify.custom];
    // Node's own promise form calls the original, so it is given the same environment.
    if (custom) wrapped[promisify.custom] = (...args) => custom(...withEnv(args));
    childProcess[name] = wrapped;
  }

  syncBuiltinESMExports();

  return {
    /** Every refusal of this run: this process's, and those of the programs it started, which write to the same file. */
    violations() {
      let written = [];
      try {
        written = String(readLog(logFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        // no file: nothing was refused anywhere else
      }
      const all = new Map([...written, ...seen].map((v) => [`${v.pid}|${v.operation}|${v.path}`, v]));
      return [...all.values()];
    },
    /** For the guard's own tests: runs something, and gives back what it refused without counting it against the run. */
    probe(run) {
      const outer = probing;
      const refused = [];
      probing = refused;
      try {
        return { result: run(), error: undefined, refused };
      } catch (error) {
        return { result: undefined, error, refused };
      } finally {
        probing = outer;
      }
    },
  };
}

/** Installs the guard in this process, once. */
function install() {
  if (!globalThis[KEY]) globalThis[KEY] = build(process.env[LOG_ENV] || path.join(os.tmpdir(), `sluice-secret-guard-${process.pid}-${Date.now()}.log`));
}

const current = () => {
  const guard = globalThis[KEY];
  if (!guard) throw new Error("the secret file guard is not installed: run the tests through Hardhat, whose config installs it");
  return guard;
};

module.exports = {
  LOG_ENV,
  install,
  installed: () => Boolean(globalThis[KEY]),
  violations: () => current().violations(),
  probe: (run) => current().probe(run),
};

if (process.env[LOG_ENV]) install();
