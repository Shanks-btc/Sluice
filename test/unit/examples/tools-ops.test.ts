// The hosted tool server as a service to run, and as something a web page can pay: browser access for the origins it names and no other, a
// request id on every request and in its log line, and a private metrics path that needs its token. A real tool server on a local chain.
import { expect } from "chai";
import { createLogger } from "@sluice/sdk";
import { ToolServerEnvError, createToolServer, parseCorsOrigins, readToolServerEnv } from "../../../examples/paid-tools/src";
import type { ToolServer, ToolServerEnv } from "../../../examples/paid-tools/src";
import { fakeExplorer } from "../../helpers/explorer";
import { freshChain, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const TOKEN = "q".repeat(30);
const ORIGIN = "https://site.example";
const base = {
  SLUICE_NETWORK: "local",
  SLUICE_ROUTER: `0x${"12".repeat(20)}`,
  SLUICE_PAYEE: `0x${"34".repeat(20)}`,
  SLUICE_FACILITATOR_URL: "http://127.0.0.1:8402",
  SLUICE_RPC_URL: "http://127.0.0.1:8545",
};

describe("Tool server settings: browser access and the metrics token", () => {
  it("reads exact origins, https or on this machine, and refuses a wildcard, a path, a bad scheme and text that is not a URL", () => {
    expect(parseCorsOrigins(undefined)).to.deep.equal([]);
    expect(parseCorsOrigins("")).to.deep.equal([]);
    expect(parseCorsOrigins(" https://a.example , http://127.0.0.1:3000,https://a.example ")).to.deep.equal(["https://a.example", "http://127.0.0.1:3000"]);
    for (const bad of ["*", "https://*.example", "https://a.example/path", "https://a.example/", "http://a.example", "ftp://a.example", "not a url", "https://a.example?x=1", "javascript:alert(1)"]) {
      expect(() => parseCorsOrigins(bad), bad).to.throw(ToolServerEnvError, /SLUICE_TOOLS_CORS_ORIGINS/);
    }
  });

  it("reads the list into the settings, empty by default, and refuses to start on a bad one", () => {
    expect(readToolServerEnv(base).corsOrigins).to.deep.equal([]);
    expect(readToolServerEnv({ ...base, SLUICE_TOOLS_CORS_ORIGINS: ORIGIN }).corsOrigins).to.deep.equal([ORIGIN]);
    expect(() => readToolServerEnv({ ...base, SLUICE_TOOLS_CORS_ORIGINS: "*" })).to.throw(/SLUICE_TOOLS_CORS_ORIGINS/);
  });

  it("reads a metrics token of 24 to 200 safe characters, refuses any other, and never shows it when the settings are printed", () => {
    expect(readToolServerEnv(base).metricsToken()).to.equal(undefined);
    expect(readToolServerEnv({ ...base, SLUICE_TOOLS_METRICS_TOKEN: "  " }).metricsToken()).to.equal(undefined);
    for (const bad of ["short", "x".repeat(23), "x".repeat(201), `${"x".repeat(30)} y`, `${"x".repeat(30)}'`]) {
      expect(() => readToolServerEnv({ ...base, SLUICE_TOOLS_METRICS_TOKEN: bad }), bad.slice(0, 20)).to.throw(/SLUICE_TOOLS_METRICS_TOKEN/);
    }
    const env = readToolServerEnv({ ...base, SLUICE_TOOLS_METRICS_TOKEN: TOKEN });
    expect(env.metricsToken()).to.equal(TOKEN);
    expect(JSON.stringify(env)).to.not.contain(TOKEN);
    expect(Object.keys(env)).to.not.include("metricsToken");
  });
});

describe("The tool server as a service", function () {
  this.timeout(180_000);
  let s: Stack;
  let tools: ToolServer | undefined;
  let url = "";
  let lines: string[];

  const start = async (extra: Partial<ToolServerEnv> = {}, env: Record<string, string> = {}) => {
    tools = await createToolServer({
      env: { ...readToolServerEnv({ ...base, SLUICE_ROUTER: s.routerAddress, SLUICE_PAYEE: throwawayWallet().address, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, SLUICE_TOOLS_PORT: "0", SLUICE_TOOLS_CORS_ORIGINS: ORIGIN, ...env }), ...extra },
      logger: createLogger({ write: (l) => lines.push(l), level: "debug" }),
      explorer: fakeExplorer(s.provider),
    });
    url = `http://127.0.0.1:${await tools.listen()}`;
  };
  const call = (headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "contract_lookup", arguments: { address: s.tokenAddress } } }),
    });

  beforeEach(async () => {
    await freshChain();
    s = await startStack({ feeBps: 100 });
    lines = [];
    tools = undefined;
  });
  afterEach(async () => {
    await tools?.close();
    await s.stop();
  });

  describe("browser access", () => {
    it("lets a page on a listed origin read /health and /mcp, and shows it the request id", async () => {
      await start();
      const health = await fetch(`${url}/health`, { headers: { origin: ORIGIN } });
      expect(health.status).to.equal(200);
      expect(health.headers.get("access-control-allow-origin")).to.equal(ORIGIN);
      expect(health.headers.get("access-control-expose-headers")).to.contain("x-request-id");
      expect(health.headers.get("vary")).to.equal("Origin");
      const mcp = await call({ origin: ORIGIN });
      expect(mcp.headers.get("access-control-allow-origin")).to.equal(ORIGIN);
      expect(mcp.headers.get("x-request-id")).to.not.equal(null);
    });

    it("answers a browser's preflight for /mcp and /health from a listed origin, with the headers a payment call needs", async () => {
      await start();
      for (const path of ["/mcp", "/health"]) {
        const res = await fetch(`${url}${path}`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
        expect(res.status, path).to.equal(204);
        expect(res.headers.get("access-control-allow-origin")).to.equal(ORIGIN);
        expect(res.headers.get("access-control-allow-methods")).to.contain("POST");
        const allowed = res.headers.get("access-control-allow-headers") ?? "";
        for (const h of ["content-type", "accept", "x-request-id"]) expect(allowed, `${path} ${h}`).to.contain(h);
      }
    });

    it("gives any other origin nothing: no header, and a preflight that is not answered", async () => {
      await start();
      const stranger = "https://evil.example";
      const res = await fetch(`${url}/health`, { headers: { origin: stranger } });
      expect(res.status).to.equal(200);
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
      expect((await call({ origin: stranger })).headers.get("access-control-allow-origin")).to.equal(null);
      const pre = await fetch(`${url}/mcp`, { method: "OPTIONS", headers: { origin: stranger } });
      expect(pre.status).to.equal(404);
      expect(pre.headers.get("access-control-allow-origin")).to.equal(null);
      const odd = await fetch(`${url}/anything`, { method: "OPTIONS", headers: { origin: ORIGIN } });
      expect(odd.status).to.equal(404);
    });

    it("lets no page read anything when no origin is listed", async () => {
      await start({}, { SLUICE_TOOLS_CORS_ORIGINS: "" });
      const res = await fetch(`${url}/health`, { headers: { origin: ORIGIN } });
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
    });
  });

  describe("a request id", () => {
    it("is the caller's when it is well formed, and made otherwise, and is in the request's log line with the tool and no argument", async () => {
      await start();
      const res = await call({ "x-request-id": "report-12345678" });
      expect(res.headers.get("x-request-id")).to.equal("report-12345678");
      expect((await call({ "x-request-id": "bad id" })).headers.get("x-request-id")).to.match(/^[0-9a-f-]{36}$/);
      await new Promise((r) => setTimeout(r, 50));
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "request" && l.requestId === "report-12345678");
      expect(line).to.deep.include({ method: "tools/call", tool: "contract_lookup", paid: false, status: 200 });
      expect(lines.join("\n")).to.not.contain(s.tokenAddress);
    });
  });

  describe("the private metrics path", () => {
    const metrics = (headers: Record<string, string> = {}, method = "GET") => fetch(`${url}/internal/metrics`, { method, headers });

    it("does not exist until a token is set", async () => {
      await start();
      expect((await metrics({ authorization: `Bearer ${TOKEN}` })).status).to.equal(404);
    });

    it("needs the token, and answers a wrong one, none and a wrong method with a refusal", async () => {
      await start({ metricsToken: () => TOKEN });
      expect((await metrics()).status).to.equal(401);
      expect((await metrics({ authorization: `Bearer ${TOKEN}x` })).status).to.equal(401);
      expect((await metrics({ authorization: TOKEN })).status).to.equal(401);
      const post = await metrics({ authorization: `Bearer ${TOKEN}` }, "POST");
      expect(post.status).to.equal(405);
      expect(post.headers.get("allow")).to.equal("GET");
    });

    it("answers the right token with counters, counts paid and unpaid calls, and carries no CORS header even for a listed origin", async () => {
      await start({ metricsToken: () => TOKEN });
      await call();
      await call();
      const res = await metrics({ authorization: `Bearer ${TOKEN}`, origin: ORIGIN });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/^text\/plain/);
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
      const text = await res.text();
      expect(text).to.contain('sluice_tools_calls_total{kind="unpaid"} 2');
      expect(text).to.contain('sluice_tools_calls_total{kind="paid"} 0');
      expect(text).to.contain('sluice_tools_calls_total{kind="rate_limited"} 0');
      expect(text).to.contain('sluice_tools_requests_total{route="/mcp",status="2xx"} 2');
      expect(text).to.match(/sluice_tools_registered 3\n/);
      expect(text).to.not.contain(s.tokenAddress);
    });

    it("does not answer a browser's preflight for it", async () => {
      await start({ metricsToken: () => TOKEN });
      const res = await metrics({ origin: ORIGIN }, "OPTIONS");
      expect(res.status).to.equal(405);
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
    });

    it("counts a request that was refused for going over a limit", async () => {
      await start({ metricsToken: () => TOKEN, unpaidPerMinute: 1, ipPerMinute: 100 });
      await call();
      expect((await call()).status).to.equal(429);
      const text = await (await metrics({ authorization: `Bearer ${TOKEN}` })).text();
      expect(text).to.contain('sluice_tools_calls_total{kind="rate_limited"} 1');
      expect(text).to.contain('sluice_tools_requests_total{route="/mcp",status="4xx"} 1');
    });
  });
});
