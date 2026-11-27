// The facilitator and the example tool server as serverless functions: what they refuse to start without, the Redis client they speak
// with, the drain that follows a payment and the one a scheduler asks for, and what copies share. The chain is the local Hardhat network,
// the database is the stand-in (behind Upstash's REST interface on this machine where the real client is tried), and every key and secret
// was made for the run. Nothing leaves this machine.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { expect } from "chai";
import { parseEther } from "ethers";
import type { Wallet } from "ethers";
import { EnvError, RedisLedger, readEnv, redisPrefix } from "@sluice/facilitator";
import { ERRORS, PAYMENT_META_KEY, RedisIdempotencyStore, RedisRateLimiter, UpstashRest, readRedisCredentials } from "@sluice/sdk";
import type { RedisClient } from "@sluice/sdk";
import facilitatorFunction, { DRAIN_BUDGET_MS, LOCK_TTL_MS, LOCK_WAIT_MS, MAX_DURATION_SECONDS, PAYER_RECEIPT_TIMEOUT_MS, RECEIPT_TIMEOUT_MS, createServerlessFacilitator } from "../../../packages/facilitator/src/vercel";
import type { ServerlessOptions } from "../../../packages/facilitator/src/vercel";
import toolsFunction, { CLAIM_MS, HANDLER_TIMEOUT_MS, MAX_DURATION_SECONDS as TOOLS_MAX_DURATION, createServerlessTools, toolsPrefix } from "../../../examples/paid-tools/src/vercel";
import { ToolServerEnvError, createToolApp, readToolServerEnv, rpcFromProvider } from "../../../examples/paid-tools/src";
import type { Rpc } from "../../../examples/paid-tools/src";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { fakeExplorer } from "../../helpers/explorer";
import { FakeRedis, serveRest } from "../../helpers/fake-redis";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const secret = () => randomBytes(24).toString("hex");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ROUTER = `0x${"12".repeat(20)}`;

describe("Redis over Upstash's REST interface", () => {
  it("sends one command as a JSON array with the token in a header, and runs scripts", async () => {
    const redis = new FakeRedis();
    const token = secret();
    const rest = await serveRest(redis, token);
    try {
      const client = new UpstashRest({ url: rest.url, token: () => token });
      expect(await client.command(["SET", "k", 5])).to.equal("OK");
      expect(await client.command(["GET", "k"])).to.equal("5");
      expect(await client.command(["GET", "absent"])).to.equal(null);
      expect(await client.eval("return { KEYS[1], ARGV[1] }", ["one"], [2])).to.deep.equal(["one", "2"]);
      expect(JSON.parse(rest.bodies[0] as string)).to.deep.equal(["SET", "k", "5"]);
      expect(rest.bodies.join("")).to.not.contain(token);
    } finally {
      await rest.close();
    }
  });

  it("puts neither the address, the token nor the database's own words in an error", async () => {
    const redis = new FakeRedis();
    const token = secret();
    const rest = await serveRest(redis, token);
    const wrong = secret();
    const refused = await rejection(new UpstashRest({ url: rest.url, token: () => wrong }).command(["GET", "k"]));
    expect(refused.message).to.equal("the database refused a command (HTTP 401)");
    await redis.command(["SADD", "a-set", "member"]);
    const typed = await rejection(new UpstashRest({ url: rest.url, token: () => token }).command(["GET", "a-set"]));
    expect(typed.message).to.equal("the database refused a command (HTTP 400)");
    await rest.close();
    const gone = await rejection(new UpstashRest({ url: rest.url, token: () => token }, 500).command(["GET", "k"]));
    expect(gone.message).to.equal("the database could not be reached");
    for (const e of [refused, typed, gone]) {
      for (const hidden of [token, wrong, rest.url, "a-set"]) expect(`${e.message}\n${e.stack}`).to.not.contain(hidden);
    }
    const html = new UpstashRest({ url: "https://database.invalid", token: () => token }, 500, (async () => new Response("<html>", { status: 502 })) as typeof fetch);
    expect((await rejection(html.command(["PING"]))).message).to.equal("the database answered HTTP 502 with nothing readable");
  });

  it("reads the address and token as a pair from one source, https only, and never shows the token", () => {
    const own = { SLUICE_REDIS_REST_URL: "https://own.example/", SLUICE_REDIS_REST_TOKEN: "own-token" };
    const upstash = { UPSTASH_REDIS_REST_URL: "https://up.example", UPSTASH_REDIS_REST_TOKEN: "up-token" };
    const kv = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kv-token", KV_REST_API_READ_ONLY_TOKEN: "read-only" };
    expect(readRedisCredentials({})).to.equal(undefined);
    expect(readRedisCredentials({ KV_REST_API_READ_ONLY_TOKEN: "read-only" })).to.equal(undefined);
    const first = readRedisCredentials({ ...own, ...upstash, ...kv });
    expect([first?.url, first?.token()]).to.deep.equal(["https://own.example", "own-token"]);
    expect(readRedisCredentials({ ...upstash, ...kv })?.token()).to.equal("up-token");
    expect(readRedisCredentials(kv)?.token()).to.equal("kv-token");
    expect(JSON.stringify(first)).to.not.contain("own-token");
    expect(Object.keys(first as object)).to.deep.equal(["url"]);
    expect(() => readRedisCredentials({ SLUICE_REDIS_REST_URL: "https://own.example", ...{ UPSTASH_REDIS_REST_TOKEN: "other" } })).to.throw(/must both be set/);
    expect(() => readRedisCredentials({ KV_REST_API_TOKEN: "kv-token" })).to.throw(/must both be set/);
    for (const url of ["http://far.example", "redis://own.example", "http://127.0.0.1.far.example"]) {
      const err = (() => {
        try {
          readRedisCredentials({ ...own, SLUICE_REDIS_REST_URL: url });
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      })();
      expect(err, url).to.equal("SLUICE_REDIS_REST_URL must be an https address");
    }
    expect(readRedisCredentials({ ...own, SLUICE_REDIS_REST_URL: "http://127.0.0.1:9" })?.url).to.equal("http://127.0.0.1:9");
  });

  it("gives a payment to one copy at a time, lets only that copy give it back, and frees it when the claim runs out", async () => {
    let now = 1_000_000;
    const redis = new FakeRedis(() => now);
    const a = new RedisIdempotencyStore(redis, "t:", { claimMs: 5_000, entrySeconds: 60 });
    const b = new RedisIdempotencyStore(redis, "t:", { claimMs: 5_000, entrySeconds: 60 });
    expect(await Promise.all([a.claim("p"), b.claim("p")])).to.have.members([true, false]);
    await b.release("p");
    expect(await b.claim("p"), "a copy that holds nothing gives nothing back").to.equal(false);
    await a.release("p");
    expect(await b.claim("p")).to.equal(true);
    now += 5_001;
    expect(await a.claim("p"), "the claim of a copy that died runs out").to.equal(true);
    await b.release("p");
    expect(await b.claim("p"), "the late release of the old claim leaves the new one").to.equal(false);

    const entry = { argsHash: "h", state: "settled" } as unknown as Parameters<typeof a.set>[1];
    await a.set("p", entry);
    expect(await b.get("p")).to.deep.equal(entry);
    now += 61_000;
    expect(await b.get("p")).to.equal(undefined);
    redis.down = true;
    expect((await rejection(a.claim("q"))).message).to.equal("the database could not be reached");
  });

  it("counts one caller's requests once for all copies", async () => {
    let now = 5_000;
    const redis = new FakeRedis(() => now);
    const a = new RedisRateLimiter(redis, "r:", 3, 10_000);
    const b = new RedisRateLimiter(redis, "r:", 3, 10_000);
    expect(await a.hit("X")).to.deep.equal({ ok: true });
    expect(await b.hit("x")).to.deep.equal({ ok: true });
    expect(await a.hit("x")).to.deep.equal({ ok: true });
    expect(await b.hit("x")).to.deep.equal({ ok: false, retryAfterSeconds: 10 });
    expect(await b.hit("y")).to.deep.equal({ ok: true });
    now += 10_001;
    expect(await a.hit("x")).to.deep.equal({ ok: true });
    expect(() => new RedisRateLimiter(redis, "r:", 0, 1)).to.throw(/positive/);
  });
});

describe("The facilitator as a serverless function: settings", () => {
  const token = secret();
  const sweep = secret();
  const base = () => ({
    SLUICE_NETWORK: "local",
    SLUICE_RPC_URL: "http://127.0.0.1:1",
    SLUICE_ROUTER: ROUTER,
    SLUICE_RELAYER_KEY: throwawayWallet().privateKey,
    SLUICE_REDIS_REST_URL: "https://db.example",
    SLUICE_REDIS_REST_TOKEN: token,
    SLUICE_FACILITATOR_SWEEP_SECRET: sweep,
  });

  it("needs a database and a sweeper's secret, and refuses a state file or a kill file", () => {
    const env = readEnv(base(), "serverless");
    expect(env.redis?.url).to.equal("https://db.example");
    expect(env.statePath).to.equal(undefined);
    expect(env.trustedProxyHops).to.equal(1);
    expect(env.drainSecrets()).to.deep.equal([sweep]);
    const shown = JSON.stringify(env, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(shown).to.contain("db.example");
    expect(shown).to.not.contain(sweep);
    expect(shown).to.not.contain(token);
    const cron = secret();
    expect(readEnv({ ...base(), CRON_SECRET: cron }, "serverless").drainSecrets()).to.deep.equal([sweep, cron]);
    expect(readEnv({ ...base(), SLUICE_FACILITATOR_TRUST_PROXY_HOPS: "2" }, "serverless").trustedProxyHops).to.equal(2);

    const refusals: Array<[Record<string, string>, RegExp]> = [
      [{ SLUICE_REDIS_REST_URL: "", SLUICE_REDIS_REST_TOKEN: "" }, /set SLUICE_REDIS_REST_URL/],
      [{ SLUICE_REDIS_REST_TOKEN: "" }, /must both be set/],
      [{ SLUICE_REDIS_REST_URL: "http://db.example" }, /https/],
      [{ SLUICE_FACILITATOR_SWEEP_SECRET: "" }, /SWEEP_SECRET/],
      [{ SLUICE_FACILITATOR_SWEEP_SECRET: "short" }, /SWEEP_SECRET/],
      [{ SLUICE_FACILITATOR_SWEEP_SECRET: `${"a".repeat(30)} b` }, /SWEEP_SECRET/],
      [{ CRON_SECRET: "short" }, /CRON_SECRET/],
      [{ SLUICE_FACILITATOR_STATE: "/tmp/queue.jsonl" }, /no disk that lasts/],
      [{ SLUICE_FACILITATOR_KILL_FILE: "/tmp/stop" }, /reads no kill file/],
    ];
    for (const [bad, why] of refusals) {
      expect(() => readEnv({ ...base(), ...bad }, "serverless"), JSON.stringify(Object.keys(bad))).to.throw(EnvError, why);
    }
    // A process that runs on asks for neither, and keeps its own default of believing no proxy.
    const server = readEnv({ ...base(), SLUICE_REDIS_REST_URL: "", SLUICE_REDIS_REST_TOKEN: "", SLUICE_FACILITATOR_SWEEP_SECRET: "" }, "server");
    expect(server.trustedProxyHops).to.equal(0);
    expect(server.redis).to.equal(undefined);
    expect(server.drainSecrets()).to.deep.equal([]);
  });

  it("starts on mainnet only where the platform says the deployment is production", async () => {
    const mainnet = { ...base(), SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: "https://rpc.example", SLUICE_APPROVE: "facilitator", SLUICE_MAX_QIE: "1" };
    for (const VERCEL_ENV of [undefined, "preview", "development", "Production"]) {
      const err = await rejection(createServerlessFacilitator({ env: { ...mainnet, VERCEL_ENV }, client: new FakeRedis(), write: () => undefined }));
      expect(err, String(VERCEL_ENV)).to.be.instanceOf(EnvError);
      expect(err.message).to.contain("VERCEL_ENV must be production");
    }
  });

  it("keeps its times inside one another", () => {
    expect(LOCK_TTL_MS, "the lock outlives the function").to.be.greaterThan(MAX_DURATION_SECONDS * 1000);
    expect(LOCK_WAIT_MS + RECEIPT_TIMEOUT_MS).to.be.lessThan(MAX_DURATION_SECONDS * 1000);
    expect(LOCK_WAIT_MS + 2 * PAYER_RECEIPT_TIMEOUT_MS + RECEIPT_TIMEOUT_MS, "a start: the top-up's wait, then the payer's two").to.be.lessThan(MAX_DURATION_SECONDS * 1000);
    expect(DRAIN_BUDGET_MS + 10_000).to.be.lessThan(MAX_DURATION_SECONDS * 1000);
    expect(RECEIPT_TIMEOUT_MS + 10_000, "a drain has time for at least one batch").to.be.lessThan(DRAIN_BUDGET_MS);
    expect(CLAIM_MS, "a claim outlives the function").to.be.greaterThan(TOOLS_MAX_DURATION * 1000);
    expect(HANDLER_TIMEOUT_MS).to.be.lessThan(TOOLS_MAX_DURATION * 1000);
  });

  it("answers 503 with a fixed message when it cannot start, and gives away nothing", async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env)) if (/^(SLUICE_|CRON_SECRET|VERCEL|UPSTASH_|KV_)/.test(name)) delete process.env[name];
    const written: string[] = [];
    const log = console.log;
    const error = console.error;
    const out = process.stdout.write.bind(process.stdout);
    const errOut = process.stderr.write.bind(process.stderr);
    try {
      for (const handler of [facilitatorFunction, toolsFunction]) {
        let status = 0;
        let body = "";
        const res = { writeHead: (s: number) => ((status = s), res), end: (t: string) => void (body = t) } as unknown as ServerResponse;
        console.log = console.error = (...a: unknown[]) => void written.push(a.join(" "));
        process.stdout.write = process.stderr.write = ((t: string) => (written.push(String(t)), true)) as typeof process.stdout.write;
        await handler({} as IncomingMessage, res);
        await handler({} as IncomingMessage, res); // a failed start is tried again, not remembered
        console.log = log;
        console.error = error;
        process.stdout.write = out;
        process.stderr.write = errOut;
        expect(status).to.equal(503);
        expect(JSON.parse(body)).to.deep.equal({ error: ERRORS.facilitatorUnavailable });
      }
    } finally {
      console.log = log;
      console.error = error;
      process.stdout.write = out;
      process.stderr.write = errOut;
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
    expect(written.join("\n")).to.contain("refusing to start: set SLUICE_NETWORK");
  });
});

describe("The facilitator as a serverless function: requests", function () {
  this.timeout(180_000);
  let s: Stack;
  let redis: FakeRedis;
  let rest: Awaited<ReturnType<typeof serveRest>>;
  let relayer: Wallet;
  let payer: Wallet;
  let builder: string;
  let lines: string[];
  let background: Array<Promise<unknown>>;
  const token = secret();
  const sweep = secret();
  const cron = secret();
  const closers: Array<() => Promise<void>> = [];

  const settings = (extra: Record<string, string> = {}) => ({
    SLUICE_NETWORK: "local",
    SLUICE_RPC_URL: s.rpcUrl,
    SLUICE_ROUTER: s.routerAddress,
    SLUICE_RELAYER_KEY: relayer.privateKey,
    SLUICE_REDIS_REST_URL: rest.url,
    SLUICE_REDIS_REST_TOKEN: token,
    SLUICE_FACILITATOR_SWEEP_SECRET: sweep,
    CRON_SECRET: cron,
    // The tool server's tests below use the same stand-in database, as one shared database does.
    SLUICE_FACILITATOR_SHARED_DATABASE: "one-token-for-both-services",
    ...extra,
  });
  const serve = async (listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    const server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  /** One copy of the function: the real REST client, the stand-in database behind it. */
  const instance = async (extra: Record<string, string> = {}, more: Partial<ServerlessOptions> = {}) => {
    const app = await createServerlessFacilitator({
      env: settings(extra),
      provider: s.provider,
      now: s.clock,
      write: (l) => lines.push(l),
      waitUntil: (work) => void background.push(work),
      ...more,
    });
    return { app, url: await serve(app.listener) };
  };
  const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const drain = (url: string, auth?: string, method = "POST") => fetch(`${url}/internal/drain`, { method, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  const pay = () => makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.01")));
  const settled = async () => (await s.router.queryFilter(s.router.filters.Settled!())).length;

  beforeEach(async () => {
    await freshChain();
    s = await startStack({ feeBps: 100 });
    redis = new FakeRedis();
    rest = await serveRest(redis, token);
    relayer = throwawayWallet();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    lines = [];
    background = [];
    await setQie(relayer.address, parseEther("1"));
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await Promise.allSettled(background);
    for (const close of closers.splice(0)) await close();
    await rest.close();
    await s.stop();
  });

  it("settles a payment in the background of the request that queued it", async () => {
    const { app, url } = await instance();
    const m = await pay();
    const answer = (await (await post(url, "/settle", verifyBody(m))).json()) as { success: boolean; extensions: { sluice: { id: string; status: string } } };
    expect(answer.success).to.equal(true);
    expect(answer.extensions.sluice.status).to.equal("queued");
    expect(background, "the drain was handed to the platform to finish").to.have.length(1);
    await Promise.all(background);
    expect((await app.facilitator.status(m.digest))?.status).to.equal("settled");
    expect(await settled()).to.equal(1);
    // Sent again, it is the same record: nothing new is drained, and nothing is paid twice.
    const again = (await (await post(url, "/settle", verifyBody(m))).json()) as { success: boolean; extensions: { sluice: { status: string } } };
    expect(again.extensions.sluice.status).to.equal("settled");
    expect(background).to.have.length(1);
    // A refused payment starts no drain.
    await post(url, "/settle", { nonsense: true });
    expect(background).to.have.length(1);
    expect(await settled()).to.equal(1);
  });

  it("drains for a caller with either secret, by GET or POST, and for nobody else", async () => {
    const { app, url } = await instance();
    // The relayer is someone else's while the two payments arrive, so their own drains send nothing and the payments wait.
    const other = (await app.ledger.lock("relayer", 600_000))!;
    await post(url, "/settle", verifyBody(await pay()));
    await post(url, "/settle", verifyBody(await pay()));
    await Promise.all(background);
    expect(await (await fetch(`${url}/health`)).json()).to.include({ queued: 2 });
    expect(await (await drain(url, sweep)).json()).to.include({ held: "relayer_busy", submitted: 0, remaining: 2 });
    await other.release();

    for (const auth of [undefined, "wrong", secret(), `${sweep}x`, sweep.slice(0, -1), relayer.privateKey]) {
      const refused = await drain(url, auth);
      expect(refused.status).to.equal(401);
      expect(await refused.json()).to.deep.equal({ error: "unauthorized" });
    }
    expect((await fetch(`${url}/internal/drain?secret=${sweep}`)).status, "the secret is read from the header only").to.equal(401);
    expect((await drain(url, sweep, "PUT")).status).to.equal(405);
    expect(lines.join("\n")).to.contain("drain refused");
    expect(await settled(), "no refused call sent anything").to.equal(0);
    const preflight = await fetch(`${url}/internal/drain`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
    expect(preflight.headers.get("access-control-allow-origin")).to.equal(null);

    const bySweeper = await drain(url, sweep);
    expect(bySweeper.status).to.equal(200);
    expect(await bySweeper.json()).to.include({ settled: 2, remaining: 0 });
    const byCron = await drain(url, cron, "GET");
    expect(byCron.status).to.equal(200);
    expect(await byCron.json()).to.include({ submitted: 0, settled: 0, remaining: 0 });
    expect(await settled()).to.equal(2);
    for (const hidden of [sweep, cron, token, relayer.privateKey, relayer.privateKey.slice(2)]) expect(lines.join("\n")).to.not.contain(hidden);
  });

  it("settles once when the sweeper, the cron and two payments all ask at the same time", async () => {
    const a = await instance();
    const b = await instance();
    const made = [await pay(), await pay(), await pay()];
    await Promise.all([post(a.url, "/settle", verifyBody(made[0]!)), post(b.url, "/settle", verifyBody(made[1]!))]);
    await post(a.url, "/settle", verifyBody(made[2]!));
    await Promise.all([drain(a.url, sweep), drain(b.url, cron, "GET"), drain(a.url, sweep), drain(b.url, sweep)]);
    await Promise.all(background);
    await drain(b.url, sweep);
    expect(await settled()).to.equal(3);
    expect((await s.router.queryFilter(s.router.filters.SettleSkipped!())).length).to.equal(0);
    for (const m of made) expect((await a.app.facilitator.status(m.digest))?.status).to.equal("settled");
  });

  it("counts requests once for all copies, by address and by payer", async () => {
    const limits = { SLUICE_FACILITATOR_RATE_LIMIT_IP: "5", SLUICE_FACILITATOR_RATE_LIMIT_PAYER: "2" };
    const a = await instance(limits);
    const b = await instance(limits);
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    const body = verifyBody(await pay());
    expect((await post(a.url, "/verify", body, from("9.9.9.1"))).status).to.equal(200);
    expect((await post(b.url, "/verify", body, from("9.9.9.2"))).status).to.equal(200);
    const third = await post(a.url, "/verify", body, from("9.9.9.3"));
    expect(third.status, "the payer's third, on either copy").to.equal(429);
    expect(Number(third.headers.get("retry-after"))).to.be.within(1, 60);
    for (let i = 0; i < 5; i++) expect((await fetch(`${i % 2 ? a.url : b.url}/status/0x00`, { headers: from("8.8.8.8") })).status).to.equal(404);
    expect((await fetch(`${a.url}/status/0x00`, { headers: from("8.8.8.8") })).status).to.equal(429);
    expect((await fetch(`${b.url}/status/0x00`, { headers: from("8.8.4.4") })).status).to.equal(404);
  });

  it("serves nothing it cannot count, and drains nothing, while the database cannot be reached", async () => {
    const { url } = await instance();
    redis.down = true;
    const m = await pay();
    for (const answer of [await post(url, "/settle", verifyBody(m)), await fetch(`${url}/health`), await drain(url, sweep)]) {
      expect(answer.status).to.equal(503);
      expect((await answer.json()) as { error: string }).to.include({ error: ERRORS.storeUnavailable });
    }
    expect(background).to.have.length(0);
    redis.down = false;
    expect((await fetch(`${url}/health`)).status).to.equal(200);
    expect(await settled()).to.equal(0);
  });

  it("stops at the stored switch and at the environment's switch", async () => {
    const stored = await instance();
    const other = (await stored.app.ledger.lock("relayer", 600_000))!;
    await post(stored.url, "/settle", verifyBody(await pay()));
    await Promise.all(background);
    await other.release();
    await redis.command(["SET", new RedisLedger(redis, redisPrefix("local", s.routerAddress)).killSwitchKey, "1"]);
    expect(await (await drain(stored.url, sweep)).json()).to.include({ held: ERRORS.killSwitch, submitted: 0 });
    expect(await (await post(stored.url, "/settle", verifyBody(await pay()))).json()).to.include({ success: false, errorReason: ERRORS.killSwitch });
    await redis.command(["SET", new RedisLedger(redis, redisPrefix("local", s.routerAddress)).killSwitchKey, "0"]);
    const byEnv = await instance({ SLUICE_FACILITATOR_KILL_SWITCH: "1" });
    expect(await (await drain(byEnv.url, sweep)).json()).to.include({ held: ERRORS.killSwitch, submitted: 0 });
    expect(await (await fetch(`${byEnv.url}/health`)).json()).to.include({ killSwitch: true });
    expect(await settled()).to.equal(0);
    expect(await (await drain(stored.url, sweep)).json()).to.include({ settled: 1 });
  });

  it("reads a body the platform has already parsed, within the same size limit", async () => {
    const { app } = await instance({ SLUICE_FACILITATOR_MAX_BODY_BYTES: "4096" });
    const ask = async (parsed: unknown) => {
      // A request whose stream the platform has used up, with what it made of it on `body`.
      const req = Object.assign(Readable.from([]), { method: "POST", url: "/settle", headers: { "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, body: parsed }) as unknown as IncomingMessage;
      let status = 0;
      let text = "";
      const res = {
        setHeader: () => undefined,
        once: () => undefined,
        writeHead: (code: number) => ((status = code), res),
        end: (t: string) => void (text = t),
      } as unknown as ServerResponse;
      await app.listener(req, res);
      return { status, body: JSON.parse(text) as Record<string, unknown> };
    };
    const m = await pay();
    expect((await ask(verifyBody(m))).body).to.include({ success: true });
    expect((await ask(JSON.stringify(verifyBody(m)))).body).to.include({ success: true });
    expect((await ask(Buffer.from(JSON.stringify(verifyBody(m))))).body).to.include({ success: true });
    expect(await ask({ padding: "x".repeat(5_000) })).to.deep.include({ status: 400 });
    expect((await ask("not json")).status).to.equal(400);
    expect((await ask(undefined)).status, "a stream already read, with nothing handed on, is refused and not waited for").to.equal(400);
    await Promise.all(background);
    expect(await settled()).to.equal(1);
  });

  // ------------------------------------------------------------------------------------------------------------------ the tool server

  const toolSettings = (facilitatorUrl: string) => ({
    SLUICE_NETWORK: "local",
    SLUICE_ROUTER: s.routerAddress,
    SLUICE_PAYEE: builder,
    SLUICE_FACILITATOR_URL: facilitatorUrl,
    SLUICE_RPC_URL: s.rpcUrl,
    SLUICE_REDIS_REST_URL: rest.url,
    SLUICE_REDIS_REST_TOKEN: token,
  });
  /** A node whose answer to getCode is slow and counted: getCode is what a run of contract_lookup does first. */
  const counted = () => {
    const real = rpcFromProvider(s.provider);
    const runs = { n: 0 };
    const rpc: Rpc = { ...real, getCode: async (address) => ((runs.n += 1), await pause(300), real.getCode(address)) };
    return { runs, rpc };
  };
  const call = (url: string, meta?: Record<string, unknown>, headers: Record<string, string> = {}) =>
    post(url, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "contract_lookup", arguments: { address: s.tokenAddress }, ...(meta ? { _meta: meta } : {}) } }, { accept: "application/json, text/event-stream", ...headers });
  type Answer = { result: { isError?: boolean; content: Array<{ text: string }> } };
  const lookup = () => makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.005"), "contract_lookup"));

  it("runs a tool once for one payment given to two copies of the tool server at the same moment", async () => {
    const facilitator = await instance();
    const { runs, rpc } = counted();
    const copies = await Promise.all([0, 1].map(async () => {
      const app = await createServerlessTools({ env: toolSettings(facilitator.url), rpc, explorer: fakeExplorer(s.provider) });
      closers.push(async () => app.destroy());
      return serve(app.listener);
    }));
    const made = await lookup();
    const meta = { [PAYMENT_META_KEY]: made.payload };
    const answers = (await Promise.all(copies.map(async (url) => (await call(url, meta)).json()))) as Answer[];
    expect(runs.n, "the tool ran once").to.equal(1);
    expect(answers.filter((a) => !a.result.isError)).to.have.length(1);
    expect(answers.find((a) => a.result.isError)?.result.content[0]?.text).to.contain("payment_in_progress");
    // Afterwards either copy gives the same payment its result again, without running the tool or charging again.
    for (const url of copies) expect(((await (await call(url, meta)).json()) as Answer).result.isError).to.not.equal(true);
    expect(runs.n).to.equal(1);
    await Promise.all(background);
    expect(await settled()).to.equal(1);
    expect(await s.router.earnings(builder)).to.equal(USDC("0.005") - USDC("0.005") / 100n);
  });

  it("control: two copies that each keep their own memory both run the tool", async () => {
    const facilitator = await instance();
    const { runs, rpc } = counted();
    const copies = await Promise.all([0, 1].map(async () => {
      const app = await createToolApp({ env: readToolServerEnv(toolSettings(facilitator.url)), rpc, explorer: fakeExplorer(s.provider) });
      closers.push(async () => app.destroy());
      return serve(app.listener);
    }));
    const meta = { [PAYMENT_META_KEY]: (await lookup()).payload };
    await Promise.all(copies.map(async (url) => (await call(url, meta)).json()));
    expect(runs.n, "this is what the shared claim prevents").to.equal(2);
  });

  it("runs nothing when the payment cannot be claimed or the request cannot be counted", async () => {
    const facilitator = await instance();
    const { runs, rpc } = counted();
    let claims = true;
    let counting = true;
    const flaky: RedisClient = {
      command: async (args) => {
        if (!claims && String(args[1]).includes(":claim:")) throw new Error("down");
        return redis.command(args);
      },
      eval: async (script, keys, args) => {
        if (!counting && keys[0]?.includes(":rate:")) throw new Error("down");
        return redis.eval(script, keys, args);
      },
    };
    const app = await createServerlessTools({ env: toolSettings(facilitator.url), client: flaky, rpc, explorer: fakeExplorer(s.provider) });
    closers.push(async () => app.destroy());
    const url = await serve(app.listener);
    const meta = { [PAYMENT_META_KEY]: (await lookup()).payload };
    claims = false;
    const unclaimed = (await (await call(url, meta)).json()) as Answer;
    expect(unclaimed.result.isError).to.equal(true);
    expect(unclaimed.result.content[0]?.text).to.contain(ERRORS.facilitatorUnavailable);
    claims = true;
    counting = false;
    expect((await call(url, meta)).status).to.equal(503);
    expect(runs.n).to.equal(0);
    counting = true;
    expect(((await (await call(url, meta)).json()) as Answer).result.isError).to.not.equal(true);
    expect(runs.n).to.equal(1);
  });

  it("limits the tool server's callers once for all copies, by the address the platform writes", async () => {
    const facilitator = await instance();
    const copy = async () => {
      const app = await createServerlessTools({ env: { ...toolSettings(facilitator.url), SLUICE_TOOLS_RATE_LIMIT_UNPAID: "2" }, explorer: fakeExplorer(s.provider) });
      closers.push(async () => app.destroy());
      return serve(app.listener);
    };
    const [a, b] = [await copy(), await copy()];
    const from = { "x-forwarded-for": "7.7.7.7" };
    expect((await call(a, undefined, from)).status).to.equal(200);
    expect((await call(b, undefined, from)).status).to.equal(200);
    expect((await call(a, undefined, from)).status).to.equal(429);
    expect((await call(b, undefined, { "x-forwarded-for": "6.6.6.6" })).status).to.equal(200);
    const keys = redis.log.length;
    expect(keys).to.be.greaterThan(0);
    expect(toolsPrefix("local", s.routerAddress)).to.not.equal(redisPrefix("local", s.routerAddress));
  });

  it("refuses to start the tool server without a database, and on mainnet outside a production deployment", async () => {
    const env = toolSettings("http://127.0.0.1:1");
    const none = await rejection(createServerlessTools({ env: { ...env, SLUICE_REDIS_REST_URL: "", SLUICE_REDIS_REST_TOKEN: "" } }));
    expect(none).to.be.instanceOf(ToolServerEnvError);
    expect(none.message).to.contain("SLUICE_REDIS_REST_URL");
    const half = await rejection(createServerlessTools({ env: { ...env, SLUICE_REDIS_REST_TOKEN: "" } }));
    expect(half.message).to.contain("must both be set");
    for (const VERCEL_ENV of [undefined, "preview"]) {
      const err = await rejection(createServerlessTools({ env: { ...env, SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: "https://rpc.example", SLUICE_FACILITATOR_URL: "https://f.example", VERCEL_ENV } }));
      expect(err.message).to.contain("VERCEL_ENV must be production");
    }
  });
});
