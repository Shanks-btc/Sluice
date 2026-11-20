// The web app's logic modules: settings, networks, amounts, the Content Security Policy, the rate limiter, the facilitator reader,
// and the status badges. Each test says what it holds fixed.
import { expect } from "chai";
import { Wallet } from "ethers";
import { FacilitatorClient } from "@sluice/sdk/facilitator-client";
import { PUBLIC_ENV_NAMES, loadConfigFromProcess, parseWebUrl, readConfig } from "../../../apps/web/src/lib/config";
import { allowsAnyFacilitator, buildCsp, makeNonce, originOf } from "../../../apps/web/src/lib/csp";
import { INTENT_ID, MAX_RESPONSE_CHARS, fetchJson, getHealth, getStatus, parseHealth, parseStatus, targetWarning, validateFacilitatorUrl } from "../../../apps/web/src/lib/facilitator";
import type { FetchLike } from "../../../apps/web/src/lib/facilitator";
import { formatGwei, formatQie, formatUsdc, formatUtc, isAddress, parseAmountInput, shortAddress, shortHash } from "../../../apps/web/src/lib/format";
import { LOCAL, MAINNET, NATIVE_CURRENCY, TESTNET, chainParams, explorerTxUrl, isLocalUrl, networkFor, toHexChainId } from "../../../apps/web/src/lib/networks";
import { RateLimiter, callerKey } from "../../../apps/web/src/lib/rate-limit";
import { COMPONENTS, badgeClass, effectiveStatus, missingEvidence } from "../../../apps/web/src/status";
import type { ComponentStatus } from "../../../apps/web/src/status";

const address = () => Wallet.createRandom().address;

describe("Web: settings", () => {
  it("defaults to chain 1990 on QIE's public RPC with nothing configured, and says contracts are not configured", () => {
    const c = readConfig({});
    expect(c.chainId).to.equal(1990);
    expect(c.rpcUrl).to.equal("https://rpc1mainnet.qie.digital/");
    expect(c.contractsConfigured).to.equal(false);
    expect(c.router).to.equal(null);
    expect(c.problems).to.deep.equal([]);
  });

  it("reads valid addresses and normalises them, and needs both for 'configured'", () => {
    const router = address();
    const vault = address();
    expect(readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: router.toLowerCase(), NEXT_PUBLIC_VAULT_ADDRESS: vault }).contractsConfigured).to.equal(true);
    expect(readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: router }).contractsConfigured).to.equal(false);
  });

  it("leaves out a bad value and lists it, instead of failing", () => {
    const c = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: "0x123", NEXT_PUBLIC_CHAIN_ID: "mainnet", NEXT_PUBLIC_FACILITATOR_URL: "ftp://x", NEXT_PUBLIC_FROM_BLOCK: "-1", NEXT_PUBLIC_RPC_URL: "http://example.com" });
    expect(c.router).to.equal(null);
    expect(c.chainId).to.equal(1990);
    expect(c.facilitatorUrl).to.equal(null);
    expect(c.fromBlock).to.equal(null);
    expect(c.problems).to.have.length(5);
  });

  it("accepts https and a local http address, and refuses credentials and other schemes", () => {
    expect(parseWebUrl("https://facilitator.example")?.hostname).to.equal("facilitator.example");
    expect(parseWebUrl("http://127.0.0.1:8402")?.port).to.equal("8402");
    expect(parseWebUrl("http://localhost:8402")).to.not.equal(undefined);
    expect(parseWebUrl("http://example.com")).to.equal(undefined);
    expect(parseWebUrl("https://user:pw@example.com")).to.equal(undefined);
    expect(parseWebUrl("javascript:alert(1)")).to.equal(undefined);
    expect(parseWebUrl("")).to.equal(undefined);
  });

  it("only takes a github.com address as the repository", () => {
    expect(readConfig({ NEXT_PUBLIC_GITHUB_URL: "https://github.com/x/y/" }).repoUrl).to.equal("https://github.com/x/y");
    expect(readConfig({ NEXT_PUBLIC_GITHUB_URL: "https://evil.example/x" }).repoUrl).to.equal(null);
  });

  it("treats a local RPC as a local network whatever the chain id", () => {
    const c = readConfig({ NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545", NEXT_PUBLIC_CHAIN_ID: "1990" });
    expect(c.network.id).to.equal("local");
    expect(c.network.realFunds).to.equal(false);
    expect(readConfig({ NEXT_PUBLIC_CHAIN_ID: "1983" }).network.id).to.equal("testnet");
    expect(readConfig({}).network.realFunds).to.equal(true);
  });

  it("reads the running server's environment by name", () => {
    process.env["NEXT_PUBLIC_CHAIN_ID"] = "1983";
    try {
      expect(loadConfigFromProcess().chainId).to.equal(1983);
    } finally {
      delete process.env["NEXT_PUBLIC_CHAIN_ID"];
    }
  });

  it("lists every name once", () => {
    expect(new Set(PUBLIC_ENV_NAMES).size).to.equal(PUBLIC_ENV_NAMES.length);
    for (const n of PUBLIC_ENV_NAMES) expect(n).to.match(/^NEXT_PUBLIC_[A-Z_]+$/);
  });
});

describe("Web: networks", () => {
  it("has QIE mainnet's published parameters", () => {
    expect(chainParams(MAINNET)).to.deep.equal({
      chainId: "0x7c6",
      chainName: "QIE mainnet",
      nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
      rpcUrls: ["https://rpc1mainnet.qie.digital/"],
      blockExplorerUrls: ["https://mainnet.qie.digital/"],
    });
    expect(NATIVE_CURRENCY.decimals).to.equal(18);
    expect(toHexChainId(1983)).to.equal("0x7bf");
  });

  it("gives the testnet no explorer link, because none was checked", () => {
    expect(chainParams(TESTNET)).to.not.have.property("blockExplorerUrls");
    expect(explorerTxUrl(`0x${"ab".repeat(32)}`, TESTNET)).to.equal(undefined);
  });

  it("links a transaction hash on mainnet, and only a transaction hash", () => {
    expect(explorerTxUrl(`0x${"ab".repeat(32)}`)).to.equal(`https://mainnet.qie.digital/tx/0x${"ab".repeat(32)}`);
    expect(explorerTxUrl("0x1234")).to.equal(undefined);
    expect(explorerTxUrl(`0x${"zz".repeat(32)}`)).to.equal(undefined);
    expect(explorerTxUrl("javascript:alert(1)")).to.equal(undefined);
  });

  it("names a network from a chain id, and calls a local address local", () => {
    expect(networkFor(1990).id).to.equal("mainnet");
    expect(networkFor(1983).id).to.equal("testnet");
    expect(networkFor(1990, "http://localhost:8545").id).to.equal("local");
    expect(networkFor(42).label).to.contain("42");
    expect(isLocalUrl("http://127.0.0.1:1")).to.equal(true);
    expect(isLocalUrl("https://rpc1mainnet.qie.digital")).to.equal(false);
    expect(LOCAL.realFunds).to.equal(false);
  });
});

describe("Web: amounts and addresses", () => {
  it("formats QUSDC with six places and QIE and gwei without losing digits", () => {
    expect(formatUsdc(1_234_567n)).to.equal("1.234567");
    expect(formatUsdc(0n)).to.equal("0.000000");
    expect(formatQie(1_500_000_000_000_000_000n)).to.equal("1.500000");
    expect(formatQie(237_380_000_000_000n)).to.equal("0.000237");
    expect(formatGwei(1_125_000_000n)).to.equal("1.125");
  });

  it("parses what a person types, strictly", () => {
    const ok = (t: string, max?: bigint) => parseAmountInput(t, max);
    expect(ok("12.5")).to.deep.equal({ ok: true, units: 12_500_000n });
    expect(ok(" 0.000001 ")).to.deep.equal({ ok: true, units: 1n });
    expect(ok("100", 100_000_000n).ok).to.equal(true);
    for (const bad of ["", "0", "0.0", "-1", "+1", "1e3", "1,000", "1.1234567", ".5", "5.", "abc", "0x10", "1 000", "99999999999999"]) {
      expect(ok(bad).ok, JSON.stringify(bad)).to.equal(false);
    }
    expect(ok("100.000001", 100_000_000n)).to.deep.equal({ ok: false, reason: "That is more than the 100.000000 available." });
    // Each refusal gives the right reason, not just a refusal.
    expect((ok("1.1234567") as { reason: string }).reason).to.contain("six decimal places");
    expect((ok("0") as { reason: string }).reason).to.contain("above zero");
    expect((ok("") as { reason: string }).reason).to.contain("Enter an amount");
  });

  it("shortens addresses and hashes, and leaves anything else alone", () => {
    const a = "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5";
    expect(shortAddress(a)).to.equal("0x3F43…5DA5");
    expect(shortAddress("nope")).to.equal("nope");
    expect(shortHash(`0x${"ab".repeat(32)}`)).to.equal("0xabababab…ababab");
    expect(isAddress(a)).to.equal(true);
    expect(isAddress("0x123")).to.equal(false);
  });

  it("writes times in UTC", () => {
    expect(formatUtc(1_800_000_000)).to.equal("2027-01-15 08:00:00 UTC");
    expect(formatUtc(Number.NaN)).to.equal("unknown");
  });
});

describe("Web: the Content Security Policy", () => {
  const nonce = makeNonce();

  it("makes a fresh 128-bit nonce each time", () => {
    expect(makeNonce()).to.not.equal(makeNonce());
    expect(Buffer.from(nonce, "base64")).to.have.length(16);
    expect(makeNonce(() => new Uint8Array(16))).to.equal("AAAAAAAAAAAAAAAAAAAAAA==");
  });

  it("allows scripts and styles from this site and from this request's nonce, and nothing inline", () => {
    const csp = buildCsp({ nonce, path: "/" });
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).to.equal(`script-src 'self' 'nonce-${nonce}'`);
    expect(directive("style-src")).to.equal(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).to.not.contain("unsafe-inline");
    expect(csp).to.not.contain("unsafe-eval");
    expect(csp).to.contain("default-src 'self'");
    expect(csp).to.contain("frame-ancestors 'none'");
    expect(csp).to.contain("object-src 'none'");
    expect(csp).to.contain("base-uri 'self'");
    expect(csp).to.contain("form-action 'self'");
    expect(csp).to.contain("upgrade-insecure-requests");
  });

  it("allows eval and inline styles in development only", () => {
    const dev = buildCsp({ nonce, dev: true });
    expect(dev).to.contain("'unsafe-eval'");
    expect(dev).to.not.contain("upgrade-insecure-requests");
    expect(buildCsp({ nonce })).to.not.contain("unsafe-eval");
  });

  it("lets only the demo and the wallet page reach a facilitator the person types in", () => {
    expect(buildCsp({ nonce, path: "/demo" })).to.contain("connect-src 'self'").and.to.contain(" https: ");
    expect(buildCsp({ nonce, path: "/wallet" })).to.contain(" https: ");
    for (const path of ["/", "/builder", "/docs/spec", "/evidence", undefined]) {
      expect(buildCsp({ nonce, path }), String(path)).to.not.match(/connect-src[^;]* https:( |;|$)/);
    }
    expect(allowsAnyFacilitator("/demo")).to.equal(true);
    expect(allowsAnyFacilitator("/demonstration")).to.equal(false);
  });

  it("adds a configured facilitator's origin to every page, and nothing for a bad one", () => {
    expect(buildCsp({ nonce, path: "/builder", extraConnect: ["https://f.example"] })).to.contain("https://f.example");
    expect(originOf("https://f.example/path?q=1")).to.equal("https://f.example");
    expect(originOf("http://127.0.0.1:8402")).to.equal("http://127.0.0.1:8402");
    expect(originOf("http://evil.example")).to.equal(undefined);
    expect(originOf("not a url")).to.equal(undefined);
    expect(originOf(undefined)).to.equal(undefined);
  });

  it("refuses a nonce that is too short or has the wrong characters", () => {
    expect(() => buildCsp({ nonce: "short" })).to.throw();
    expect(() => buildCsp({ nonce: "has spaces and ; semicolons aaaa" })).to.throw();
  });
});

describe("Web: the rate limiter", () => {
  it("allows the limit within a window, then refuses with a wait, then resets", () => {
    let t = 1_000;
    const limiter = new RateLimiter({ limit: 3, windowMs: 10_000, now: () => t });
    expect(limiter.take("a")).to.deep.equal({ ok: true });
    expect(limiter.take("a")).to.deep.equal({ ok: true });
    expect(limiter.take("a")).to.deep.equal({ ok: true });
    expect(limiter.take("a")).to.deep.equal({ ok: false, retryAfterSeconds: 10 });
    t += 4_000;
    expect(limiter.take("a")).to.deep.equal({ ok: false, retryAfterSeconds: 6 });
    expect(limiter.take("b")).to.deep.equal({ ok: true });
    t += 6_000;
    expect(limiter.take("a")).to.deep.equal({ ok: true });
  });

  it("holds a bounded number of keys", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (const k of ["a", "b", "c", "d", "e"]) limiter.take(k);
    expect(limiter.size).to.equal(3);
  });

  it("hashes the caller and never holds an address", () => {
    const key = callerKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(key).to.match(/^[0-9a-f]{24}$/);
    expect(key).to.not.contain("203");
    expect(callerKey(new Headers({ "x-forwarded-for": "203.0.113.9" }))).to.equal(key);
    expect(callerKey(new Headers({ "x-forwarded-for": "203.0.113.10" }))).to.not.equal(key);
    expect(callerKey(new Headers())).to.match(/^[0-9a-f]{24}$/);
  });
});

describe("Web: reading a facilitator", () => {
  const reply = (body: string, status = 200): FetchLike => async () => ({ status, text: async () => body });

  it("accepts an https address or a local one and says why it refuses the rest", () => {
    expect(validateFacilitatorUrl("https://f.example/")).to.deep.equal({ ok: true, url: "https://f.example" });
    expect(validateFacilitatorUrl("http://127.0.0.1:8402").ok).to.equal(true);
    for (const bad of ["", "f.example", "http://f.example", "https://f.example?x=1", "https://f.example#x", "file:///etc/passwd", "https://u:p@f.example"]) {
      expect(validateFacilitatorUrl(bad).ok, bad).to.equal(false);
    }
  });

  it("warns when the chosen network does not fit the address, and never blocks", () => {
    expect(targetWarning("local", "https://f.example")).to.contain("not on your machine");
    expect(targetWarning("mainnet", "http://127.0.0.1:8402")).to.contain("on your machine");
    expect(targetWarning("local", "http://127.0.0.1:8402")).to.equal(undefined);
    expect(targetWarning("testnet", "https://f.example")).to.equal(undefined);
  });

  it("reads only the health fields it knows, and checks each", () => {
    const health = parseHealth({
      ok: true,
      chainId: 1990,
      router: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
      relayer: "not an address",
      relayerBalanceWei: "1000",
      budget: { budgetWei: "500", spentWei: "10", remainingWei: "490", extra: "ignored" },
      queued: 2,
      alerts: [{ code: "budget_50", message: "x" }, "plain", 42],
      secret: "dropped",
    });
    expect(health).to.deep.equal({
      chainId: 1990,
      router: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
      vault: undefined,
      relayer: undefined,
      relayerBalanceWei: "1000",
      budgetWei: "500",
      spentWei: "10",
      remainingWei: "490",
      queued: 2,
      alerts: ["budget_50", "plain"],
    });
    expect(parseHealth({ ok: false })).to.equal(undefined);
    expect(parseHealth("x")).to.equal(undefined);
    expect(parseHealth(null)).to.equal(undefined);
  });

  it("reads a status, and refuses an unknown state or an error body", () => {
    expect(parseStatus({ id: `0x${"ab".repeat(32)}`, status: "settled", transaction: `0x${"cd".repeat(32)}`, blockNumber: 5 })?.status).to.equal("settled");
    expect(parseStatus({ status: "paid-in-full" })).to.equal(undefined);
    expect(parseStatus({ error: "unknown" })).to.equal(undefined);
    expect(INTENT_ID.test(`0x${"ab".repeat(32)}`)).to.equal(true);
  });

  it("turns every failure into words, and never throws", async () => {
    expect((await getHealth("https://f.example", reply("not json"))).ok).to.equal(false);
    expect((await getHealth("https://f.example", async () => { throw new Error("network down"); })).ok).to.equal(false);
    expect((await getHealth("https://f.example", reply(JSON.stringify({ hello: "world" })))).ok).to.equal(false);
    expect((await getHealth("https://f.example", reply(JSON.stringify({ ok: true, chainId: 1990, alerts: [] })))).ok).to.equal(true);
    const big = await fetchJson("https://f.example", reply("x".repeat(MAX_RESPONSE_CHARS + 1)));
    expect(big).to.deep.equal({ ok: false, reason: "The answer was larger than the page will read." });
    expect((await getStatus("https://f.example", "not an id", reply("{}"))).ok).to.equal(false);
  });

  it("asks without credentials or a referrer", async () => {
    let seen: Parameters<FetchLike>[1] | undefined;
    await getHealth("https://f.example", async (_u, init) => {
      seen = init;
      return { status: 200, text: async () => "{}" };
    });
    expect(seen?.credentials).to.equal("omit");
    expect(seen?.referrerPolicy).to.equal("no-referrer");
    expect(seen?.method).to.equal("GET");
  });
});

describe("Web: status badges", () => {
  const evidence = (network: "mainnet" | "testnet", event: string) => ({ network, event });
  const live: ComponentStatus = { ...COMPONENTS[0]!, status: "Live", evidenceEvents: ["Deposited", "Settled"] };

  it("keeps a fork-tested component at its status", () => {
    for (const c of COMPONENTS) expect(effectiveStatus(c, []).status).to.equal(c.status);
  });

  it("downgrades Live to Coming soon with no evidence, and says what is missing", () => {
    const r = effectiveStatus(live, []);
    expect(r.status).to.equal("Coming soon");
    expect(r.reason).to.contain("Deposited, Settled");
  });

  it("downgrades Live when the evidence is testnet only, or covers only some of the events", () => {
    expect(effectiveStatus(live, [evidence("testnet", "Deposited"), evidence("testnet", "Settled")]).status).to.equal("Coming soon");
    expect(effectiveStatus(live, [evidence("mainnet", "Deposited")]).status).to.equal("Coming soon");
    expect(missingEvidence(live, [evidence("mainnet", "Deposited")])).to.deep.equal(["Settled"]);
  });

  it("shows Live only when every event has a mainnet row", () => {
    expect(effectiveStatus(live, [evidence("mainnet", "Deposited"), evidence("mainnet", "Settled")]).status).to.equal("Live");
  });

  it("never shows Live for a component that names no evidence", () => {
    expect(effectiveStatus({ ...live, evidenceEvents: [] }, [evidence("mainnet", "Settled")]).status).to.equal("Coming soon");
  });

  it("styles each status differently", () => {
    expect(new Set(["Live", "Tested on a fork", "Coming soon"].map((s) => badgeClass(s as never))).size).to.equal(3);
  });
});

describe("Web: the SDK's facilitator client in a browser", () => {
  it("calls the global fetch as a plain function, which a browser requires (Illegal invocation otherwise)", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    // A fetch that behaves like a browser's: it refuses to run as a method of any object but the global one.
    globalThis.fetch = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    } as typeof fetch;
    try {
      const client = new FacilitatorClient({ url: "https://f.example" });
      const res = await client.onboard({ payer: "0x", approveTx: "0x", depositTx: "0x" });
      expect(res.ok).to.equal(true);
      expect(calls).to.equal(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
