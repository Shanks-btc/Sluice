// The web app's server routes: the token risk check and the evidence counts. Every guard is tested with the chain access injected, so
// nothing leaves the machine.
import { expect } from "chai";
import { Wallet } from "ethers";
import { rpcFromProvider } from "@sluice/paid-tools/rpc";
import { USDC, signedIntent } from "../../helpers";
import { startStack } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";
import { readConfig } from "../../../apps/web/src/lib/config";
import { MAX_BODY_CHARS, makeRiskHandler, parseRiskBody } from "../../../apps/web/src/lib/risk-handler";
import type { RiskDeps } from "../../../apps/web/src/lib/risk-handler";
import { RateLimiter } from "../../../apps/web/src/lib/rate-limit";
import { cached, computeSummary } from "../../../apps/web/src/lib/summary-handler";
import { readRiskResponse } from "../../../apps/web/src/components/risk-panel";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/risk", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("Web routes: the risk check", function () {
  this.timeout(60_000);
  let s: Stack;
  let deps: RiskDeps;

  before(async () => {
    s = await startStack();
    deps = { rpc: rpcFromProvider(s.provider) };
  });
  after(async () => {
    await s.stop();
  });

  const handler = (over: Partial<Parameters<typeof makeRiskHandler>[0]> = {}) => makeRiskHandler({ deps: () => deps, ...over });
  const json = async (r: Response) => (await r.json()) as Record<string, any>;

  it("runs the read-only check for a token and returns its flags and limits", async () => {
    const res = await handler()(post({ address: s.tokenAddress }));
    expect(res.status).to.equal(200);
    expect(res.headers.get("cache-control")).to.equal("no-store");
    const body = await json(res);
    expect(body.ok).to.equal(true);
    expect(body.result.address).to.equal(s.tokenAddress);
    expect(body.result.isContract).to.equal(true);
    expect(body.result.limits).to.be.an("array").that.is.not.empty;
    expect(body.result.disclaimer).to.be.a("string");
  });

  it("accepts a lower-case address and answers with the checksummed one", async () => {
    const res = await handler()(post({ address: s.tokenAddress.toLowerCase() }));
    expect((await json(res)).result.address).to.equal(s.tokenAddress);
  });

  describe("input validation", () => {
    const status = async (body: unknown, headers?: Record<string, string>) => (await handler()(post(body, headers))).status;

    it("refuses anything that is not exactly an address", async () => {
      // ethers accepts an address with no 0x prefix and an ICAP address; the route takes neither, so only the exact form passes.
      for (const bad of [s.tokenAddress.slice(2), "XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS"]) expect(await status({ address: bad }), bad).to.equal(400);
      for (const bad of ["", "0x", "0x123", "not an address", `0x${"g".repeat(40)}`, `0x${"a".repeat(41)}`, ` ${s.tokenAddress}`, `${s.tokenAddress}\n`, "javascript:alert(1)", "../../etc/passwd"]) {
        expect(await status({ address: bad }), JSON.stringify(bad)).to.equal(400);
      }
      for (const bad of [null, 1, {}, [], true]) expect(await status({ address: bad })).to.equal(400);
      expect(await status({})).to.equal(400);
      expect(await status([])).to.equal(400);
    });

    it("refuses a mixed-case address whose checksum is wrong", async () => {
      const a = s.tokenAddress;
      const wrong = a.slice(0, 2) + a.slice(2).replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      expect(await status({ address: wrong })).to.equal(400);
    });

    it("refuses invalid JSON, an oversize body and a body that is only declared large", async () => {
      expect(await status("{not json")).to.equal(400);
      expect(await status({ address: s.tokenAddress, pad: "x".repeat(MAX_BODY_CHARS) })).to.equal(413);
      expect(await status({ address: s.tokenAddress }, { "content-length": String(MAX_BODY_CHARS * 5) })).to.equal(413);
    });

    it("answers only POST with JSON", async () => {
      const get = await handler()(new Request("http://localhost/api/risk", { method: "GET" }));
      expect(get.status).to.equal(405);
      expect(get.headers.get("allow")).to.equal("POST");
      const text = await handler()(new Request("http://localhost/api/risk", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
      expect(text.status).to.equal(415);
    });

    it("parses a body the same way the handler does", () => {
      expect(parseRiskBody(JSON.stringify({ address: s.tokenAddress })).ok).to.equal(true);
      expect(parseRiskBody("x".repeat(MAX_BODY_CHARS + 1))).to.deep.equal({ ok: false, status: 413, error: "request_too_large" });
    });
  });

  describe("limits", () => {
    it("rate-limits a caller, with a wait, and keeps other callers separate", async () => {
      const h = handler({ perCaller: new RateLimiter({ limit: 2, windowMs: 60_000 }) });
      expect((await h(post({ address: s.tokenAddress }))).status).to.equal(200);
      expect((await h(post({ address: s.tokenAddress }))).status).to.equal(200);
      const limited = await h(post({ address: s.tokenAddress }));
      expect(limited.status).to.equal(429);
      expect(Number(limited.headers.get("retry-after"))).to.be.greaterThan(0);
      expect((await json(limited)).error).to.equal("rate_limited");
      expect((await h(post({ address: s.tokenAddress }, { "x-forwarded-for": "198.51.100.7" }))).status).to.equal(200);
    });

    it("rate-limits the whole server", async () => {
      const h = handler({ global: new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1 }) });
      expect((await h(post({ address: s.tokenAddress }))).status).to.equal(200);
      expect((await h(post({ address: s.tokenAddress }, { "x-forwarded-for": "198.51.100.8" }))).status).to.equal(429);
    });

    it("times out a check that never finishes, with no detail", async () => {
      const never = { call: () => new Promise<string>(() => undefined), getCode: () => new Promise<string>(() => undefined), getStorageAt: () => new Promise<string>(() => undefined) };
      const res = await handler({ deps: () => ({ rpc: never }), timeoutMs: 80 })(post({ address: s.tokenAddress }));
      expect(res.status).to.equal(504);
      expect(await json(res)).to.deep.equal({ ok: false, error: "check_failed" });
    });

    it("never repeats an upstream message, a path or a stack in an answer", async () => {
      const broken = {
        call: async () => { throw new Error("connect ECONNREFUSED https://secret-node.internal:8545/key=abc123 at /home/deploy/app.js:12"); },
        getCode: async () => { throw new Error("connect ECONNREFUSED https://secret-node.internal:8545/key=abc123"); },
        getStorageAt: async () => { throw new Error("x"); },
      };
      const res = await handler({ deps: () => ({ rpc: broken }) })(post({ address: s.tokenAddress }));
      const text = await res.text();
      expect(res.status).to.be.oneOf([502, 504]);
      expect(text).to.not.match(/secret-node|abc123|\/home|ECONNREFUSED|at .*\.js/);
      expect(JSON.parse(text)).to.deep.equal({ ok: false, error: "check_failed" });
    });
  });

  describe("what the page does with the answer", () => {
    it("shows a result, a wait, an address problem and a generic failure, and never an upstream message", () => {
      expect(readRiskResponse(200, { ok: true, result: { address: "0x1" } }).ok).to.equal(true);
      expect(readRiskResponse(429, { error: "rate_limited", retryAfterSeconds: 12 })).to.deep.equal({ ok: false, message: "Too many checks just now. Try again in 12 seconds." });
      expect((readRiskResponse(400, { error: "invalid_address" }) as { message: string }).message).to.contain("not a token address");
      expect((readRiskResponse(504, {}) as { message: string }).message).to.contain("too long");
      const generic = readRiskResponse(502, { error: "check_failed", detail: "https://secret.example" }) as { message: string };
      expect(generic.message).to.not.contain("secret");
      expect(readRiskResponse(200, "garbage").ok).to.equal(false);
    });
  });
});

describe("Web routes: the evidence counts", function () {
  this.timeout(60_000);
  let s: Stack;
  const founderList = (wallets: Array<{ address: string; label: string }> = []) => ({
    version: 1,
    updated: "2026-11-20",
    description: "test list",
    wallets,
    history: [{ version: 1, date: "2026-11-20", note: "test" }],
  });

  before(async () => {
    s = await startStack();
  });
  after(async () => {
    await s.stop();
  });

  const config = () => readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: s.routerAddress, NEXT_PUBLIC_VAULT_ADDRESS: s.vaultAddress, NEXT_PUBLIC_FROM_BLOCK: "0" });

  async function settle(builder: string, amount: bigint) {
    const payer = s.payer;
    await s.mint(payer.address, amount);
    await s.token.connect(payer).approve(s.routerAddress, amount);
    await s.router.connect(payer).deposit(amount);
    const { intent, signature } = await signedIntent(s, payer, payer.address, builder, amount);
    await s.router.connect(s.stranger).settle(intent, signature);
  }

  it("says there is nothing to count when no router is configured, and shows no number", async () => {
    const a = await computeSummary({ config: readConfig({}), founderListRaw: founderList() });
    expect(a.state).to.equal("not_configured");
    expect(JSON.stringify(a)).to.not.contain("paidCalls");
  });

  it("says so when the deployment block is not set", async () => {
    const c = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: s.routerAddress, NEXT_PUBLIC_VAULT_ADDRESS: s.vaultAddress });
    expect((await computeSummary({ config: c, founderListRaw: founderList() })).state).to.equal("not_configured");
  });

  it("counts Settled events, distinct payers and distinct builders, from the chain", async () => {
    const builderA = Wallet.createRandom().address;
    const builderB = Wallet.createRandom().address;
    await settle(builderA, USDC("1"));
    await settle(builderB, USDC("2"));
    await settle(builderA, USDC("0.5"));
    const a = await computeSummary({ config: config(), founderListRaw: founderList(), rpcUrl: s.rpcUrl });
    expect(a.state).to.equal("ok");
    if (a.state !== "ok") return;
    expect(a.paidCalls).to.equal(3);
    expect(a.distinctPayers).to.equal(1);
    expect(a.distinctBuilders).to.equal(2);
    expect(a.amountUnits).to.equal(USDC("3.5").toString());
    expect(a.excluded).to.equal(0);
  });

  it("leaves out a payment where a founder wallet is the payee, and says how many", async () => {
    const founder = Wallet.createRandom().address;
    await settle(founder, USDC("1"));
    const before = await computeSummary({ config: config(), founderListRaw: founderList(), rpcUrl: s.rpcUrl });
    const after = await computeSummary({ config: config(), founderListRaw: founderList([{ address: founder.toLowerCase(), label: "test" }]), rpcUrl: s.rpcUrl });
    if (before.state !== "ok" || after.state !== "ok") throw new Error("expected counts");
    expect(after.excluded).to.equal(1);
    expect(after.paidCalls).to.equal(before.paidCalls - 1);
    expect(after.founderWallets).to.equal(1);
  });

  it("says the chain could not be read, and never shows zero, when the node is unreachable", async () => {
    const a = await computeSummary({ config: config(), founderListRaw: founderList(), rpcUrl: "http://127.0.0.1:9" });
    expect(a.state).to.equal("unavailable");
    expect(JSON.stringify(a)).to.not.contain("paidCalls");
  });

  it("refuses a malformed founder list instead of half-using it", async () => {
    const a = await computeSummary({ config: config(), founderListRaw: { version: 1 }, rpcUrl: s.rpcUrl });
    expect(a.state).to.equal("unavailable");
  });

  it("points to the command line for a history longer than the page scans", async () => {
    const a = await computeSummary({ config: config(), founderListRaw: founderList(), rpcUrl: s.rpcUrl, maxBlocks: 0 });
    expect(a.state).to.equal("unavailable");
    expect((a as { reason: string }).reason).to.contain("pnpm evidence:summary");
  });

  it("keeps an answer for a while and drops a failed one", async () => {
    let t = 0;
    let calls = 0;
    const once = cached<number>(1000, () => t);
    expect(await once(async () => ++calls)).to.equal(1);
    expect(await once(async () => ++calls)).to.equal(1);
    t = 1500;
    expect(await once(async () => ++calls)).to.equal(2);
    t = 3000;
    await once(async () => { throw new Error("x"); }).catch(() => undefined);
    expect(await once(async () => ++calls)).to.equal(3);
  });
});
