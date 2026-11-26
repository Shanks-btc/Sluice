// The facilitator as a service to run: a request id on every request and in its log line, the private metrics path and its token, the
// last settled batch in /health, and the token's setting. A real facilitator on a local chain, served over HTTP.
import type { Server } from "node:http";
import { expect } from "chai";
import { createLogger } from "@sluice/sdk";
import { createServer, listen, readEnv, renderFacilitatorMetrics, METRICS_PATH } from "@sluice/facilitator";
import { USDC } from "../../helpers";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";
import { parseEther } from "ethers";

const TOKEN = "m".repeat(30);
const ORIGIN = "https://site.example";

describe("Facilitator as a service: request ids, metrics and the last settled batch", function () {
  this.timeout(180_000);
  let s: Stack;
  let server: Server;
  let base: string;
  let lines: string[];

  const start = async (metricsToken?: string) => {
    server = createServer(s.facilitator, { origins: [ORIGIN], metricsToken, logger: createLogger({ write: (l) => lines.push(l), level: "debug" }) });
    base = `http://127.0.0.1:${await listen(server, 0)}`;
  };
  beforeEach(async () => {
    await freshChain();
    s = await startStack({ feeBps: 100 });
    lines = [];
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => resolve());
    });
    await s.stop();
  });

  describe("a request id on every request", () => {
    it("echoes a caller's well-formed id, makes one when there is none, and replaces one that could forge a log line", async () => {
      await start();
      const mine = await fetch(`${base}/health`, { headers: { "x-request-id": "report-12345678" } });
      expect(mine.headers.get("x-request-id")).to.equal("report-12345678");
      const none = await fetch(`${base}/health`);
      expect(none.headers.get("x-request-id")).to.match(/^[0-9a-f-]{36}$/);
      const bad = await fetch(`${base}/health`, { headers: { "x-request-id": 'x" injected' } });
      expect(bad.headers.get("x-request-id")).to.not.contain("injected");
      expect(bad.headers.get("x-request-id")).to.match(/^[0-9a-f-]{36}$/);
      const unknown = await fetch(`${base}/nowhere`, { headers: { "x-request-id": "report-87654321" } });
      expect(unknown.status).to.equal(404);
      expect(unknown.headers.get("x-request-id")).to.equal("report-87654321");
    });

    it("puts the id in the log line of the request, with its route, status and time, and nothing from the body", async () => {
      await start();
      await fetch(`${base}/verify`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "report-abcdefgh" }, body: JSON.stringify({ secret: "do-not-log-this" }) });
      await new Promise((r) => setTimeout(r, 50));
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "request" && l.requestId === "report-abcdefgh");
      expect(line, "a request line with the id").to.not.equal(undefined);
      expect(line).to.deep.include({ method: "POST", route: "/verify", status: 200 });
      expect(typeof line?.ms).to.equal("number");
      expect(lines.join("\n")).to.not.contain("do-not-log-this");
    });

    it("names a path it does not know as other in the log and the counters, so a path cannot be invented into a label", async () => {
      await start(TOKEN);
      await fetch(`${base}/made/up/${"x".repeat(50)}`);
      const metrics = await (await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
      expect(metrics).to.contain('route="other",status="4xx"');
      expect(metrics).to.not.contain("made/up");
    });

    it("lets a page on a listed origin read the id, and gives any other origin no header at all", async () => {
      await start();
      const allowed = await fetch(`${base}/health`, { headers: { origin: ORIGIN } });
      expect(allowed.headers.get("access-control-expose-headers")).to.contain("x-request-id");
      expect(allowed.headers.get("access-control-allow-origin")).to.equal(ORIGIN);
      const stranger = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
      expect(stranger.headers.get("access-control-allow-origin")).to.equal(null);
      expect(stranger.headers.get("access-control-expose-headers")).to.equal(null);
      const preflight = await fetch(`${base}/onboard`, { method: "OPTIONS", headers: { origin: ORIGIN } });
      expect(preflight.status).to.equal(204);
      // The page reads the id from an answer. It does not send one, so the list of request headers it may send stays as it was.
      expect(preflight.headers.get("access-control-allow-headers")).to.equal("content-type");
    });
  });

  describe("the private metrics path", () => {
    it("does not exist until a token is set: it answers like any unknown path", async () => {
      await start();
      const res = await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).to.equal(404);
      expect(await res.json()).to.deep.equal({ error: "not_found" });
    });

    it("needs the token: none, a wrong one and a malformed one are refused, and a wrong method is refused", async () => {
      await start(TOKEN);
      const none = await fetch(`${base}${METRICS_PATH}`);
      expect(none.status).to.equal(401);
      expect(none.headers.get("www-authenticate")).to.match(/^Bearer/);
      expect((await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}x` } })).status).to.equal(401);
      expect((await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: TOKEN } })).status).to.equal(401);
      const post = await fetch(`${base}${METRICS_PATH}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(post.status).to.equal(405);
      expect(post.headers.get("allow")).to.equal("GET");
    });

    it("answers the right token with plain text, and never carries a CORS header, even for a listed origin", async () => {
      await start(TOKEN);
      const res = await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN } });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/^text\/plain/);
      expect(res.headers.get("cache-control")).to.equal("no-store");
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
      const text = await res.text();
      for (const name of ["sluice_facilitator_requests_total", "sluice_facilitator_intents", "sluice_facilitator_kill_switch 0", "sluice_facilitator_store_healthy 1", "sluice_facilitator_relayer_balance_wei", "sluice_facilitator_budget_wei", "sluice_facilitator_oldest_queued_age_seconds 0"]) {
        expect(text, name).to.contain(name);
      }
      expect(text).to.not.contain("last_settled"); // nothing has settled, and a gauge it does not know is left out, not written as zero
      expect(text).to.not.match(/0x[0-9a-fA-F]{40}/); // no address of a payer, a payee or the relayer
      expect(text.endsWith("\n")).to.equal(true);
    });

    it("does not answer a browser's preflight for it", async () => {
      await start(TOKEN);
      const res = await fetch(`${base}${METRICS_PATH}`, { method: "OPTIONS", headers: { origin: ORIGIN } });
      expect(res.status).to.equal(405);
      expect(res.headers.get("access-control-allow-origin")).to.equal(null);
    });

    it("counts requests by route and status class", async () => {
      await start(TOKEN);
      await fetch(`${base}/health`);
      await fetch(`${base}/health`);
      await fetch(`${base}/status/0x${"00".repeat(32)}`);
      const text = await (await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
      expect(text).to.contain('sluice_facilitator_requests_total{route="/health",status="2xx"} 2');
      expect(text).to.contain('sluice_facilitator_requests_total{route="/status",status="4xx"} 1');
    });
  });

  describe("the last settled batch", () => {
    it("is null in /health, and left out of the metrics, until something settles, and then names the block and the time", async () => {
      await start(TOKEN);
      const before = (await (await fetch(`${base}/health`)).json()) as { lastSettled: unknown };
      expect(before.lastSettled).to.equal(null);

      const payer = throwawayWallet();
      const builder = throwawayWallet().address;
      await fundWallet(s, payer, USDC("5"), parseEther("1"));
      await depositFor(s, payer, USDC("5"));
      const made = await makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.01")));
      expect((await s.facilitator.settle(verifyBody(made))).success).to.equal(true);

      const queued = await (await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
      expect(queued).to.contain('sluice_facilitator_intents{status="queued"} 1');
      expect(queued).to.not.contain("last_settled");

      await s.facilitator.flush();
      const healthText = await (await fetch(`${base}/health`)).text();
      const after = JSON.parse(healthText) as { lastSettled: { blockNumber: number; at: number } | null; queued: number };
      expect(after.queued).to.equal(0);
      expect(Object.keys(after.lastSettled ?? {}).sort()).to.deep.equal(["at", "blockNumber"]);
      expect(healthText, "the public health answer holds no 32-byte value, so none could be taken for a key").to.not.match(/0x[0-9a-f]{64}/i);
      expect(after.lastSettled?.blockNumber).to.be.greaterThan(0);
      expect(Math.abs((after.lastSettled?.at ?? 0) - s.clock())).to.be.lessThan(120);

      const text = await (await fetch(`${base}${METRICS_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
      expect(text).to.contain('sluice_facilitator_intents{status="settled"} 1');
      expect(text).to.contain('sluice_facilitator_intents{status="queued"} 0');
      expect(text).to.match(new RegExp(`sluice_facilitator_last_settled_block ${after.lastSettled?.blockNumber}\\n`));
      expect(text).to.match(/sluice_facilitator_last_settled_timestamp_seconds \d+\n/);
    });

    it("writes the metrics the same way whatever the facilitator holds: counts, ages and the relayer's balance", async () => {
      await start();
      const text = renderFacilitatorMetrics(await s.facilitator.metrics(), { lines: () => ["# TYPE x counter"] } as never);
      expect(text.split("\n")[0]).to.equal("# TYPE x counter");
      expect(text).to.match(/sluice_facilitator_intents\{status="failed"\} 0/);
      expect(text).to.match(/sluice_facilitator_relayer_balance_wei \d+/);
    });
  });

  describe("the token's setting", () => {
    const base = { SLUICE_NETWORK: "local", SLUICE_RPC_URL: "http://127.0.0.1:8545", SLUICE_ROUTER: `0x${"12".repeat(20)}`, SLUICE_RELAYER_KEY: `0x${"34".repeat(32)}` };

    it("is optional, and with none set the path has nothing to check", () => {
      expect(readEnv(base).metricsToken()).to.equal(undefined);
      expect(readEnv({ ...base, SLUICE_FACILITATOR_METRICS_TOKEN: "   " }).metricsToken()).to.equal(undefined);
    });

    it("is refused when it is short or holds characters a header cannot carry", () => {
      for (const bad of ["short", "x".repeat(23), "x".repeat(201), `${"x".repeat(30)} with space`, `${"x".repeat(30)}"quote`, `${"x".repeat(30)}\n`.slice(0, -1) + "é"]) {
        expect(() => readEnv({ ...base, SLUICE_FACILITATOR_METRICS_TOKEN: bad }), bad.slice(0, 20)).to.throw(/SLUICE_FACILITATOR_METRICS_TOKEN/);
      }
      expect(readEnv({ ...base, SLUICE_FACILITATOR_METRICS_TOKEN: "x".repeat(24) }).metricsToken()).to.equal("x".repeat(24));
      expect(readEnv({ ...base, SLUICE_FACILITATOR_METRICS_TOKEN: "aZ09._~+/=-".repeat(3) }).metricsToken()).to.have.length(33);
    });

    it("is never printed: the settings object does not show it when it is logged or serialised", () => {
      const env = readEnv({ ...base, SLUICE_FACILITATOR_METRICS_TOKEN: TOKEN });
      const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
      expect(show(env)).to.not.contain(TOKEN);
      expect(Object.keys(env)).to.not.include("metricsToken");
      expect(show(Object.entries(env))).to.not.contain(TOKEN);
    });
  });
});
