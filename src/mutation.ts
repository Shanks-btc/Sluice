// A small mutation check. It changes one condition at a time in the code that decides what is accepted, what is charged and
// what a budget allows, runs the tests that are meant to catch that, and reports whether they did.
//
//   KILLED    the tests failed: the change was noticed.
//   SURVIVED  the tests passed: nothing notices that the code is now wrong.
//   BROKEN    the mutated code did not load, so the run says nothing about the tests.
//
// The engine never leaves a file changed: the original is kept in the system's temporary folder, restored after each run,
// restored again on an interrupt, and checked against its hash at the end.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Mutation = {
  id: string;
  /** Path from the repository root. */
  file: string;
  /** The exact text to change. It must occur once in the file. */
  find: string;
  replace: string;
  /** What the change does, in a sentence. */
  why: string;
  /** Test files that should fail because of it, from the repository root. */
  tests: string[];
};

export type MutationResult = { id: string; status: "KILLED" | "SURVIVED" | "BROKEN"; detail: string };

export type TestRun = { passed: boolean; failing: number; output: string };
export type Runner = (files: string[]) => TestRun;

export class MutationError extends Error {}

/** The source with the mutation applied. Throws unless `find` occurs exactly once. */
export function applyMutation(source: string, m: Mutation): string {
  const first = source.indexOf(m.find);
  if (first < 0) throw new MutationError(`${m.id}: the text to change is not in ${m.file}`);
  if (source.indexOf(m.find, first + 1) >= 0) throw new MutationError(`${m.id}: the text to change occurs more than once in ${m.file}`);
  if (m.find === m.replace) throw new MutationError(`${m.id}: the change does nothing`);
  return source.slice(0, first) + m.replace + source.slice(first + m.find.length);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Runs every mutation. Whatever happens, each file is back to its original text when this returns or throws. */
export function runMutations(
  root: string,
  mutations: Mutation[],
  runner: Runner,
  log: (line: string) => void = () => undefined,
): MutationResult[] {
  const backupDir = mkdtempSync(join(tmpdir(), "sluice-mutation-"));
  const originals = new Map<string, string>();
  const hashes = new Map<string, string>();
  let current: string | undefined;

  const restore = () => {
    if (current === undefined) return;
    const text = originals.get(current);
    if (text !== undefined) writeFileSync(join(root, current), text);
    current = undefined;
  };
  const onSignal = () => {
    restore();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for (const m of mutations) {
      if (!originals.has(m.file)) {
        const text = readFileSync(join(root, m.file), "utf8");
        originals.set(m.file, text);
        hashes.set(m.file, sha(text));
        writeFileSync(join(backupDir, `${m.file.replace(/[\\/]/g, "__")}.orig`), text); // a second copy outside the repository
      }
    }

    const baseline = runner([...new Set(mutations.flatMap((m) => m.tests))]);
    if (!baseline.passed) throw new MutationError(`the tests fail before any change, so a mutation run would say nothing:\n${baseline.output.slice(-1500)}`);
    log("baseline: the tests pass without any change");

    const results: MutationResult[] = [];
    for (const m of mutations) {
      const original = originals.get(m.file) as string;
      let mutated: string;
      try {
        mutated = applyMutation(original, m);
      } catch (err) {
        results.push({ id: m.id, status: "BROKEN", detail: err instanceof Error ? err.message : "could not apply" });
        log(`${m.id}: BROKEN (${(err as Error).message})`);
        continue;
      }
      current = m.file;
      writeFileSync(join(root, m.file), mutated);
      let run: TestRun;
      try {
        run = runner(m.tests);
      } finally {
        restore();
      }
      const loaded = !/SyntaxError|Cannot find module|TSError/.test(run.output);
      const result: MutationResult = !run.passed
        ? loaded
          ? { id: m.id, status: "KILLED", detail: `${run.failing} test${run.failing === 1 ? "" : "s"} failed` }
          : { id: m.id, status: "BROKEN", detail: "the mutated code did not load" }
        : { id: m.id, status: "SURVIVED", detail: "the tests still pass" };
      results.push(result);
      log(`${m.id}: ${result.status} (${result.detail})`);
    }

    for (const [file, text] of originals) {
      if (sha(readFileSync(join(root, file), "utf8")) !== hashes.get(file) || readFileSync(join(root, file), "utf8") !== text) {
        throw new MutationError(`${file} is not back to its original text`);
      }
    }
    return results;
  } finally {
    restore();
    for (const [file, text] of originals) writeFileSync(join(root, file), text);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    rmSync(backupDir, { recursive: true, force: true });
  }
}

export function summarizeResults(results: MutationResult[]): { killed: number; survived: number; broken: number } {
  return {
    killed: results.filter((r) => r.status === "KILLED").length,
    survived: results.filter((r) => r.status === "SURVIVED").length,
    broken: results.filter((r) => r.status === "BROKEN").length,
  };
}
