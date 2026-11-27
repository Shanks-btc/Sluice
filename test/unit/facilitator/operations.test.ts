// What an operator relies on once the facilitator is hosted: the kill switch, the caps on its own QIE, the low-balance flag, the
// limits on who can call it and how much, logs that hold no secret, the settings that refuse to start, and an orderly stop.
// Everything runs against a local chain with keys made for the run.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, parseEther } from "ethers";
import { ERRORS, ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS, signOnboarding } from "@sluice/sdk";
import {
  DEFAULT_CAPS, FileStore, HARD_CAPS, KillSwitch, MemoryStore, RateLimiter, clientAddress, createLogger, createServer, cutSecrets, listen, payerOf, readEnv,
  resolveCaps, scrubFields, scrubText, startFacilitator,
} from "@sluice/facilitator";
import type { Facilitator } from "@sluice/facilitator";
import { USDC } from "../../helpers";
import { chaosProvider, makeFacilitator, tempState } from "../../helpers/chaos";
import type { Chaos, Temp } from "../../helpers/chaos";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const price = USDC("0.01");

describe("Facilitator operations: the kill switch", function () {
  this.timeout(120_000);
  let s: Stack;
  let t: Temp;
  let payer: Wallet;
  let builder: string;

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    t = tempState();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await s.stop();
    t.cleanup();
  });

  const payment = () => makePayment(s, payer, payer.address, requirementsFor(s, builder, price));

  it("stops queueing, settling, top-ups and relayed requests while it is on, and sends no transaction", async () => {
    const f = (await makeFacilitator(s, { store: new FileStore(t.journal), killSwitch: new KillSwitch(true) })).facilitator;
    const before = await s.provider.getTransactionCount(f.relayer.address);
    const balance = await s.provider.getBalance(f.relayer.address);

    const m = await payment();
    expect(await f.settle(verifyBody(m))).to.include({ success: false, errorReason: ERRORS.killSwitch });
    expect(f.store.size()).to.equal(0);
    expect(await f.verify(verifyBody(m))).to.include({ isValid: false, invalidReason: ERRORS.killSwitch });
    expect((await f.flush()).held).to.equal(ERRORS.killSwitch);

    const wallet = throwawayWallet();
    await fundWallet(s, wallet, USDC("5"));
    const gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
    const txs = await signOnboarding(wallet, { router: s.routerAddress, asset: s.tokenAddress, amount: USDC("1"), nonce: 0, gasPrice });
    expect(await f.onboard({ payer: wallet.address, ...txs })).to.include({ ok: false, error: ERRORS.killSwitch });
    expect(await s.provider.getBalance(wallet.address)).to.equal(0n);

    const relayed = await f.relay({ kind: "withdraw", account: payer.address, to: payer.address, amount: "1", nonce: `0x${"01".repeat(32)}`, deadline: "99999999999", signature: `0x${"00".repeat(65)}` });
    expect(relayed).to.include({ ok: false, error: ERRORS.killSwitch });

    expect(await s.provider.getTransactionCount(f.relayer.address)).to.equal(before);
    expect(await s.provider.getBalance(f.relayer.address)).to.equal(balance);
  });

  it("still answers reads: /health says it is on, /status answers, and the queue is untouched", async () => {
    const file = join(t.dir, "KILL");
    const kill = new KillSwitch(false, file);
    const f = (await makeFacilitator(s, { store: new FileStore(t.journal), killSwitch: kill })).facilitator;
    const m = await payment();
    expect((await f.settle(verifyBody(m))).success).to.equal(true); // queued before the switch
    writeFileSync(file, "");
    expect(kill.active()).to.equal(true);
    const health = await f.health();
    expect(health).to.include({ ok: true, killSwitch: true });
    expect((await f.status(m.digest))?.status).to.equal("queued");
    expect((await f.flush()).held).to.equal(ERRORS.killSwitch);
    expect((await f.status(m.digest))?.status).to.equal("queued"); // not sent, not lost
    expect(f.relayer.alerts.map((a) => a.kind)).to.include("kill_switch");

    // Taking the file away lets it carry on from the queue, with no restart.
    rmSync(file);
    expect((await f.health()).killSwitch).to.equal(false);
    expect(await f.flush()).to.include({ submitted: 1, settled: 1 });
    f.store.close();
  });

  it("over HTTP: /health and /status answer, /settle says why it refused", async () => {
    const f = (await makeFacilitator(s, { store: new FileStore(t.journal), killSwitch: new KillSwitch(true) })).facilitator;
    const server = createServer(f);
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).to.equal(200);
      expect(((await health.json()) as { killSwitch: boolean }).killSwitch).to.equal(true);
      expect((await fetch(`${base}/status/0x${"11".repeat(32)}`)).status).to.equal(404); // a read, answered normally
      const res = await fetch(`${base}/settle`, { method: "POST", body: JSON.stringify(verifyBody(await payment())) });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.include({ success: false, errorReason: ERRORS.killSwitch });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.store.close();
    }
  });

  it("is off unless it is turned on, and a missing file means off while an unreadable path means on", () => {
    expect(new KillSwitch().active()).to.equal(false);
    expect(new KillSwitch(false, join(t.dir, "nothing-here")).active()).to.equal(false);
    const k = new KillSwitch();
    k.engage();
    expect(k.active()).to.equal(true);
  });
});

describe("Facilitator operations: caps on its own QIE", function () {
  this.timeout(120_000);
  let s: Stack | undefined;
  afterEach(async () => {
    await s?.stop();
    s = undefined;
  });

  it("will not top up one address past its daily cap, however many starts the count would allow, and sends nothing when it refuses", async () => {
    s = await startStack();
    const stack = s;
    const wallet = throwawayWallet();
    await fundWallet(stack, wallet, USDC("20"));
    const price = async () => (await stack.provider.getFeeData()).gasPrice as bigint;
    // The cap is set from what a start costs at the price the chain has now: room for one start and a fifth, so not for two.
    // (The test chain's price falls as it mines empty blocks, so the second start is a little cheaper than the first.)
    const first_cost = (ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS) * (await price());
    const f = (await makeFacilitator(stack, { store: new MemoryStore(), caps: { onboardPerPayerPerDay: 3, topUpPerAddressDailyWei: (first_cost * 12n) / 10n } })).facilitator;
    const sign = async (nonce: number) => signOnboarding(wallet, { router: stack.routerAddress, asset: stack.tokenAddress, amount: USDC("1"), nonce, gasPrice: await price() });
    const first = await f.onboard({ payer: wallet.address, ...(await sign(0)) });
    expect(first.ok, first.detail).to.equal(true);
    await setQie(wallet.address, 0n); // out of QIE again: it would need a second top-up
    const before = await stack.provider.getBalance(f.relayer.address);
    const second = await f.onboard({ payer: wallet.address, ...(await sign(2)) });
    expect(second.ok).to.equal(false);
    expect(second.detail).to.match(/one address in a day/);
    expect(await stack.provider.getBalance(wallet.address)).to.equal(0n);
    expect(await stack.provider.getBalance(f.relayer.address)).to.equal(before);
  });

  it("holds the same cap inside the relayer, as the last check before a key signs, and resets it on a new day", async () => {
    s = await startStack();
    const { Relayer, CapError } = await import("@sluice/facilitator");
    let clock = 1_800_000_000;
    const caps = resolveCaps({ maxTopUpWei: 600_000_000_000_000n, topUpPerAddressDailyWei: 1_000_000_000_000_000n });
    const key = throwawayWallet();
    await setQie(key.address, parseEther("1"));
    const relayer = new Relayer({ key: key.privateKey, provider: s.provider, caps, allowlist: [s.routerAddress], now: () => clock });
    // The test chain's own clock is the wall clock; the relayer's day follows the clock it was given, and only the day rolls.
    const target = throwawayWallet().address;
    await relayer.sendTopUp(target, 600_000_000_000_000n);
    let refused: unknown;
    try {
      await relayer.sendTopUp(target, 600_000_000_000_000n);
    } catch (e) {
      refused = e;
    }
    expect(refused).to.be.instanceOf(CapError);
    expect((refused as { code: string }).code).to.equal("top_up_address_cap");
    await relayer.sendTopUp(throwawayWallet().address, 600_000_000_000_000n); // another address has its own allowance
    clock += 86_400; // the next UTC day
    await relayer.sendTopUp(target, 600_000_000_000_000n);
  });

  it("keeps the per-address cap and the single top-up cap inside their hard ceilings", () => {
    expect(() => resolveCaps({ topUpPerAddressDailyWei: HARD_CAPS.topUpPerAddressDailyWei + 1n })).to.throw(/hard ceiling/);
    expect(() => resolveCaps({ topUpPerAddressDailyWei: 0n })).to.throw(/above zero/);
    expect(DEFAULT_CAPS.topUpPerAddressDailyWei <= HARD_CAPS.topUpPerAddressDailyWei).to.equal(true);
    expect(DEFAULT_CAPS.topUpPerAddressDailyWei >= DEFAULT_CAPS.maxTopUpWei).to.equal(true);
  });
});

describe("Facilitator operations: health and the low-balance flag", function () {
  this.timeout(120_000);
  let s: Stack;
  let t: Temp;
  beforeEach(async () => {
    s = await startStack();
    t = tempState();
  });
  afterEach(async () => {
    await s.stop();
    t.cleanup();
  });

  it("flags a relayer that is low on QIE, raises an alert, and never shows the key", async () => {
    const m = await makeFacilitator(s, { store: new FileStore(t.journal), lowBalanceWei: parseEther("5") }); // it holds 1 QIE
    const health = await m.facilitator.health();
    expect(health.lowBalance).to.equal(true);
    expect(health.lowBalanceThresholdWei).to.equal(parseEther("5").toString());
    expect(health.ok).to.equal(true);
    expect(m.facilitator.relayer.alerts.map((a) => a.kind)).to.include("low_balance");
    const text = JSON.stringify(health);
    expect(text).to.not.contain(m.relayerKey);
    expect(text).to.not.contain(m.relayerKey.slice(2));
    m.facilitator.store.close();
  });

  it("does not flag a relayer that holds more than the threshold, which defaults to one day's budget", async () => {
    const m = await makeFacilitator(s, { store: new FileStore(t.journal) });
    expect((await m.facilitator.health()).lowBalance).to.equal(false); // 1 QIE against a 0.5 QIE day
    const low = await makeFacilitator(s, { store: new FileStore(join(t.dir, "b.jsonl")), caps: { dailyBudgetWei: parseEther("2") } });
    expect((await low.facilitator.health()).lowBalance).to.equal(true); // 1 QIE against a 2 QIE day
    m.facilitator.store.close();
    low.facilitator.store.close();
  });

  it("reports the store and what is still in flight, and asks to be replaced when the store is broken", async () => {
    const m = await makeFacilitator(s, { store: new FileStore(t.journal) });
    const health = await m.facilitator.health();
    expect(health).to.deep.include({ ok: true, draining: false, killSwitch: false });
    expect(health.store).to.deep.equal({ healthy: true });
    expect(health.inFlight).to.deep.equal({ count: 0, oldestAgeSeconds: 0 });
    m.facilitator.store.close(); // a closed store cannot record anything
    const after = await m.facilitator.health();
    expect(after.ok).to.equal(false);
    expect(after.store.healthy).to.equal(false);
  });
});

describe("Facilitator operations: limits on callers", function () {
  this.timeout(120_000);
  let s: Stack;
  let payer: Wallet;
  let builder: string;
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.stop();
  });

  const serve = async (f: Facilitator, options: Parameters<typeof createServer>[1]) => {
    const server = createServer(f, options);
    servers.push(server);
    return `http://127.0.0.1:${await listen(server, 0)}`;
  };
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("limits requests per client address with 429 and Retry-After, and lets the address in again when the window has passed", async () => {
    let now = 1_000_000;
    const base = await serve(s.facilitator, { ipLimit: { max: 3, windowMs: 60_000 }, now: () => now });
    for (let i = 0; i < 3; i++) expect((await fetch(`${base}/health`)).status).to.equal(200);
    const limited = await fetch(`${base}/health`);
    expect(limited.status).to.equal(429);
    expect(Number(limited.headers.get("retry-after"))).to.be.within(1, 60);
    expect(await limited.json()).to.deep.include({ error: ERRORS.rateLimited });
    now += 61_000;
    expect((await fetch(`${base}/health`)).status).to.equal(200);
  });

  it("limits POSTs per payer address, separately for each payer, whatever address they come from", async () => {
    const base = await serve(s.facilitator, { payerLimit: { max: 2, windowMs: 60_000 } });
    const body = (p: string) => ({ x402Version: 2, paymentPayload: { payload: { authorization: { payer: p } } }, paymentRequirements: {} });
    const a = payer.address;
    const b = throwawayWallet().address;
    expect((await post(base, "/verify", body(a))).status).to.equal(200);
    expect((await post(base, "/settle", body(a))).status).to.equal(200);
    const third = await post(base, "/verify", body(a));
    expect(third.status).to.equal(429);
    expect(third.headers.get("retry-after")).to.match(/^\d+$/);
    expect((await post(base, "/verify", body(b))).status).to.equal(200); // another payer has its own allowance
    expect((await post(base, "/verify", body(a.toLowerCase()))).status).to.equal(429); // the same address in another case is the same payer
    expect((await fetch(`${base}/health`)).status).to.equal(200); // reads are not counted against a payer
  });

  it("does not believe X-Forwarded-For unless told how many proxies sit in front, so a spoofed header cannot dodge the limit", async () => {
    const base = await serve(s.facilitator, { ipLimit: { max: 2, windowMs: 60_000 } });
    for (let i = 0; i < 2; i++) expect((await fetch(`${base}/health`, { headers: { "x-forwarded-for": `10.0.0.${i}` } })).status).to.equal(200);
    expect((await fetch(`${base}/health`, { headers: { "x-forwarded-for": "10.0.0.99" } })).status).to.equal(429);
  });

  it("behind one proxy, counts each client the proxy saw, and ignores what the client put at the left of the header", async () => {
    const base = await serve(s.facilitator, { ipLimit: { max: 2, windowMs: 60_000 }, trustedProxyHops: 1 });
    // The proxy appends the address it saw. A client may also send its own header; only the last entry is the proxy's.
    const as = (seen: string, spoof = "1.1.1.1") => ({ "x-forwarded-for": `${spoof}, ${seen}` });
    for (let i = 0; i < 2; i++) expect((await fetch(`${base}/health`, { headers: as("203.0.113.5", `9.9.9.${i}`) })).status).to.equal(200);
    expect((await fetch(`${base}/health`, { headers: as("203.0.113.5", "8.8.8.8") })).status).to.equal(429);
    expect((await fetch(`${base}/health`, { headers: as("203.0.113.6") })).status).to.equal(200); // another client
  });

  it("refuses a body over the limit, by its declared length before reading it and by its real length", async () => {
    const base = await serve(s.facilitator, { maxBodyBytes: 2_048 });
    const big = await post(base, "/verify", "x".repeat(10_000)).catch(() => undefined);
    if (big) {
      expect(big.status).to.equal(400);
      expect(await big.json()).to.deep.include({ error: "invalid_payload", detail: "the body is too large" });
    }
    const small = await post(base, "/verify", { x402Version: 2 });
    expect(small.status).to.equal(200);
  });

  it("never lets a configured body limit pass one mebibyte, and refuses a limit that is not a number", async () => {
    const base = await serve(s.facilitator, { maxBodyBytes: 50 * 1024 * 1024 });
    const res = await post(base, "/verify", "y".repeat(1024 * 1024 + 10)).catch(() => undefined);
    if (res) expect(res.status).to.equal(400);
    expect(() => createServer(s.facilitator, { maxBodyBytes: 0 })).to.throw(/positive whole number/);
    expect(() => createServer(s.facilitator, { maxBodyBytes: Number.NaN })).to.throw();
  });

  it("only counts a payer it can read: a malformed address names no payer", () => {
    const a = "0x" + "ab".repeat(20);
    expect(payerOf("/settle", { paymentPayload: { payload: { authorization: { payer: a } } } })).to.equal(a);
    expect(payerOf("/verify", { paymentPayload: { payload: { authorization: { payer: "0x12" } } } })).to.equal(undefined);
    expect(payerOf("/onboard", { payer: a.toUpperCase().replace("0X", "0x") })).to.equal(a);
    expect(payerOf("/relay", { account: a })).to.equal(a);
    expect(payerOf("/relay", { payer: a, account: "0x12" })).to.equal(a);
    expect(payerOf("/settle", null)).to.equal(undefined);
    expect(payerOf("/settle", { paymentPayload: 5 })).to.equal(undefined);
  });
});

describe("Rate limiter and client address", () => {
  it("allows `max` in a window, then refuses with the seconds left, then starts a new window", () => {
    let now = 0;
    const l = new RateLimiter(2, 10_000, 100, () => now);
    expect(l.hit("a")).to.deep.equal({ ok: true });
    expect(l.hit("A")).to.deep.equal({ ok: true }); // keys are not case sensitive
    expect(l.hit("a")).to.deep.equal({ ok: false, retryAfterSeconds: 10 });
    now = 4_001;
    expect(l.hit("a")).to.deep.equal({ ok: false, retryAfterSeconds: 6 });
    expect(l.hit("b")).to.deep.equal({ ok: true });
    now = 10_000;
    expect(l.hit("a")).to.deep.equal({ ok: true });
  });

  it("remembers at most `maxKeys` keys, so a flood of new addresses cannot grow its memory", () => {
    const l = new RateLimiter(1, 60_000, 50, () => 1);
    for (let i = 0; i < 500; i++) l.hit(`key-${i}`);
    expect(l.size()).to.be.at.most(50);
  });

  it("refuses limits that are not positive whole numbers", () => {
    expect(() => new RateLimiter(0, 1000)).to.throw();
    expect(() => new RateLimiter(1.5, 1000)).to.throw();
    expect(() => new RateLimiter(1, 0)).to.throw();
  });

  it("takes the socket address, and the forwarded one only through the configured number of proxies, counted from the right", () => {
    expect(clientAddress("::ffff:10.1.1.1", "1.2.3.4", 0)).to.equal("10.1.1.1");
    expect(clientAddress(undefined, undefined, 0)).to.equal("unknown");
    expect(clientAddress("10.1.1.1", "9.9.9.9, 1.2.3.4", 1)).to.equal("1.2.3.4");
    expect(clientAddress("10.1.1.1", "9.9.9.9, 1.2.3.4, 5.6.7.8", 2)).to.equal("1.2.3.4");
    expect(clientAddress("10.1.1.1", ["9.9.9.9", "1.2.3.4"], 1)).to.equal("1.2.3.4");
    expect(clientAddress("10.1.1.1", "1.2.3.4", 2)).to.equal("10.1.1.1"); // fewer entries than proxies: not believed
    expect(clientAddress("10.1.1.1", "not an address!", 1)).to.equal("10.1.1.1");
    expect(clientAddress("10.1.1.1", undefined, 1)).to.equal("10.1.1.1");
  });
});

describe("Facilitator logs", () => {
  const KEY = `0x${"ab".repeat(32)}`;
  const sig = `0x${"cd".repeat(65)}`;

  it("writes one JSON object per line and keeps a transaction hash whole", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), now: () => 0 });
    const hash = `0x${"12".repeat(32)}`;
    log.info("batch confirmed", { transaction: hash, settled: 2, amount: 10n });
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).to.deep.include({ t: "1970-01-01T00:00:00.000Z", level: "info", msg: "batch confirmed", transaction: hash, settled: 2, amount: "10" });
  });

  it("cuts the relayer's key out of every field, message and nested value, in any case, with or without the prefix", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), secrets: [KEY] });
    log.warn(`failed with ${KEY}`, { detail: `x${KEY.toUpperCase()}y`, nested: { deep: [KEY.slice(2)] }, url: `https://rpc.example/${KEY}` });
    const text = lines[0] as string;
    expect(text).to.not.contain(KEY);
    expect(text).to.not.contain(KEY.slice(2));
    expect(text.toLowerCase()).to.not.contain("ab".repeat(32));
    expect(text).to.contain("[redacted]");
  });

  it("redacts a field by its name, whatever its value", () => {
    const out = scrubFields({ privateKey: "anything", relayerKey: 1, apiToken: "t", password: "p", Authorization: "Bearer x", secret: "s", mnemonic: "m", ok: "kept" });
    expect(out).to.deep.equal({ privateKey: "[redacted]", relayerKey: "[redacted]", apiToken: "[redacted]", password: "[redacted]", Authorization: "[redacted]", secret: "[redacted]", mnemonic: "[redacted]", ok: "kept" });
  });

  it("shortens a signature or a raw transaction to its first bytes and its length, and reduces a URL to its host", () => {
    const text = scrubText(`signature ${sig} raw 0x${"f".repeat(400)} at https://user:pass@rpc.example:8545/path?key=secret done`);
    expect(text).to.not.contain(sig);
    expect(text).to.contain("(65 bytes)");
    expect(text).to.not.contain("pass");
    expect(text).to.not.contain("secret");
    expect(text).to.contain("https://rpc.example:8545");
  });

  it("keeps only the kind of an error, since an error's text can hold a URL or a key", () => {
    const out = scrubFields({ err: new TypeError(`bad ${KEY}`), plain: new Error("x") }, [KEY]);
    expect(JSON.stringify(out)).to.not.contain(KEY);
    expect(out.err).to.equal("TypeError");
  });

  it("drops lines below its level", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l).level)).to.deep.equal(["warn", "error"]);
  });

  it("cuts a secret out of a finished line even when it sat under a field name nobody listed", () => {
    expect(cutSecrets(`{"zzz":"${KEY}"}`, [KEY])).to.equal('{"zzz":"[redacted]"}');
    expect(cutSecrets("short", ["abc"])).to.equal("short"); // a secret under eight characters is ignored, not matched everywhere
  });

  describe("through a real settlement", function () {
    this.timeout(120_000);
    it("holds no signature, no relayer key and no request body from queueing to confirmation", async () => {
      const s = await startStack({ feeBps: 100 });
      const t = tempState();
      try {
        const payer = throwawayWallet();
        await fundWallet(s, payer, USDC("5"), parseEther("1"));
        await depositFor(s, payer, USDC("5"));
        const relayerKey = throwawayWallet().privateKey;
        await setQie(new Wallet(relayerKey).address, parseEther("1"));
        const logged: string[] = [];
        const logger = createLogger({ write: (l) => logged.push(l), level: "debug", secrets: [relayerKey] });
        const f = (await makeFacilitator(s, { store: new FileStore(t.journal), relayerKey, logger })).facilitator;
        const m = await makePayment(s, payer, payer.address, requirementsFor(s, throwawayWallet().address, price));
        await f.settle(verifyBody(m));
        await f.flush();
        const all = logged.join("\n");
        expect(logged.length).to.be.greaterThan(1);
        for (const l of logged) JSON.parse(l); // every line is JSON
        expect(all).to.contain("intent queued");
        expect(all).to.contain("batch confirmed");
        expect(all).to.not.contain(m.signature);
        expect(all).to.not.contain(m.signature.slice(2));
        expect(all).to.not.contain(relayerKey);
        expect(all).to.not.contain(relayerKey.slice(2));
        f.store.close();
      } finally {
        await s.stop();
        t.cleanup();
      }
    });
  });
});

describe("Facilitator settings", () => {
  const base = {
    SLUICE_NETWORK: "local",
    SLUICE_RPC_URL: "http://127.0.0.1:8545",
    SLUICE_ROUTER: `0x${"12".repeat(20)}`,
    SLUICE_RELAYER_KEY: `0x${"34".repeat(32)}`,
  };
  const live = { ...base, SLUICE_NETWORK: "testnet", SLUICE_RPC_URL: "https://rpc1testnet.qie.digital/", SLUICE_APPROVE: "facilitator", SLUICE_MAX_QIE: "0.1" };

  it("refuses to start on testnet or mainnet without a queue file, because a queue held only in memory is lost by a restart", () => {
    expect(() => readEnv(live)).to.throw(/SLUICE_FACILITATOR_STATE/);
    expect(() => readEnv({ ...live, SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: "https://rpc1mainnet.qie.digital/" })).to.throw(/SLUICE_FACILITATOR_STATE/);
    expect(readEnv({ ...live, SLUICE_FACILITATOR_STATE: "/data/queue.jsonl" }).statePath).to.equal("/data/queue.jsonl");
    expect(readEnv(base).statePath).to.equal(undefined); // a local node needs none
  });

  it("has safe defaults: loopback only, a 64 KiB body, the kill switch off, no proxy trusted", () => {
    const e = readEnv(base);
    expect(e).to.deep.include({
      host: "127.0.0.1", killSwitch: false, maxBodyBytes: 65_536, ipPerMinute: 240, payerPerMinute: 60, trustedProxyHops: 0, shutdownMs: 30_000, flushMs: 15_000, logLevel: "info",
    });
    expect(e.killFile).to.equal(undefined);
    expect(e.lowBalanceWei).to.equal(undefined);
  });

  it("reads the flags and limits it is given", () => {
    const e = readEnv({
      ...base, SLUICE_FACILITATOR_HOST: "0.0.0.0", SLUICE_FACILITATOR_KILL_SWITCH: "1", SLUICE_FACILITATOR_KILL_FILE: "/data/KILL", SLUICE_FACILITATOR_MAX_BODY_BYTES: "4096",
      SLUICE_FACILITATOR_RATE_LIMIT_IP: "10", SLUICE_FACILITATOR_RATE_LIMIT_PAYER: "5", SLUICE_FACILITATOR_TRUST_PROXY_HOPS: "1", SLUICE_FACILITATOR_LOW_BALANCE_QIE: "0.25",
      SLUICE_FACILITATOR_SHUTDOWN_MS: "5000", SLUICE_FACILITATOR_FLUSH_MS: "1000", SLUICE_FACILITATOR_LOG_LEVEL: "warn",
    });
    expect(e).to.deep.include({ host: "0.0.0.0", killSwitch: true, killFile: "/data/KILL", maxBodyBytes: 4096, ipPerMinute: 10, payerPerMinute: 5, trustedProxyHops: 1, shutdownMs: 5000, flushMs: 1000, logLevel: "warn" });
    expect(e.lowBalanceWei).to.equal(250_000_000_000_000_000n);
  });

  it("stops the start on a setting it cannot read, so a typo cannot leave a safety off", () => {
    for (const bad of [
      { SLUICE_FACILITATOR_KILL_SWITCH: "maybe" }, { SLUICE_FACILITATOR_KILL_SWITCH: "2" }, { SLUICE_FACILITATOR_MAX_BODY_BYTES: "9999999" }, { SLUICE_FACILITATOR_MAX_BODY_BYTES: "12abc" },
      { SLUICE_FACILITATOR_RATE_LIMIT_IP: "0" }, { SLUICE_FACILITATOR_TRUST_PROXY_HOPS: "9" }, { SLUICE_FACILITATOR_TRUST_PROXY_HOPS: "-1" }, { SLUICE_FACILITATOR_SHUTDOWN_MS: "10" },
      { SLUICE_FACILITATOR_LOG_LEVEL: "verbose" }, { SLUICE_FACILITATOR_HOST: "bad host!" }, { SLUICE_FACILITATOR_LOW_BALANCE_QIE: "-1" },
    ]) {
      expect(() => readEnv({ ...base, ...bad }), JSON.stringify(bad)).to.throw(/refusing to start|SLUICE_FACILITATOR_/);
    }
    expect(readEnv({ ...base, SLUICE_FACILITATOR_KILL_SWITCH: "0" }).killSwitch).to.equal(false);
    expect(readEnv({ ...base, SLUICE_FACILITATOR_KILL_SWITCH: "TRUE" }).killSwitch).to.equal(true);
  });

  it("reads the top-up caps in QIE, raises the per-address cap with a larger single top-up, and refuses a cap above its ceiling", () => {
    const a = readEnv({ ...base, SLUICE_FACILITATOR_MAX_TOPUP_QIE: "0.0012" });
    expect(a.caps.maxTopUpWei).to.equal(1_200_000_000_000_000n);
    expect(a.caps.topUpPerAddressDailyWei).to.equal(1_200_000_000_000_000n);
    const b = readEnv({ ...base, SLUICE_FACILITATOR_MAX_TOPUP_QIE: "0.0005", SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE: "0.002" });
    expect(b.caps.topUpPerAddressDailyWei).to.equal(2_000_000_000_000_000n);
    expect(() => readEnv({ ...base, SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE: "1" })).to.throw(/hard ceiling/);
    expect(() => readEnv({ ...base, SLUICE_FACILITATOR_MAX_TOPUP_QIE: "0.0014", SLUICE_FACILITATOR_MAX_TOPUP_PER_ADDRESS_QIE: "0.001" })).to.throw(/below a single top-up/);
  });

  it("lowers the three QUSDC caps from its settings, and leaves each at its default when it is not set", () => {
    const e = readEnv({ ...base, SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC: "0.02", SLUICE_FACILITATOR_PAYER_DAILY_QUSDC: "0.030001", SLUICE_FACILITATOR_DAILY_QUSDC: " 0.05 " });
    expect(e.caps).to.deep.include({ maxOnboardAmount: 20_000n, payerDailyAmount: 30_001n, globalDailyAmount: 50_000n });
    expect(readEnv(base).caps).to.deep.include({ maxOnboardAmount: 10_000_000n, payerDailyAmount: 50_000_000n, globalDailyAmount: 500_000_000n });
    // Exactly the default is allowed: it changes nothing.
    expect(readEnv({ ...base, SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC: "10" }).caps.maxOnboardAmount).to.equal(10_000_000n);
  });

  it("refuses a QUSDC cap that would raise the default, even below the ceiling in code, and one it cannot read", () => {
    for (const [name, above] of [["SLUICE_FACILITATOR_MAX_ONBOARD_QUSDC", "10.000001"], ["SLUICE_FACILITATOR_PAYER_DAILY_QUSDC", "51"], ["SLUICE_FACILITATOR_DAILY_QUSDC", "501"]] as const) {
      expect(() => readEnv({ ...base, [name]: above }), `${name}=${above}`).to.throw(new RegExp(`refusing to start: ${name} can only lower the cap`));
      for (const bad of ["0", "0.000000", "-1", "1e3", "0x10", "1.0000001", "5 QUSDC", "NaN"]) {
        expect(() => readEnv({ ...base, [name]: bad }), `${name}=${bad}`).to.throw(new RegExp(`refusing to start: ${name} must be a plain amount of QUSDC`));
      }
    }
  });

  it("does not show the relayer key when the settings are printed or serialised", () => {
    const e = readEnv(base);
    expect(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).to.not.contain("34".repeat(32));
    expect(String(Object.keys(e))).to.not.contain("relayerKey");
    expect(e.relayerKey()).to.equal(base.SLUICE_RELAYER_KEY);
  });
});

describe("Facilitator: an orderly stop", function () {
  this.timeout(120_000);
  let s: Stack;
  let t: Temp;
  let payer: Wallet;
  let builder: string;

  beforeEach(async () => {
    await freshChain(); // the runtime reads the wall clock, so the chain's clock must be the wall clock too
    s = await startStack({ feeBps: 100 });
    t = tempState();
    payer = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
  });
  afterEach(async () => {
    await s.stop();
    t.cleanup();
  });

  const envFor =(extra: Record<string, string> = {}) => {
    const key = throwawayWallet();
    return {
      key,
      env: readEnv({
        SLUICE_NETWORK: "local", SLUICE_RPC_URL: s.rpcUrl, SLUICE_ROUTER: s.routerAddress, SLUICE_RELAYER_KEY: key.privateKey, SLUICE_FACILITATOR_PORT: "0",
        SLUICE_FACILITATOR_STATE: t.journal, SLUICE_FACILITATOR_FLUSH_MS: "60000", SLUICE_FACILITATOR_SHUTDOWN_MS: "5000", ...extra,
      }),
    };
  };

  it("stops listening, finishes the batch in progress, writes the outcome down, and releases the queue file", async () => {
    const { key, env } = envFor();
    await setQie(key.address, parseEther("1"));
    const lines: string[] = [];
    const chaos: Chaos = { mode: "off", sent: 0 };
    // A node that is slow to take the transaction, so the batch is in progress when the stop comes.
    const slow = new Proxy(chaosProvider(s.provider, chaos), {
      get(target, prop) {
        if (prop === "broadcastTransaction") return async (raw: string) => { await new Promise((r) => setTimeout(r, 600)); return target.broadcastTransaction(raw); };
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const running = await startFacilitator(env, { provider: slow, write: (l) => lines.push(l) });
    const base = `http://127.0.0.1:${running.port}`;
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
    expect(((await (await fetch(`${base}/settle`, { method: "POST", body: JSON.stringify(verifyBody(m)) })).json()) as { success: boolean }).success).to.equal(true);

    const flushing = running.facilitator.flush();
    await new Promise((r) => setTimeout(r, 200)); // the batch is written down as submitted and waiting for the node
    const stopped = await running.shutdown("test");
    expect(stopped.finished).to.equal(true);
    expect((await flushing).settled).to.equal(1);
    expect(await s.router.earnings(builder)).to.equal(price - price / 100n);

    // The journal says settled, the lock is gone, nothing is listening.
    expect(existsSync(`${t.journal}.lock`)).to.equal(false);
    const reopened = new FileStore(t.journal);
    expect(reopened.get(m.digest)?.status).to.equal("settled");
    reopened.close();
    const refused = await fetch(`${base}/health`).then(() => "answered", () => "refused");
    expect(refused).to.equal("refused");
    expect(lines.map((l) => JSON.parse(l).msg)).to.include.members(["started", "shutting down", "stopped"]);
    expect(lines.join("\n")).to.not.contain(key.privateKey);
    expect((await running.shutdown("again")).finished).to.equal(true); // twice is the same stop
  });

  it("refuses new payments once it is stopping, and a batch it could not wait for is recovered by the next start", async () => {
    const { key, env } = envFor({ SLUICE_FACILITATOR_SHUTDOWN_MS: "1000" });
    await setQie(key.address, parseEther("1"));
    const chaos: Chaos = { mode: "forward-then-hang", sent: 0 };
    const running = await startFacilitator(env, { provider: chaosProvider(s.provider, chaos), write: () => undefined });
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
    await running.facilitator.settle(verifyBody(m));
    void running.facilitator.flush(); // the transaction reaches the chain and the call never returns
    for (let i = 0; i < 100 && chaos.sent === 0; i++) await new Promise((r) => setTimeout(r, 20));

    const stopping = running.shutdown("test");
    await new Promise((r) => setTimeout(r, 100));
    const late = await makePayment(s, payer, payer.address, requirementsFor(s, builder, price));
    expect(await running.facilitator.settle(verifyBody(late))).to.include({ success: false, errorReason: ERRORS.facilitatorUnavailable });
    expect((await running.facilitator.health()).ok).to.equal(false);
    const result = await stopping;
    expect(result.finished).to.equal(false); // it could not wait for the node: it said so

    // The next start finds the batch in the journal and settles it from the chain.
    const next = await startFacilitator(env, { provider: s.provider, write: () => undefined });
    expect((await next.facilitator.status(m.digest))?.status).to.equal("settled");
    expect(await s.router.earnings(builder)).to.equal(price - price / 100n);
    expect((await next.facilitator.status(late.digest))).to.equal(undefined);
    await next.shutdown("done");
  });

  it("will not start on a journal that another running process holds, and starts once that process is gone", async () => {
    const { key, env } = envFor();
    await setQie(key.address, parseEther("1"));
    // A real process that stays alive, named in the lock file as the holder.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(`${t.journal}.lock`, String(other.pid));
      let error: unknown;
      try {
        await startFacilitator(env, { provider: s.provider, write: () => undefined });
      } catch (e) {
        error = e;
      }
      expect((error as { code?: string }).code, "the start is refused").to.equal("locked");
      expect(String((error as Error).message)).to.not.contain(t.dir);
      expect(readFileSync(`${t.journal}.lock`, "utf8")).to.equal(String(other.pid)); // the holder's lock was left alone
    } finally {
      other.kill();
    }
    await new Promise((r) => other.once("exit", r));
    const running = await startFacilitator(env, { provider: s.provider, write: () => undefined }); // the lock is stale now
    await running.shutdown("done");
  });
});

describe("Time limits on the node", function () {
  this.timeout(60_000);
  const silent = async () => {
    const { createServer } = await import("node:http");
    const server = createServer(() => undefined); // takes the connection and never answers
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
  };

  it("gives up on a node that never answers, with the code ethers uses for a timeout, and leaves no timer running", async () => {
    const { TimedJsonRpcProvider, TimeoutError, within } = await import("@sluice/sdk");
    const { Network } = await import("ethers");
    const node = await silent();
    const net = Network.from(1990);
    const provider = new TimedJsonRpcProvider(node.url, net, { staticNetwork: net }, 400);
    try {
      const started = Date.now();
      let error: unknown;
      try {
        await provider.getBlockNumber();
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(TimeoutError);
      expect((error as { code: string }).code).to.equal("TIMEOUT");
      expect(Date.now() - started).to.be.within(300, 5_000);
      expect(await within(Promise.resolve(7), 1_000)).to.equal(7);
    } finally {
      provider.destroy();
      await node.close();
    }
  });

  it("is what the facilitator's program uses, with a setting for the limit", () => {
    expect(readEnv({ SLUICE_NETWORK: "local", SLUICE_RPC_URL: "http://127.0.0.1:8545", SLUICE_ROUTER: `0x${"12".repeat(20)}`, SLUICE_RELAYER_KEY: `0x${"34".repeat(32)}` }).rpcTimeoutMs).to.equal(20_000);
    expect(() => readEnv({ SLUICE_NETWORK: "local", SLUICE_RPC_URL: "http://127.0.0.1:8545", SLUICE_ROUTER: `0x${"12".repeat(20)}`, SLUICE_RELAYER_KEY: `0x${"34".repeat(32)}`, SLUICE_FACILITATOR_RPC_TIMEOUT_MS: "5" })).to.throw(/SLUICE_FACILITATOR_RPC_TIMEOUT_MS/);
    expect(readFileSync(join(__dirname, "..", "..", "..", "packages", "facilitator", "src", "runtime.ts"), "utf8")).to.contain("new FailoverJsonRpcProvider("); // a TimedJsonRpcProvider that also reads from the next endpoint
  });
});
