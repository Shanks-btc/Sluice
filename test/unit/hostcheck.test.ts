// The host check (pnpm live:hostcheck): what it asks, what it says PASS, WARN and FAIL to, and that it asks nothing but GET /health. The
// cases use a pretend host that records every request; one case at the end runs it against a real facilitator and a real tool server on this
// machine, to see that a real fetch sends the Origin header and that the real services answer it the way the check expects.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { getAddress } from "ethers";
import { createLogger } from "@sluice/sdk";
import { createToolServer, readToolServerEnv } from "../../examples/paid-tools/src";
import type { ToolServer } from "../../examples/paid-tools/src";
import {
  STRANGER_ORIGIN,
  checkFacilitator,
  checkHost,
  checkToolServer,
  formatLines,
  parseServiceUrl,
  parseWebOrigin,
  summarize,
} from "../../src/hostcheck";
import type { Got, Line } from "../../src/hostcheck";
import { main } from "../../scripts/live/hostcheck";
import { fakeExplorer } from "../helpers/explorer";
import { freshChain, startStack } from "../helpers/stack";
import type { Stack } from "../helpers/stack";

const ROOT = join(__dirname, "..", "..");
const ROUTER = getAddress("0xf6F4C1Cc954B1798d134750438ada58768978716");
const OTHER_ROUTER = getAddress(`0x${"ab".repeat(20)}`);
const VAULT = getAddress("0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B");
const RELAYER = getAddress("0x0A021bC732325C57E0cC838E4111A861b84fFEB1");
const PAYEE = getAddress(`0x${"34".repeat(20)}`);
const FACILITATOR = "https://facilitator.example.com";
const TOOLS = "https://tools.example.com";
const WEB = "https://sluice.example.com";
const EMPTY = mkdtempSync(join(tmpdir(), "sluice-hostcheck-"));

/** What a healthy facilitator answers: the relayer holds 0.1 QIE, which is below its day's budget, so lowBalance is true. */
const facilitatorBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true, killSwitch: false, draining: false, store: { healthy: true }, lowBalance: true, lowBalanceThresholdWei: "500000000000000000",
  inFlight: { count: 0, oldestAgeSeconds: 0 }, chainId: 1990, router: ROUTER, vault: VAULT, relayer: RELAYER, relayerBalanceWei: "100000000000000000",
  relayerQusdcUnits: "0", budget: { day: "2026-11-23", budgetWei: "500000000000000000", spentWei: "0", reservedWei: "0", remainingWei: "500000000000000000" },
  queued: 0, lastSettled: null, alerts: [], ...over,
});
const toolsBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true, service: "sluice-paid-tools", network: "mainnet", chainId: 1990, router: ROUTER, payee: PAYEE,
  tools: [{ name: "token_risk_check", price: "0.01" }, { name: "dex_quote", price: "0.002" }, { name: "contract_lookup", price: "0.005" }], ...over,
});

// ------------------------------------------------------------------------------------------------------------ a pretend host

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string>; fail?: Error };
type Call = { url: string; method: string; headers: Record<string, string>; redirect: string | undefined; hasBody: boolean };

/** A host at each address given. A reply may depend on the Origin header the request carried, which is what a CORS check changes. */
function pretend(hosts: Record<string, (origin: string | undefined) => Reply>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, redirect: init?.redirect, hasBody: init?.body !== undefined });
    const host = hosts[url.origin];
    if (!host) throw new Error(`nothing is pretended at ${url.origin}`);
    const reply = host(headers.origin);
    if (reply.fail) throw reply.fail;
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const good = () =>
  pretend({
    [FACILITATOR]: () => ({ body: facilitatorBody() }),
    [TOOLS]: () => ({ body: toolsBody() }),
  });

const ARGS = ["--facilitator", FACILITATOR, "--tools", TOOLS, "--router", ROUTER];

async function run(argv: string[], hosts = good(), env: Record<string, string | undefined> = {}, extra: { cwd?: string } = {}): Promise<{ code: number; out: string; calls: Call[]; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(argv, env, { log: (l) => lines.push(l), fetchImpl: hosts.fetchImpl, cwd: extra.cwd ?? EMPTY, timeoutMs: 2_000 });
  return { code, out: lines.join("\n"), calls: hosts.calls, lines };
}

const levelOf = (lines: Line[], who: string, pattern: RegExp): string | undefined => lines.find((l) => l.who === who && pattern.test(l.text))?.level;
const failures = (lines: Line[]): string[] => lines.filter((l) => l.level === "FAIL").map((l) => `${l.who}: ${l.text}`);

after(() => rmSync(EMPTY, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------------------------------ addresses

describe("Host check: the addresses it is given", () => {
  it("takes https, and http only for this machine, and only the address alone", () => {
    expect(parseServiceUrl("--tools", "https://tools.example.com")).to.deep.equal({ origin: "https://tools.example.com" });
    expect(parseServiceUrl("--tools", "https://tools.example.com/")).to.deep.equal({ origin: "https://tools.example.com" });
    expect(parseServiceUrl("--tools", "https://tools.example.com:8443")).to.deep.equal({ origin: "https://tools.example.com:8443" });
    expect(parseServiceUrl("--tools", "http://127.0.0.1:8403")).to.deep.equal({ origin: "http://127.0.0.1:8403" });
    expect(parseServiceUrl("--tools", "http://localhost:8403").origin).to.equal("http://localhost:8403");
    for (const [raw, message] of [
      [undefined, /--tools is missing/],
      ["", /--tools is missing/],
      ["tools.example.com", /not a web address/],
      ["http://tools.example.com", /must be https/],
      ["ftp://tools.example.com", /must be https/],
      ["https://tools.example.com/health", /address alone, with no path/],
      ["https://tools.example.com/?a=1", /address alone, with no path/],
      ["https://tools.example.com/#x", /address alone, with no path/],
    ] as Array<[string | undefined, RegExp]>) {
      expect(parseServiceUrl("--tools", raw).problem, String(raw)).to.match(message);
    }
  });

  it("refuses a user name and a password, and never repeats what was typed", () => {
    const checked = parseServiceUrl("--facilitator", "https://admin:hunter2-secret@facilitator.example.com");
    expect(checked.problem).to.match(/must not hold a user name or a password/);
    expect(checked.problem).to.not.contain("hunter2");
    expect(parseServiceUrl("--facilitator", "not a url with hunter2-secret").problem).to.not.contain("hunter2");
  });

  it("takes the web app's origin exactly: no wildcard, no path, no trailing slash, https", () => {
    expect(parseWebOrigin("--origin", WEB)).to.deep.equal({ origin: WEB });
    expect(parseWebOrigin("--origin", "http://localhost:3000").origin).to.equal("http://localhost:3000");
    for (const [raw, message] of [
      ["*", /a wildcard is never right/],
      ["https://*.example.com", /a wildcard is never right/],
      [`${WEB}/`, /no path and no trailing slash/],
      [`${WEB}/app`, /no path and no trailing slash/],
      ["http://sluice.example.com", /must be https/],
      ["sluice.example.com", /not an origin/],
      ["", /is missing/],
    ] as Array<[string, RegExp]>) {
      expect(parseWebOrigin("--origin", raw).problem, raw).to.match(message);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- the checks

describe("Host check: a healthy facilitator and tool server", () => {
  it("passes every line, warns that the relayer's balance is low, and asks only GET /health with no body", async () => {
    const hosts = good();
    const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, routerSource: "--router", fetchImpl: hosts.fetchImpl });
    expect(failures(lines)).to.deep.equal([]);
    expect(summarize(lines).warn).to.equal(1);
    expect(levelOf(lines, "facilitator", /lowBalance is true/)).to.equal("WARN");
    for (const [who, pattern] of [
      ["facilitator", /chainId is 1990/], ["facilitator", /router is .*, the one expected/], ["facilitator", /killSwitch is false/],
      ["facilitator", /relayer 0x0A021bC732325C57E0cC838E4111A861b84fFEB1 holds 0\.1 QIE, above zero/], ["facilitator", /store\.healthy is true/],
      ["facilitator", /no alerts/], ["facilitator", /no 32-byte value/],
      ["tool server", /network is mainnet/], ["tool server", /chainId is 1990/], ["tool server", /router is .*, the one expected/],
      ["tool server", /payee is/], ["tool server", /3 tools priced: token_risk_check=0\.01, dex_quote=0\.002, contract_lookup=0\.005/],
    ] as Array<[string, RegExp]>) {
      expect(levelOf(lines, who, pattern), `${who}: ${pattern}`).to.equal("PASS");
    }
    expect(hosts.calls.map((c) => `${c.method} ${c.url}`).sort()).to.deep.equal([`GET ${FACILITATOR}/health`, `GET ${TOOLS}/health`]);
    for (const c of hosts.calls) {
      expect(c.hasBody).to.equal(false);
      expect(c.redirect).to.equal("manual");
      expect(Object.keys(c.headers)).to.not.include.members(["authorization", "cookie"]);
    }
  });

  it("prints PASS, WARN and FAIL per line, with a summary, and exits 0 when nothing failed", async () => {
    const r = await run(ARGS);
    expect(r.code).to.equal(0);
    expect(r.out).to.match(/^PASS {2}facilitator {2}chainId is 1990$/m);
    expect(r.out).to.match(/^WARN {2}facilitator {2}lowBalance is true/m);
    expect(r.out).to.match(/^hostcheck: \d+ passed, 0 failed, 1 warning$/m);
    expect(r.out).to.contain(`expected router ${ROUTER} (--router)`);
    expect(r.out).to.contain("Read-only: the only request is GET /health.");
  });
});

describe("Host check: what makes a line FAIL", () => {
  const facilitatorCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a wrong chain", { chainId: 1983 }, /chainId is 1983, not 1990/],
    ["a missing chain", { chainId: undefined }, /chainId is missing/],
    ["another router", { router: OTHER_ROUTER }, /router is 0x[0-9a-fA-F]{40}, but the one expected is/],
    ["no router", { router: undefined }, /router is missing or is not an address/],
    ["the kill switch on", { killSwitch: true }, /killSwitch is true/],
    ["no kill switch field", { killSwitch: undefined }, /killSwitch is missing/],
    ["a relayer with no QIE", { relayerBalanceWei: "0", lowBalance: true }, /holds no QIE: it cannot send a batch/],
    ["a relayer balance that is not a number", { relayerBalanceWei: "lots" }, /relayer's address or balance is missing/],
    ["ok false", { ok: false }, /ok is not true/],
    ["a queue that cannot be written", { store: { healthy: false } }, /store\.healthy is not true/],
    ["a service shutting down", { draining: true }, /draining is true/],
  ];
  for (const [name, over, message] of facilitatorCases) {
    it(`the facilitator: ${name}`, async () => {
      const hosts = pretend({ [FACILITATOR]: () => ({ body: facilitatorBody(over) }), [TOOLS]: () => ({ body: toolsBody() }) });
      const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, fetchImpl: hosts.fetchImpl });
      expect(failures(lines).join("\n")).to.match(message);
      expect(failures(lines).every((f) => f.startsWith("facilitator:"))).to.equal(true);
    });
  }

  const toolCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a wrong chain", { chainId: 1 }, /chainId is 1, not 1990/],
    ["the testnet", { network: "testnet" }, /network is testnet, not mainnet/],
    ["another router", { router: OTHER_ROUTER }, /but the one expected is/],
    ["not the tool server", { service: "something-else" }, /not the tool server/],
    ["no payee", { payee: undefined }, /payee is missing, zero or not an address/],
    ["the zero address as the payee", { payee: `0x${"0".repeat(40)}` }, /payee is missing, zero or not an address/],
    ["no tools", { tools: [] }, /the tools are missing, or one has no price above zero/],
    ["a tool with no price", { tools: [{ name: "dex_quote", price: "0" }] }, /no price above zero/],
    ["ok false", { ok: false }, /ok is not true/],
  ];
  for (const [name, over, message] of toolCases) {
    it(`the tool server: ${name}`, async () => {
      const hosts = pretend({ [FACILITATOR]: () => ({ body: facilitatorBody() }), [TOOLS]: () => ({ body: toolsBody(over) }) });
      const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, fetchImpl: hosts.fetchImpl });
      expect(failures(lines).join("\n")).to.match(message);
      expect(failures(lines).every((f) => f.startsWith("tool server:"))).to.equal(true);
    });
  }

  it("fails both services when there is no router to compare with, instead of skipping the check", async () => {
    const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, fetchImpl: good().fetchImpl });
    expect(failures(lines)).to.have.length(2);
    expect(failures(lines).join("\n")).to.match(/there is no router to compare with/);
  });

  it("fails an answer that is not 200, is a redirect, is not JSON, or does not arrive, and says which", async () => {
    const cases: Array<[Reply, RegExp]> = [
      [{ status: 503, body: facilitatorBody({ ok: false }) }, /answered HTTP 503/],
      [{ status: 500, text: "oops" }, /answered HTTP 500, not 200/],
      [{ status: 404, text: "" }, /answered HTTP 404/],
      [{ status: 301, headers: { location: "https://elsewhere.example" } }, /answered a redirect \(HTTP 301\): none is followed/],
      [{ status: 200, text: "<html>not json</html>" }, /answered 200, but not with a JSON object/],
      [{ status: 200, text: "[1,2]" }, /answered 200, but not with a JSON object/],
      [{ fail: Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }) }, /could not connect \(ECONNREFUSED\)/],
      [{ fail: Object.assign(new Error("x"), { name: "TimeoutError" }) }, /no answer in time/],
      [{ fail: new Error("secret-internal-detail") }, /could not connect$/],
    ];
    for (const [reply, message] of cases) {
      const hosts = pretend({ [FACILITATOR]: () => reply, [TOOLS]: () => ({ body: toolsBody() }) });
      const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, fetchImpl: hosts.fetchImpl });
      const own = lines.filter((l) => l.who === "facilitator");
      expect(own.map((l) => l.text).join("\n"), JSON.stringify(reply)).to.match(message);
      expect(own.every((l) => l.level === "FAIL" || l.level === "PASS")).to.equal(true);
      expect(own.filter((l) => l.level === "FAIL").length).to.be.greaterThan(0);
      expect(formatLines(own).join("\n")).to.not.contain("secret-internal-detail");
    }
  });

  it("fails an answer that holds a 32-byte value, which a key would look like, and a hash of 20 bytes is no cause", async () => {
    const key = `0x${"9c".repeat(32)}`;
    const hosts = pretend({ [FACILITATOR]: () => ({ body: facilitatorBody({ note: key }) }), [TOOLS]: () => ({ body: toolsBody({ debug: "ab".repeat(32) }) }) });
    const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, fetchImpl: hosts.fetchImpl });
    expect(failures(lines).filter((f) => /holds a 32-byte value/.test(f))).to.have.length(2);
    expect(formatLines(lines).join("\n")).to.not.contain("9c9c9c");
    expect(levelOf(await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, fetchImpl: good().fetchImpl }), "facilitator", /no 32-byte value/)).to.equal("PASS");
  });
});

describe("Host check: what is a warning and not a failure", () => {
  it("warns on a low balance, QUSDC at the relayer, alerts, and a payee that is the relayer, and still exits 0", async () => {
    const hosts = pretend({
      [FACILITATOR]: () => ({ body: facilitatorBody({ lowBalance: false, relayerQusdcUnits: "5000", alerts: [{ at: 1, kind: "low_balance", message: "m" }, { at: 2, kind: "holds_qusdc", message: "m" }, { at: 3, kind: "low_balance", message: "m" }] }) }),
      [TOOLS]: () => ({ body: toolsBody({ payee: RELAYER }) }),
    });
    const r = await run(ARGS, hosts);
    expect(r.code).to.equal(0);
    expect(r.out).to.match(/^WARN {2}facilitator {2}the relayer holds QUSDC, which it should never do/m);
    expect(r.out).to.match(/^WARN {2}facilitator {2}3 alerts: low_balance, holds_qusdc$/m);
    expect(r.out).to.match(/^WARN {2}setup +the tool server's payee is the relayer's address/m);
    expect(r.out).to.not.match(/^FAIL/m);
  });

  it("exits 1 when anything fails, and the summary counts it", async () => {
    const hosts = pretend({ [FACILITATOR]: () => ({ body: facilitatorBody({ killSwitch: true }) }), [TOOLS]: () => ({ body: toolsBody() }) });
    const r = await run(ARGS, hosts);
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/^FAIL {2}facilitator {2}killSwitch is true/m);
    expect(r.out).to.match(/hostcheck: \d+ passed, 1 failed, 1 warning$/m);
  });
});

describe("Host check: the web app's origin", () => {
  const withCors = (allow: (origin: string | undefined) => string | undefined) => {
    const reply = (body: unknown) => (origin: string | undefined): Reply => {
      const header = allow(origin);
      return { body, headers: header === undefined ? {} : { "access-control-allow-origin": header } };
    };
    return pretend({ [FACILITATOR]: reply(facilitatorBody()), [TOOLS]: reply(toolsBody()) });
  };
  const exact = (origin: string | undefined) => (origin === WEB ? WEB : undefined);

  it("passes when each service lets the web app's origin read its answers and no other, and asks with the Origin header it was given", async () => {
    const hosts = withCors(exact);
    const lines = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, origin: WEB, fetchImpl: hosts.fetchImpl });
    expect(failures(lines)).to.deep.equal([]);
    for (const who of ["facilitator", "tool server"]) {
      expect(levelOf(lines, who, /may read its answers: access-control-allow-origin is that origin, exactly/)).to.equal("PASS");
      expect(levelOf(lines, who, /an origin that is not listed gets no access-control-allow-origin header/)).to.equal("PASS");
    }
    const sent = hosts.calls.map((c) => c.headers.origin).filter(Boolean);
    expect(sent.filter((o) => o === WEB)).to.have.length(2);
    expect(sent.filter((o) => o === STRANGER_ORIGIN)).to.have.length(2);
    expect(hosts.calls.every((c) => c.method === "GET" && c.url.endsWith("/health") && !c.hasBody)).to.equal(true);
    expect(hosts.calls).to.have.length(6);
  });

  it("fails a wildcard, a missing header, a different origin and a stranger's origin being let in", async () => {
    const wildcard = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, origin: WEB, fetchImpl: withCors(() => "*").fetchImpl });
    expect(failures(wildcard).join("\n")).to.match(/facilitator: access-control-allow-origin is \*, which lets any page read its answers: set SLUICE_FACILITATOR_CORS_ORIGINS to https:\/\/sluice\.example\.com alone/);
    expect(failures(wildcard).join("\n")).to.match(/tool server: access-control-allow-origin is \*.*SLUICE_TOOLS_CORS_ORIGINS/);
    expect(failures(wildcard).join("\n")).to.match(/an origin that is not listed got access-control-allow-origin: \*/);

    const none = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, origin: WEB, fetchImpl: withCors(() => undefined).fetchImpl });
    expect(failures(none).join("\n")).to.match(/facilitator: a page on https:\/\/sluice\.example\.com cannot read its answers: set SLUICE_FACILITATOR_CORS_ORIGINS/);
    expect(failures(none).join("\n")).to.match(/tool server: a page on .* cannot read its answers: set SLUICE_TOOLS_CORS_ORIGINS/);

    const other = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, origin: WEB, fetchImpl: withCors((o) => (o === WEB ? "https://other.example.com" : undefined)).fetchImpl });
    expect(failures(other).join("\n")).to.match(/access-control-allow-origin is https:\/\/other\.example\.com, not https:\/\/sluice\.example\.com/);

    const echo = await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, origin: WEB, fetchImpl: withCors((o) => o).fetchImpl });
    expect(failures(echo).join("\n")).to.match(/an origin that is not listed got access-control-allow-origin: https:\/\/hostcheck-not-listed\.invalid: the list is too wide/);
  });

  it("asks nothing about origins unless one is given", async () => {
    const hosts = withCors(exact);
    await checkHost({ facilitator: FACILITATOR, tools: TOOLS, router: ROUTER, fetchImpl: hosts.fetchImpl });
    expect(hosts.calls).to.have.length(2);
    expect(hosts.calls.every((c) => c.headers.origin === undefined)).to.equal(true);
  });
});

// ----------------------------------------------------------------------------------------------------------------- the command

describe("Host check: the command", () => {
  it("refuses a wrong command before it asks anything", async () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /--facilitator is missing/],
      [["--facilitator", FACILITATOR], /--tools is missing/],
      [["--tools", TOOLS], /--facilitator is missing/],
      [["--facilitator", "http://facilitator.example.com", "--tools", TOOLS], /--facilitator must be https/],
      [["--facilitator", `${FACILITATOR}/health`, "--tools", TOOLS], /--facilitator must be the address alone/],
      [[...ARGS, "--origin", "*"], /--origin must be one exact origin: a wildcard is never right/],
      [[...ARGS, "--origin", `${WEB}/`], /--origin must be exactly the scheme/],
      [[...ARGS, "--bogus", "x"], /unknown option --bogus/],
      [[...ARGS, "--tools", TOOLS], /--tools was given twice/],
      [["--facilitator"], /--facilitator needs a value/],
    ];
    for (const [argv, message] of cases) {
      const hosts = good();
      const r = await run(argv, hosts);
      expect(r.code, argv.join(" ")).to.equal(2);
      expect(r.out).to.match(message);
      expect(hosts.calls, argv.join(" ")).to.deep.equal([]);
    }
  });

  it("takes the router from --router, then SLUICE_ROUTER, then deployment.json in the folder it is run from, and says which", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-hostcheck-deploy-"));
    try {
      writeFileSync(join(dir, "deployment.json"), JSON.stringify({ router: ROUTER, vault: VAULT }));
      const noRouter = ["--facilitator", FACILITATOR, "--tools", TOOLS];
      const fromFile = await run(noRouter, good(), {}, { cwd: dir });
      expect(fromFile.code).to.equal(0);
      expect(fromFile.out).to.contain(`expected router ${ROUTER} (deployment.json)`);
      const fromEnv = await run(noRouter, good(), { SLUICE_ROUTER: ROUTER }, { cwd: dir });
      expect(fromEnv.out).to.contain(`expected router ${ROUTER} (SLUICE_ROUTER)`);
      const fromFlag = await run(ARGS, good(), { SLUICE_ROUTER: OTHER_ROUTER }, { cwd: dir });
      expect(fromFlag.out).to.contain(`expected router ${ROUTER} (--router)`);
      expect(fromFlag.code).to.equal(0);
      // The flag wins over the file: a router that differs from what the services report fails.
      const wrong = await run(["--facilitator", FACILITATOR, "--tools", TOOLS, "--router", OTHER_ROUTER], good(), {}, { cwd: dir });
      expect(wrong.code).to.equal(1);
      expect(wrong.out).to.match(/but the one expected is/);
      expect((await run(["--facilitator", FACILITATOR, "--tools", TOOLS, "--router", "0x12"])).out).to.match(/--router is not an address/);
      expect((await run(noRouter, good(), { SLUICE_ROUTER: "nope" })).code).to.equal(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no router anywhere, asks, says there is nothing to compare with, and fails", async () => {
    const r = await run(["--facilitator", FACILITATOR, "--tools", TOOLS]);
    expect(r.code).to.equal(1);
    expect(r.out).to.contain("no expected router: give --router, set SLUICE_ROUTER, or run this where deployment.json is");
    expect(r.out).to.match(/^FAIL {2}facilitator {2}there is no router to compare with/m);
  });

  it("prints no key and no secret, whatever the services answer, and has no way to send", async () => {
    const secret = `0x${"5d".repeat(32)}`;
    const env = { SLUICE_KEY: secret, SLUICE_RELAYER_KEY: secret, SLUICE_APPROVE: "facilitator" };
    for (const body of [facilitatorBody({ ok: false, killSwitch: true, relayerBalanceWei: "0" }), facilitatorBody({ chainId: 3 })]) {
      const hosts = pretend({ [FACILITATOR]: () => ({ body }), [TOOLS]: () => ({ fail: new Error(`boom ${secret}`) }) });
      const r = await run(ARGS, hosts, env);
      expect(r.out).to.not.contain(secret);
      expect(r.out).to.not.contain(secret.slice(2));
      expect(r.out).to.not.match(/0x[0-9a-fA-F]{64}/);
    }
    for (const file of ["src/hostcheck.ts", "scripts/live/hostcheck.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).to.not.match(/child_process|sendTransaction|sendRawTransaction|signTransaction|signMessage|new Wallet\(|JsonRpcProvider|SLUICE_KEY|SLUICE_RELAYER_KEY|SLUICE_APPROVE/);
      expect(source, file).to.not.match(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
    expect(readFileSync(join(ROOT, "src/hostcheck.ts"), "utf8").match(/method:\s*"[A-Z]+"/g)).to.deep.equal(['method: "GET"']);
  });
});

describe("Host check: a pure check of a given answer", () => {
  it("checks an answer without asking anything", () => {
    const got = (body: unknown): Got => ({ ok: true, status: 200, json: body, text: JSON.stringify(body), allowOrigin: null });
    expect(failures(checkFacilitator(got(facilitatorBody()), { router: ROUTER, chainId: 1990, network: "mainnet" }))).to.deep.equal([]);
    expect(failures(checkToolServer(got(toolsBody()), { router: ROUTER, chainId: 1990, network: "mainnet" }))).to.deep.equal([]);
    expect(failures(checkToolServer(got(toolsBody()), { router: ROUTER, chainId: 1990, network: "testnet" })).join()).to.match(/network is mainnet, not testnet/);
  });
});

// ---------------------------------------------------------------------------------------- real services on this machine

describe("Host check: against a real facilitator and a real tool server on this machine", function () {
  this.timeout(180_000);
  let s: Stack;
  let tools: ToolServer;
  let toolsUrl: string;
  let facilitatorUrl: string;

  beforeEach(async () => {
    await freshChain();
    s = await startStack({ feeBps: 100, corsOrigins: [WEB] });
    facilitatorUrl = s.facilitatorUrl;
    const env = {
      ...readToolServerEnv({ SLUICE_NETWORK: "local", SLUICE_ROUTER: s.routerAddress, SLUICE_PAYEE: PAYEE, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, SLUICE_TOOLS_PORT: "0" }),
      corsOrigins: [WEB],
    };
    tools = await createToolServer({ env, logger: createLogger({ write: () => undefined, level: "error" }), explorer: fakeExplorer(s.provider) });
    toolsUrl = `http://127.0.0.1:${await tools.listen()}`;
  });
  afterEach(async () => {
    await tools.close();
    await s.stop();
  });

  it("passes against the real answers, sends a real Origin header, and fails when the origin is not the one listed", async () => {
    const lines: string[] = [];
    const argv = ["--facilitator", facilitatorUrl, "--tools", toolsUrl, "--router", s.routerAddress, "--origin", WEB];
    const code = await main(argv, {}, { log: (l) => lines.push(l), expectedNetwork: "local", cwd: EMPTY, timeoutMs: 10_000 });
    const out = lines.join("\n");
    expect(out, out).to.match(/hostcheck: \d+ passed, 0 failed/);
    expect(code).to.equal(0);
    expect(out).to.match(/PASS {2}facilitator {2}a page on https:\/\/sluice\.example\.com may read its answers/);
    expect(out).to.match(/PASS {2}tool server {2}a page on https:\/\/sluice\.example\.com may read its answers/);
    expect(out).to.match(/PASS {2}tool server {2}an origin that is not listed gets no access-control-allow-origin header/);
    expect(out).to.match(/PASS {2}facilitator {2}relayer 0x[0-9a-fA-F]{40} holds 1\.0 QIE, above zero/);

    // A web app on another origin is not let in by either service.
    const other: string[] = [];
    const wrong = await main(["--facilitator", facilitatorUrl, "--tools", toolsUrl, "--router", s.routerAddress, "--origin", "https://another.example.com"], {}, { log: (l) => other.push(l), expectedNetwork: "local", cwd: EMPTY, timeoutMs: 10_000 });
    expect(wrong).to.equal(1);
    expect(other.join("\n")).to.match(/FAIL {2}facilitator {2}a page on https:\/\/another\.example\.com cannot read its answers/);
    expect(other.join("\n")).to.match(/FAIL {2}tool server {2}a page on https:\/\/another\.example\.com cannot read its answers/);

    // Pointed at the mainnet's expectations, a local network is refused: the command is for mainnet.
    const mainnet: string[] = [];
    const refused = await main(["--facilitator", facilitatorUrl, "--tools", toolsUrl, "--router", s.routerAddress], {}, { log: (l) => mainnet.push(l), cwd: EMPTY, timeoutMs: 10_000 });
    expect(refused).to.equal(1);
    expect(mainnet.join("\n")).to.match(/FAIL {2}tool server {2}network is local, not mainnet/);
  });
});
