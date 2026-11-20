// The mutation check's engine and its list. The engine is tested on a scratch folder; the list is checked against the real
// source, so a refactor that moves a line fails here and the list is updated, instead of silently testing nothing.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { MutationError, applyMutation, runMutations, summarizeResults } from "../../src/mutation";
import type { Mutation, Runner } from "../../src/mutation";
import { MUTATIONS } from "../../scripts/mutation-check";

const root = join(__dirname, "..", "..");

describe("Mutation check: the engine", () => {
  const base: Mutation = { id: "T1", file: "a.ts", find: "x > 1", replace: "x >= 1", why: "w", tests: ["t.test.ts"] };

  it("applies a change that matches exactly once, and refuses one that matches never, twice or changes nothing", () => {
    expect(applyMutation("if (x > 1) y();", base)).to.equal("if (x >= 1) y();");
    expect(() => applyMutation("nothing here", base)).to.throw(MutationError, /not in/);
    expect(() => applyMutation("x > 1; x > 1;", base)).to.throw(MutationError, /more than once/);
    expect(() => applyMutation("x > 1", { ...base, replace: "x > 1" })).to.throw(MutationError, /does nothing/);
  });

  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-mut-test-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "if (x > 1) y();\n");
    writeFileSync(join(dir, "b.ts"), "if (z) w();\n");
    return dir;
  };

  it("reports a change the tests notice as KILLED and one they do not as SURVIVED, and puts every file back", () => {
    const dir = scratch();
    const seen: string[] = [];
    // A test run that fails exactly when a.ts contains the mutated text.
    const runner: Runner = () => {
      const text = readFileSync(join(dir, "a.ts"), "utf8");
      seen.push(text.trim());
      const failed = text.includes("x >= 1");
      return { passed: !failed, failing: failed ? 2 : 0, output: failed ? "2 failing" : "passing" };
    };
    const results = runMutations(dir, [base, { id: "T2", file: "b.ts", find: "if (z)", replace: "if (!z)", why: "w", tests: ["t"] }], runner);
    expect(results).to.deep.equal([
      { id: "T1", status: "KILLED", detail: "2 tests failed" },
      { id: "T2", status: "SURVIVED", detail: "the tests still pass" },
    ]);
    expect(seen).to.include("if (x >= 1) y();");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).to.equal("if (x > 1) y();\n");
    expect(readFileSync(join(dir, "b.ts"), "utf8")).to.equal("if (z) w();\n");
    expect(summarizeResults(results)).to.deep.equal({ killed: 1, survived: 1, broken: 0 });
  });

  it("reports code that no longer loads as BROKEN, never as a caught change", () => {
    const dir = scratch();
    let n = 0;
    const runner: Runner = () => (n++ === 0 ? { passed: true, failing: 0, output: "" } : { passed: false, failing: 1, output: "SyntaxError: Unexpected token" });
    expect(runMutations(dir, [base], runner)[0]).to.deep.include({ id: "T1", status: "BROKEN" });
  });

  it("restores the file even when the test run throws, and refuses to start if the tests fail before any change", () => {
    const dir = scratch();
    let n = 0;
    const throwing: Runner = () => {
      if (n++ === 0) return { passed: true, failing: 0, output: "" };
      throw new Error("the runner crashed");
    };
    expect(() => runMutations(dir, [base], throwing)).to.throw("the runner crashed");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).to.equal("if (x > 1) y();\n");
    const red: Runner = () => ({ passed: false, failing: 3, output: "3 failing" });
    expect(() => runMutations(dir, [base], red)).to.throw(MutationError, /fail before any change/);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).to.equal("if (x > 1) y();\n");
  });

  it("marks a change that cannot be applied as BROKEN and carries on", () => {
    const dir = scratch();
    const ok: Runner = () => ({ passed: true, failing: 0, output: "" });
    const results = runMutations(dir, [{ ...base, find: "no such text" }], ok);
    expect(results[0]).to.deep.include({ status: "BROKEN" });
  });
});

describe("Mutation check: the list", () => {
  it("has unique ids, and each change is a real change to text that occurs exactly once in the current source", () => {
    expect(new Set(MUTATIONS.map((x) => x.id)).size).to.equal(MUTATIONS.length);
    for (const mu of MUTATIONS) {
      const source = readFileSync(join(root, mu.file), "utf8");
      expect(() => applyMutation(source, mu), `${mu.id} in ${mu.file}`).to.not.throw();
      expect(mu.why.length, mu.id).to.be.greaterThan(10);
    }
  });

  it("names test files that exist, and covers the scheme, the facilitator, the relayer, the proxy, paidTool, the wallet and the summary", () => {
    for (const mu of MUTATIONS) for (const t of mu.tests) expect(() => readFileSync(join(root, t), "utf8"), t).to.not.throw();
    const files = new Set(MUTATIONS.map((x) => x.file));
    for (const f of [
      "packages/sdk/src/protocol.ts", "packages/facilitator/src/service.ts", "packages/facilitator/src/relayer.ts", "packages/proxy/src/policy.ts",
      "packages/proxy/src/proxy.ts", "packages/sdk/src/paid-tool.ts", "packages/wallet-mcp/src/server.ts", "src/summary.ts",
    ]) {
      expect(files.has(f), f).to.equal(true);
    }
    expect(MUTATIONS.length).to.be.greaterThan(40);
  });
});
