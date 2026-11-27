// One database for the facilitator and the tool server. The tool server's guard is tried with every kind of request it must refuse; both
// serverless functions are run on one stand-in database while every key each of them touches is written down; the facilitator is shown
// to refuse a shared database it was not told about; and the switch in the settings is shown to hold whatever the database says. Every
// key and secret was made for the run. Nothing leaves this machine.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { parseEther } from "ethers";
import type { Wallet } from "ethers";
import { EnvError, RedisLedger, SHARED_DATABASE_ACCEPTED, SHARED_DATABASE_PROBLEM, redisPrefix } from "@sluice/facilitator";
import {
  ERRORS, FACILITATOR_KEY_PREFIX, PAYMENT_META_KEY, RATE_SCRIPT, RELEASE_SCRIPT, RedisRefused, TOOLS_KEY_PREFIX, TOOLS_MARKER_KEY,
  TOOLS_MARKER_VALUE, TOOL_MAX_TTL_MS, TOOL_MAX_VALUE_BYTES, TOOL_SCRIPTS, ToolServerRedis, namesOnlyGivenKeys,
} from "@sluice/sdk";
import type { RedisClient } from "@sluice/sdk";
import { createServerlessFacilitator } from "../../../packages/facilitator/src/vercel";
import type { ServerlessOptions } from "../../../packages/facilitator/src/vercel";
import { MARK_EVERY_MS, createServerlessTools, toolsPrefix } from "../../../examples/paid-tools/src/vercel";
import type { ServerlessToolOptions } from "../../../examples/paid-tools/src/vercel";
import { ToolServerEnvError, rpcFromProvider } from "../../../examples/paid-tools/src";
import type { Rpc } from "../../../examples/paid-tools/src";
import { safeReaddir } from "../../../src/secret-paths";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { fakeExplorer } from "../../helpers/explorer";
import { FakeRedis, slowed } from "../../helpers/fake-redis";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const ROUTER = `0x${"12".repeat(20)}`;
const OWN = toolsPrefix("local", ROUTER);
const THEIRS = redisPrefix("local", ROUTER);
/** The facilitator's keys that matter most: its switch, a day's caps, its budget, its lock, its queue. */
const PRECIOUS = [`${THEIRS}kill`, `${THEIRS}usage:intent:2026-11-27:*`, `${THEIRS}budget:2026-11-27:spent`, `${THEIRS}lock:relayer`, `${THEIRS}fence`, `${THEIRS}queued`, `${THEIRS}intent:0x01`];

describe("A tool server's database guard", () => {
  let redis: FakeRedis;
  let guard: ToolServerRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    guard = new ToolServerRedis(redis, OWN);
  });
  /** The request is refused, and nothing at all reaches the database. */
  const refused = async (request: () => Promise<unknown>, what: string) => {
    const before = redis.log.length;
    expect(await rejection(request()), what).to.be.instanceOf(RedisRefused);
    expect(redis.log.length, `${what}: nothing reached the database`).to.equal(before);
  };

  it("keeps the two services' keys under two fixed prefixes, neither inside the other", () => {
    expect([FACILITATOR_KEY_PREFIX, TOOLS_KEY_PREFIX]).to.deep.equal(["sluice:facilitator:", "sluice:tools:"]);
    expect(redisPrefix("mainnet", ROUTER)).to.equal(`sluice:facilitator:mainnet:${ROUTER}:`);
    expect(toolsPrefix("mainnet", ROUTER.toUpperCase().replace("0X", "0x"))).to.equal(`sluice:tools:mainnet:${ROUTER}:`);
    expect(TOOLS_MARKER_KEY.startsWith(TOOLS_KEY_PREFIX)).to.equal(true);
    expect(FACILITATOR_KEY_PREFIX.startsWith(TOOLS_KEY_PREFIX) || TOOLS_KEY_PREFIX.startsWith(FACILITATOR_KEY_PREFIX)).to.equal(false);
    // No setting names a prefix.
    for (const file of ["packages/sdk/src/redis.ts", "packages/facilitator/src/env.ts", "examples/paid-tools/src/host.ts"]) {
      expect(readFileSync(join(__dirname, "..", "..", "..", file), "utf8"), file).to.not.match(/env\.[A-Z_]*PREFIX/);
    }
  });

  it("lets through what a tool server does: its own keys, with an expiry, its two scripts and its mark", async () => {
    expect(await guard.command(["SET", `${OWN}entry:a`, "x", "EX", 60])).to.equal("OK");
    expect(await guard.command(["GET", `${OWN}entry:a`])).to.equal("x");
    expect(await guard.command(["SET", `${OWN}claim:a`, "t", "NX", "PX", 5_000])).to.equal("OK");
    expect(await guard.command(["SET", `${OWN}claim:a`, "u", "NX", "PX", 5_000])).to.equal(null);
    expect(await guard.eval(RATE_SCRIPT, [`${OWN}rate:ip:1.2.3.4`], [5, 1_000])).to.deep.equal([1, 1_000]);
    expect(await guard.eval(RELEASE_SCRIPT, [`${OWN}claim:a`], ["t"])).to.equal(1);
    expect(await guard.command(["SET", TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE])).to.equal("OK");
  });

  it("refuses every other command, FLUSHALL, FLUSHDB, CONFIG, KEYS, SCAN and EVAL among them", async () => {
    const commands: Array<Array<string | number>> = [
      ["FLUSHALL"], ["FLUSHDB"], ["flushall"], ["CONFIG", "GET", "*"], ["CONFIG", "SET", "maxmemory-policy", "allkeys-lru"],
      ["KEYS", "*"], ["KEYS", `${OWN}*`], ["KEYS", `${FACILITATOR_KEY_PREFIX}*`],
      ["SCAN", "0"], ["SCAN", "0", "MATCH", `${OWN}*`], ["SCAN", "0", "MATCH", `${FACILITATOR_KEY_PREFIX}*`], ["SCAN", "0", "MATCH", "*"],
      ["EVAL", "return redis.call('FLUSHALL')", 0], ["EVAL", RELEASE_SCRIPT, 1, `${OWN}claim:a`, "t"], ["EVALSHA", "0".repeat(40), 0], ["SCRIPT", "LOAD", "return 1"], ["FUNCTION", "LOAD", "x"],
      ["DEL", `${OWN}entry:a`], ["UNLINK", `${OWN}entry:a`], ["MGET", `${OWN}entry:a`], ["EXISTS", `${OWN}entry:a`], ["TYPE", `${OWN}entry:a`], ["EXPIRE", `${OWN}entry:a`, 1], ["PERSIST", `${OWN}entry:a`],
      ["RENAME", `${OWN}a`, `${OWN}b`], ["COPY", `${OWN}a`, `${OWN}b`], ["INCR", `${OWN}n`], ["HGET", `${OWN}h`, "f"], ["HSET", `${OWN}h`, "f", "v"], ["SMEMBERS", `${OWN}s`], ["ZADD", `${OWN}z`, 1, "m"], ["LPUSH", `${OWN}l`, "v"],
      ["DBSIZE"], ["RANDOMKEY"], ["MULTI"], ["SELECT", 1], ["SWAPDB", 0, 1], ["ACL", "WHOAMI"], ["INFO"], ["MONITOR"], ["SUBSCRIBE", "c"], ["PING"],
      ["get", `${OWN}entry:a`], [" GET", `${OWN}entry:a`], ["GET "], ["GET"], ["GET", `${OWN}a`, `${OWN}b`], [],
    ];
    for (const command of commands) await refused(() => guard.command(command), JSON.stringify(command));
    for (const odd of [[["GET"], `${OWN}a`], ["GET", { toString: () => `${OWN}a` }], ["GET", null], ["SET", `${OWN}a`, {}, "EX", 5], ["GET", Number.NaN]]) {
      await refused(() => guard.command(odd as never), "an argument that is not text or a number");
    }
  });

  it("refuses every key that is not under its own prefix, the facilitator's switch, caps, budget and lock first among them", async () => {
    const outside = [...PRECIOUS, `${FACILITATOR_KEY_PREFIX}mainnet:${ROUTER}:kill`, toolsPrefix("mainnet", ROUTER) + "entry:a", OWN, OWN.slice(0, -1), `x${OWN}a`, OWN.toUpperCase() + "a", TOOLS_MARKER_KEY + "x", ""];
    for (const key of PRECIOUS) await redis.command(["SET", key, "kept"]);
    for (const key of outside) {
      await refused(() => guard.command(["GET", key]), `GET ${key}`);
      await refused(() => guard.command(["SET", key, "0", "EX", 60]), `SET ${key}`);
      await refused(() => guard.eval(RELEASE_SCRIPT, [key], ["kept"]), `release ${key}`);
      await refused(() => guard.eval(RATE_SCRIPT, [key], [1, 1_000]), `rate ${key}`);
    }
    await refused(() => guard.command(["GET", TOOLS_MARKER_KEY]), "the mark is written, never read");
    for (const keys of [[], [`${OWN}a`, `${OWN}b`], [`${OWN}a`, PRECIOUS[0]!]]) await refused(() => guard.eval(RELEASE_SCRIPT, keys, ["t"]), `keys ${keys.join(" ")}`);
    await refused(() => guard.eval(RELEASE_SCRIPT, [5 as never], ["t"]), "a key that is not text");
    for (const key of PRECIOUS) expect(await redis.command(["GET", key]), key).to.equal("kept");
  });

  it("writes only keys that expire within a day, of a limited size, and its mark with the mark's own value", async () => {
    const key = `${OWN}entry:a`;
    const sets: Array<Array<string | number>> = [
      [key, "v"], [key, "v", "KEEPTTL"], [key, "v", "XX", "EX", 5], [key, "v", "GET", "EX", 5], [key, "v", "NX"], [key, "v", "NX", "NX", "EX", 5], [key, "v", "EX", 5, "PX", 5],
      [key, "v", "EX", 0], [key, "v", "EX", -1], [key, "v", "EX", "1.5"], [key, "v", "EX", "soon"], [key, "v", "EX"], [key, "v", "EXAT", 5], [key, "v", "EX", 86_401], [key, "v", "PX", TOOL_MAX_TTL_MS + 1],
      [key, "x".repeat(TOOL_MAX_VALUE_BYTES + 1), "EX", 5], [key, "€".repeat(TOOL_MAX_VALUE_BYTES / 2), "EX", 5],
      [TOOLS_MARKER_KEY, "something else"], [TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE, "EX", 5], [TOOLS_MARKER_KEY],
    ];
    for (const set of sets) await refused(() => guard.command(["SET", ...set]), JSON.stringify(set).slice(0, 80));
    expect(await guard.command(["SET", key, "x".repeat(TOOL_MAX_VALUE_BYTES), "EX", 86_400])).to.equal("OK");
    expect(await guard.command(["SET", key, "v", "PX", TOOL_MAX_TTL_MS])).to.equal("OK");
  });

  it("runs no script but its own two, character for character", async () => {
    const key = `${OWN}a`;
    for (const script of [
      "return redis.call('GET', KEYS[1])", "return redis.call('FLUSHALL')", "return redis.call('GET', ARGV[1])", `return redis.call('GET', '${PRECIOUS[0]}')`,
      `${RELEASE_SCRIPT} `, RELEASE_SCRIPT.trim(), `${RATE_SCRIPT}return redis.call('GET', ARGV[1])`, "", "return 1",
    ]) {
      await refused(() => guard.eval(script, [key], [PRECIOUS[0]!]), script);
    }
    expect(TOOL_SCRIPTS.map((s) => s.script)).to.deep.equal([RATE_SCRIPT, RELEASE_SCRIPT]);
  });

  it("holds its scripts to naming keys through KEYS alone, with a check that tells a script that does otherwise", () => {
    for (const { script } of TOOL_SCRIPTS) expect(namesOnlyGivenKeys(script)).to.equal(true);
    for (const script of [
      "return redis.call('GET', ARGV[1])", "return redis.call('GET', ARGV[1] .. KEYS[1])", "return redis.call('GET', KEYS[1] .. 'x')", "return redis.call('GET', 'a:key')",
      "local k = ARGV[1]\nreturn redis.call('GET', k)", "return redis.call(ARGV[1], KEYS[1])", "return redis.call('DEL', KEYS[1], ARGV[1])", "local r = redis\nreturn r.call('GET', ARGV[1])",
      "local c = redis.call\nreturn c('GET', ARGV[1])", "return redis.pcall('GET', ARGV[1])", "return redis.call('SCAN', KEYS[1])", "return redis.call('FLUSHALL')", "return redis['call']('GET', ARGV[1])",
      "return redis.call('GET', KEYS[0])", "return redis.call('GET', KEYS[tonumber(ARGV[1])])", "return 1",
    ]) {
      expect(namesOnlyGivenKeys(script), script).to.equal(false);
    }
    // The facilitator's own scripts build key names, which is why the tool server could not be given them even with its own keys.
    const ledger = readFileSync(join(__dirname, "..", "..", "..", "packages/facilitator/src/redis-ledger.ts"), "utf8");
    expect(ledger).to.contain("redis.call('GET', ARGV[1] .. id)");
  });

  it("takes a prefix under the tool servers' own, and no other", () => {
    for (const prefix of [THEIRS, FACILITATOR_KEY_PREFIX, TOOLS_KEY_PREFIX, "", "sluice:", `${TOOLS_KEY_PREFIX}local`, `x${OWN}`]) {
      expect(() => new ToolServerRedis(redis, prefix), prefix).to.throw(RedisRefused);
    }
  });

  it("sends what it checked, whatever the caller does to the request afterwards", async () => {
    const slow = new ToolServerRedis(slowed(redis, () => new Promise((resolve) => setTimeout(resolve, 5))), OWN);
    await redis.command(["SET", PRECIOUS[0]!, "kept"]);
    const command: Array<string | number> = ["SET", `${OWN}a`, "mine", "EX", 60];
    const keys = [`${OWN}b`];
    await redis.command(["SET", `${OWN}b`, "t"]);
    const both = [slow.command(command), slow.eval(RELEASE_SCRIPT, keys, ["t"])];
    command[1] = PRECIOUS[0]!;
    keys[0] = PRECIOUS[0]!;
    await Promise.all(both);
    expect(await redis.command(["GET", PRECIOUS[0]!])).to.equal("kept");
    expect(await redis.command(["GET", `${OWN}a`])).to.equal("mine");
    expect(await redis.command(["GET", `${OWN}b`])).to.equal(null);
  });

  it("is the only client of the database the tool server's code makes or holds", () => {
    const dir = join(__dirname, "..", "..", "..", "examples", "paid-tools", "src");
    const sources = safeReaddir(dir).filter((f) => f.endsWith(".ts")).map((f) => ({ f, text: readFileSync(join(dir, f), "utf8") }));
    expect(sources.length).to.be.greaterThan(5);
    for (const { f, text } of sources) expect(text, f).to.not.match(/FACILITATOR_KEY_PREFIX|sluice:facilitator|@sluice\/facilitator|RedisLedger|redisPrefix/);
    const naming = (pattern: RegExp) => sources.flatMap(({ f, text }) => text.split("\n").filter((l) => pattern.test(l) && !/^\s*import /.test(l)).map((l) => `${f}: ${l.trim()}`));
    const made = "vercel.ts: const client = new ToolServerRedis(options.client ?? new UpstashRest(redis), prefix);";
    expect(naming(/UpstashRest\(|options\.client|ToolServerRedis\(/)).to.deep.equal([made]);
    // What the server's stores and limiters are given is that client.
    for (const line of naming(/new Redis(IdempotencyStore|RateLimiter)\(/)) expect(line).to.match(/new Redis(IdempotencyStore|RateLimiter)\(client, /);
    for (const file of ["redis-idempotency.ts", "paid-tool.ts"]) {
      expect(readFileSync(join(__dirname, "..", "..", "..", "packages", "sdk", "src", file), "utf8"), file).to.not.match(/FACILITATOR_KEY_PREFIX|sluice:facilitator/);
    }
  });
});

describe("The two functions on one database", function () {
  this.timeout(240_000);
  let s: Stack;
  let redis: FakeRedis;
  let relayer: Wallet;
  let payer: Wallet;
  let builder: string;
  let background: Array<Promise<unknown>>;
  let lines: string[];
  const secret = randomBytes(24).toString("hex");
  const closers: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    await freshChain();
    s = await startStack({ feeBps: 100 });
    redis = new FakeRedis();
    relayer = throwawayWallet();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    background = [];
    lines = [];
    await setQie(relayer.address, parseEther("1"));
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await Promise.allSettled(background);
    for (const close of closers.splice(0)) await close();
    await s.stop();
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
  const common = () => ({ SLUICE_NETWORK: "local", SLUICE_RPC_URL: s.rpcUrl, SLUICE_ROUTER: s.routerAddress, SLUICE_REDIS_REST_URL: "https://database.invalid", SLUICE_REDIS_REST_TOKEN: "t".repeat(40) });
  const facilitator = async (extra: Record<string, string> = {}, more: Partial<ServerlessOptions> = {}) => {
    const app = await createServerlessFacilitator({
      env: { ...common(), SLUICE_RELAYER_KEY: relayer.privateKey, SLUICE_FACILITATOR_SWEEP_SECRET: secret, ...extra },
      client: redis,
      provider: s.provider,
      now: s.clock,
      write: (l) => lines.push(l),
      waitUntil: (work) => void background.push(work),
      captureWaitMs: 2_000,
      ...more,
    });
    return { app, url: await serve(app.listener) };
  };
  const accepting = { SLUICE_FACILITATOR_SHARED_DATABASE: SHARED_DATABASE_ACCEPTED };
  const tools = async (facilitatorUrl: string, extra: Record<string, string> = {}, more: Partial<ServerlessToolOptions> = {}) => {
    const app = await createServerlessTools({ env: { ...common(), SLUICE_PAYEE: builder, SLUICE_FACILITATOR_URL: facilitatorUrl, ...extra }, client: redis, explorer: fakeExplorer(s.provider), ...more });
    closers.push(() => app.destroy());
    return serve(app.listener);
  };
  const mcp = async (url: string, meta?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "contract_lookup", arguments: { address: s.tokenAddress }, ...(meta ? { _meta: meta } : {}) } }),
    });
    return { status: res.status, body: (await res.json()) as { result?: { isError?: boolean } } };
  };
  const lookup = () => makePayment(s, payer, payer.address, requirementsFor(s, builder, USDC("0.005"), "contract_lookup"));
  const paidFor = async (url: string) => mcp(url, { [PAYMENT_META_KEY]: (await lookup()).payload });
  const killKey = () => new RedisLedger(redis, redisPrefix("local", s.routerAddress)).killSwitchKey;
  const settledEvents = async () => (await s.router.queryFilter(s.router.filters.Settled!())).length;

  it("touches no key of the facilitator's from any path of the tool server, nor the other way about", async () => {
    const theirs = new Set<string>();
    const ours = new Set<string>();
    const f = await facilitator(accepting, { client: redis.watched(theirs) });
    await redis.command(["SET", killKey(), "0"]);
    let failing = 0;
    let broken = false;
    const real = rpcFromProvider(s.provider);
    const rpc: Rpc = { ...real, getCode: async (a) => (failing-- > 0 ? Promise.reject(new Error("the node did not answer the tool")) : real.getCode(a)) };
    const database = redis.watched(ours);
    const flaky: RedisClient = {
      command: async (args) => (broken && String(args[1]).includes(":claim:") ? Promise.reject(new Error("down")) : database.command(args)),
      eval: (script, keys, args) => database.eval(script, keys, args),
    };
    let now = Date.now();
    const metrics = "m".repeat(40);
    const extra = { SLUICE_TOOLS_METRICS_TOKEN: metrics, SLUICE_TOOLS_RATE_LIMIT_UNPAID: "3" };
    const a = await tools(f.url, extra, { client: flaky, rpc, now: () => now });
    const b = await tools(f.url, extra, { client: flaky, rpc, now: () => now });

    // Every path: health, metrics, a price, a paid call, the same one again, two copies at once, a failing tool, a claim that cannot
    // be made, the unpaid limit, bad requests, and a mark written again.
    await fetch(`${a}/health`);
    await fetch(`${a}/internal/metrics`, { headers: { authorization: `Bearer ${metrics}` } });
    await mcp(a);
    const first = { [PAYMENT_META_KEY]: (await lookup()).payload };
    expect((await mcp(a, first)).body.result?.isError).to.not.equal(true);
    expect((await mcp(b, first)).body.result?.isError).to.not.equal(true);
    const raced = { [PAYMENT_META_KEY]: (await lookup()).payload };
    await Promise.all([mcp(a, raced), mcp(b, raced)]);
    failing = 1;
    await paidFor(a);
    broken = true;
    await paidFor(b);
    broken = false;
    for (let i = 0; i < 4; i++) await mcp(a, undefined, { "x-forwarded-for": "7.7.7.7" });
    await mcp(a, { [PAYMENT_META_KEY]: { not: "a payment" } });
    await fetch(`${a}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    now += MARK_EVERY_MS + 1;
    await mcp(a);
    await Promise.all(background);

    expect(ours.size, "the tool server used the database").to.be.greaterThan(8);
    const own = toolsPrefix("local", s.routerAddress);
    expect([...ours].filter((k) => !(k.startsWith(own) || k === TOOLS_MARKER_KEY)), "every key the tool server touched").to.deep.equal([]);
    for (const kind of ["entry:", "claim:", "rate:ip:", "rate:unpaid:"]) expect([...ours].some((k) => k.startsWith(own + kind)), kind).to.equal(true);
    expect(theirs.size).to.be.greaterThan(10);
    const theirPrefix = redisPrefix("local", s.routerAddress);
    expect([...theirs].filter((k) => !k.startsWith(theirPrefix)), "every key the facilitator touched, having accepted the sharing").to.deep.equal([]);
    expect(await redis.command(["GET", killKey()]), "the switch is as it was").to.equal("0");
    expect(await settledEvents(), "and the paid calls were paid").to.be.at.least(2);
  });

  it("refuses to start on a database a tool server also uses, unless that is accepted in those words", async () => {
    await tools("http://127.0.0.1:1");
    expect(await redis.command(["GET", TOOLS_MARKER_KEY])).to.equal(TOOLS_MARKER_VALUE);
    const before = redis.log.length;
    const none = await rejection(facilitator());
    expect(none).to.be.instanceOf(EnvError);
    expect(none.message).to.contain("also used by a tool server").and.contain(`SLUICE_FACILITATOR_SHARED_DATABASE=${SHARED_DATABASE_ACCEPTED}`);
    expect(redis.log.slice(before), "it looked, and did nothing else").to.deep.equal(["EXISTS"]);
    for (const wrong of ["1", "true", "yes", "on", "accept", "ONE-TOKEN-FOR-BOTH-SERVICES", `${SHARED_DATABASE_ACCEPTED}!`]) {
      const err = await rejection(facilitator({ SLUICE_FACILITATOR_SHARED_DATABASE: wrong }));
      expect(err.message, wrong).to.contain("either left out or exactly");
    }
    const f = await facilitator(accepting);
    expect(await f.app.facilitator.settle(verifyBody(await lookup()))).to.include({ success: true });
    expect(await f.app.facilitator.flush()).to.include({ settled: 1 });
    expect(lines.join("\n")).to.contain("whatever holds its token can change everything");
  });

  it("refuses a marked database in a ledger that is told nothing about sharing", async () => {
    const prefix = redisPrefix("local", s.routerAddress);
    const untold = [new RedisLedger(redis, prefix), new RedisLedger(redis, prefix, {}), new RedisLedger(redis, prefix, { acceptShared: false })];
    for (const ledger of untold) expect(await ledger.health()).to.deep.equal({ ok: true });
    await redis.command(["SET", TOOLS_MARKER_KEY, TOOLS_MARKER_VALUE]);
    for (const ledger of untold) expect(await ledger.health()).to.deep.equal({ ok: false, problem: SHARED_DATABASE_PROBLEM });
    expect(await new RedisLedger(redis, prefix, { acceptShared: true }).health()).to.deep.equal({ ok: true });
  });

  it("starts on a database of its own without being told anything, and refuses when it cannot tell", async () => {
    const f = await facilitator();
    expect(await f.app.facilitator.settle(verifyBody(await lookup()))).to.include({ success: true });
    redis.down = true;
    const unknown = await rejection(facilitator());
    expect(unknown).to.be.instanceOf(EnvError);
    expect(unknown.message).to.contain("could not be read");
  });

  it("accepts and sends nothing from the moment a tool server starts on its database, until the sharing is accepted", async () => {
    const f = await facilitator({}, { waitUntil: () => undefined });
    const queued = await lookup();
    const other = (await f.app.ledger.lock("relayer", 600_000))!;
    expect(await f.app.facilitator.settle(verifyBody(queued))).to.include({ success: true });
    await other.release();
    await tools(f.url); // a tool server starts, on the same database
    expect(await f.app.facilitator.settle(verifyBody(await lookup()))).to.include({ success: false, errorReason: ERRORS.storeUnavailable });
    expect(await f.app.facilitator.hold(verifyBody(await lookup()))).to.include({ success: false, errorReason: ERRORS.storeUnavailable });
    expect((await f.app.facilitator.verify(verifyBody(await lookup()))).invalidReason).to.equal(ERRORS.storeUnavailable);
    expect((await f.app.facilitator.flush()).held).to.equal(ERRORS.storeUnavailable);
    expect((await f.app.facilitator.relay({ kind: "revoke" })).error).to.equal(ERRORS.storeUnavailable);
    const health = await fetch(`${f.url}/health`);
    expect(health.status).to.equal(503);
    expect(((await health.json()) as { store: { problem: string } }).store.problem).to.equal(SHARED_DATABASE_PROBLEM);
    expect(await settledEvents()).to.equal(0);
    const told = await facilitator(accepting);
    expect(await told.app.facilitator.flush()).to.include({ settled: 1 });
  });

  it("is marked by a tool server before it serves anything, and marked again if the database was emptied", async () => {
    let now = 1_000_000;
    const written: string[] = [];
    const client: RedisClient = { command: async (args) => (written.push(args.slice(0, 2).join(" ")), redis.command(args)), eval: (a, b, c) => redis.eval(a, b, c) };
    const url = await tools("http://127.0.0.1:1", {}, { client, now: () => now });
    expect(written[0]).to.equal(`SET ${TOOLS_MARKER_KEY}`);
    await mcp(url);
    expect(written.filter((w) => w.includes(TOOLS_MARKER_KEY))).to.have.length(1);
    await redis.command(["DEL", TOOLS_MARKER_KEY]);
    now += MARK_EVERY_MS - 1;
    await mcp(url);
    expect(await redis.command(["GET", TOOLS_MARKER_KEY])).to.equal(null);
    now += 1;
    await mcp(url);
    expect(await redis.command(["GET", TOOLS_MARKER_KEY])).to.equal(TOOLS_MARKER_VALUE);
    redis.down = true;
    now += MARK_EVERY_MS;
    expect((await mcp(url)).status).to.equal(503);
    const unmarked = await rejection(createServerlessTools({ env: { ...common(), SLUICE_PAYEE: builder, SLUICE_FACILITATOR_URL: "http://127.0.0.1:1" }, client: redis }));
    expect(unmarked).to.be.instanceOf(ToolServerEnvError);
    expect(unmarked.message).to.contain("could not be marked");
  });

  it("stops at the switch in the settings whatever the database says, and when it says nothing", async () => {
    const f = await facilitator({ ...accepting, SLUICE_FACILITATOR_KILL_SWITCH: "1" });
    const everything = async (why: string) => {
      const m = await lookup();
      expect((await f.app.facilitator.settle(verifyBody(m))).errorReason, why).to.equal(ERRORS.killSwitch);
      expect((await f.app.facilitator.hold(verifyBody(m))).errorReason, why).to.equal(ERRORS.killSwitch);
      expect((await f.app.facilitator.verify(verifyBody(m))).invalidReason, why).to.equal(ERRORS.killSwitch);
      expect((await f.app.facilitator.flush()).held, why).to.equal(ERRORS.killSwitch);
      expect((await f.app.facilitator.relay({ kind: "revoke" })).error, why).to.equal(ERRORS.killSwitch);
      expect((await f.app.facilitator.onboard({})).error, why).to.equal(ERRORS.killSwitch);
      expect(await f.app.facilitator.maySend(), why).to.equal(false);
      expect(((await f.app.facilitator.relayer.sendTopUp(throwawayWallet().address, 1_000n).catch((e: { code: string }) => e)) as { code: string }).code, why).to.not.equal(undefined);
    };
    await redis.command(["SET", killKey(), "0"]); // someone with the token turns the stored switch off
    await everything("the stored switch says off");
    await redis.command(["DEL", killKey()]);
    await everything("the stored switch is gone");
    redis.down = true;
    await everything("the database cannot be reached");
    expect(await settledEvents()).to.equal(0);
    expect(await s.provider.getTransactionCount(relayer.address)).to.equal(0);
  });

  it("refuses a caller past its limit in the tool server's own memory, so a flood from one place stops costing requests", async () => {
    const url = await tools("http://127.0.0.1:1", { SLUICE_TOOLS_RATE_LIMIT_UNPAID: "3", SLUICE_TOOLS_RATE_LIMIT_IP: "5" });
    const from = { "x-forwarded-for": "9.9.9.9" };
    for (let i = 0; i < 3; i++) expect((await mcp(url, undefined, from)).status).to.equal(200);
    expect((await mcp(url, undefined, from)).status).to.equal(429);
    expect((await mcp(url, undefined, from)).status).to.equal(429);
    const before = redis.log.length;
    for (let i = 0; i < 20; i++) expect((await mcp(url, undefined, from)).status).to.equal(429);
    expect(redis.log.length - before, "refused without asking the database").to.equal(0);
    expect((await mcp(url, undefined, { "x-forwarded-for": "8.8.8.8" })).status).to.equal(200);
  });
});
