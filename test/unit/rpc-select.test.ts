// Choosing a QIE endpoint that works, with endpoints that are mocked: the first one dead, the second on the wrong chain, the third healthy.
// Nothing here reaches a real node. Where a real node is needed (the failover provider) it is the local Hardhat chain.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Network, parseEther } from "ethers";
import {
  FailoverJsonRpcProvider, NoHealthyEndpoint, QIE_CHAIN_ID, QIE_ENDPOINTS, describeSelection, orderedUrls, probeEndpoint, probeEndpoints, resolveEndpoint, selectEndpoint,
} from "@sluice/sdk";
import { readEnv } from "@sluice/facilitator";
import { readToolServerEnv } from "../../examples/paid-tools/src";
import { main as recordMain } from "../../scripts/evidence/record";
import { main as checkMain } from "../../scripts/evidence-check";
import { main as preflightMain } from "../../scripts/live/preflight";
import { SpendMeter, GuardError, readCaps } from "../../src/guard";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import { appendRows } from "../../src/recorder";
import type { RecordedRow } from "../../src/recorder";
import { rejection } from "../helpers/assert";
import { startChaosProxy } from "../helpers/chaos";
import { evidenceTemplate } from "../helpers/evidence-template";
import { setQie, startStack, throwawayWallet } from "../helpers/stack";

const T = QIE_ENDPOINTS.testnet;
const host = (u: string) => new URL(u).host;
const reply = (chain: string) => async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: chain }));

/** A fetch that answers by endpoint: rpc1 never connects, rpc2 is on another chain, rpc3, rpc4 and rpc5 are on the testnet, rpc5 slowly. */
function fakeNetwork(seen: string[] = []): typeof fetch {
  const table: Record<string, (init?: RequestInit) => Promise<Response>> = {
    [host(T[0] as string)]: async () => { throw new TypeError("fetch failed"); },
    [host(T[1] as string)]: reply("0x7c6"),
    [host(T[2] as string)]: reply("0x7bf"),
    [host(T[3] as string)]: reply("0x7bf"),
    [host(T[4] as string)]: async () => { await new Promise((r) => setTimeout(r, 150)); return reply("0x7bf")(); },
  };
  return (async (url: string, init?: RequestInit) => {
    seen.push(host(url));
    const handler = table[host(url)];
    if (!handler) throw new TypeError("unknown host");
    return handler(init);
  }) as unknown as typeof fetch;
}

describe("RPC endpoints: probing", () => {
  it("knows QIE's five public endpoints for each network, and each network's chain id", () => {
    expect(QIE_ENDPOINTS.testnet).to.deep.equal([1, 2, 3, 4, 5].map((n) => `https://rpc${n}testnet.qie.digital/`));
    expect(QIE_ENDPOINTS.mainnet).to.deep.equal([1, 2, 3, 4, 5].map((n) => `https://rpc${n}mainnet.qie.digital/`));
    expect(QIE_CHAIN_ID).to.deep.equal({ mainnet: 1990, testnet: 1983 });
  });

  it("calls an endpoint healthy only when it answers eth_chainId with the chain it was asked about", async () => {
    const f = fakeNetwork();
    expect(await probeEndpoint(T[2] as string, 1983, { fetchImpl: f })).to.deep.include({ ok: true, chainId: 1983 });
    expect(await probeEndpoint(T[1] as string, 1983, { fetchImpl: f })).to.deep.include({ ok: false, chainId: 1990, reason: "wrong_chain" });
    expect(await probeEndpoint(T[0] as string, 1983, { fetchImpl: f })).to.deep.include({ ok: false, reason: "unreachable" });
    const junk = (async () => new Response(JSON.stringify({ error: "no" }))) as unknown as typeof fetch;
    expect(await probeEndpoint(T[2] as string, 1983, { fetchImpl: junk })).to.deep.include({ ok: false, reason: "bad_answer" });
    const text = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    expect((await probeEndpoint(T[2] as string, 1983, { fetchImpl: text })).ok).to.equal(false);
    const hex = (async () => new Response(JSON.stringify({ result: "not hex" }))) as unknown as typeof fetch;
    expect(await probeEndpoint(T[2] as string, 1983, { fetchImpl: hex })).to.deep.include({ ok: false, reason: "bad_answer" });
  });

  it("gives an endpoint a short time to answer, and calls one that does not a timeout", async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const started = Date.now();
    const p = await probeEndpoint(T[0] as string, 1983, { fetchImpl: hang, timeoutMs: 120 });
    expect(p).to.deep.include({ ok: false, reason: "timeout" });
    expect(Date.now() - started).to.be.within(100, 2_000);
  });

  it("probes all of them at once, so dead endpoints cost one time limit and not one each", async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const started = Date.now();
    const probes = await probeEndpoints(T, 1983, { fetchImpl: hang, timeoutMs: 300 });
    expect(Date.now() - started).to.be.lessThan(1_200); // five endpoints at 300 ms each in turn would take 1,500 ms
    expect(probes.map((p) => p.reason)).to.deep.equal(Array(5).fill("timeout"));
  });

  it("chooses the first healthy endpoint when the first is dead and the second is on the wrong chain, and keeps the other healthy ones as fallbacks", async () => {
    const seen: string[] = [];
    const sel = await selectEndpoint(T, 1983, { fetchImpl: fakeNetwork(seen) });
    expect(sel.url).to.equal(T[2]);
    expect(sel.fallbacks).to.deep.equal([T[3], T[4]]);
    expect(orderedUrls(sel)).to.deep.equal([T[2], T[3], T[4]]);
    expect(sel.overridden).to.equal(false);
    expect(sel.probes.map((p) => [host(p.url).split(".")[0], p.ok, p.reason])).to.deep.equal([
      ["rpc1testnet", false, "unreachable"], ["rpc2testnet", false, "wrong_chain"], ["rpc3testnet", true, undefined], ["rpc4testnet", true, undefined], ["rpc5testnet", true, undefined],
    ]);
  });

  it("chooses by order and not by speed: a slow endpoint that comes first wins over a quick one that comes later", async () => {
    const slowFirst = [T[4] as string, T[3] as string];
    expect((await selectEndpoint(slowFirst, 1983, { fetchImpl: fakeNetwork() })).url).to.equal(T[4]);
  });

  it("refuses with what each endpoint did when none is healthy", async () => {
    const error = await rejection(selectEndpoint([T[0] as string, T[1] as string], 1983, { fetchImpl: fakeNetwork() }));
    expect(error).to.be.instanceOf(NoHealthyEndpoint);
    expect(error.message).to.equal("none of 2 RPC endpoints answered with chain 1983: rpc1testnet.qie.digital unreachable, rpc2testnet.qie.digital wrong_chain");
    expect((error as NoHealthyEndpoint).probes).to.have.length(2);
  });

  it("uses a named endpoint exactly as given, with no probe and no fallback", async () => {
    const seen: string[] = [];
    const sel = await resolveEndpoint("testnet", "  http://127.0.0.1:9999  ", { fetchImpl: fakeNetwork(seen) });
    expect(sel).to.deep.equal({ url: "http://127.0.0.1:9999", fallbacks: [], probes: [], overridden: true });
    expect(seen).to.deep.equal([]);
    // Nothing named: the network's own five are probed.
    const probed = await resolveEndpoint("testnet", "   ", { fetchImpl: fakeNetwork(seen) });
    expect(probed.url).to.equal(T[2]);
    expect(seen).to.have.length(5);
    // A caller's own list replaces the five.
    expect((await resolveEndpoint("testnet", undefined, { fetchImpl: fakeNetwork(), candidates: [T[3] as string] })).url).to.equal(T[3]);
  });

  it("says in one line which endpoint was chosen and what happened to the others", async () => {
    const sel = await selectEndpoint(T, 1983, { fetchImpl: fakeNetwork() });
    const line = describeSelection(sel);
    expect(line).to.match(/^RPC endpoint rpc3testnet\.qie\.digital \(chain 1983, \d+ ms\); 2 fallbacks; skipped rpc1testnet unreachable, rpc2testnet chain 1990$/);
    expect(describeSelection({ url: "http://127.0.0.1:1", fallbacks: [], probes: [], overridden: true })).to.equal("RPC endpoint 127.0.0.1:1 (named by SLUICE_RPC_URL, not probed)");
    const lines: string[] = [];
    const choice = await chooseRpc("testnet", undefined, (l) => lines.push(l), { fetchImpl: fakeNetwork() });
    expect(choice).to.deep.include({ url: T[2], network: "testnet", chainId: 1983 });
    expect(lines).to.have.length(1);
    expect(lines[0]).to.contain("rpc3testnet.qie.digital");
  });
});

describe("RPC endpoints: the failover provider", function () {
  this.timeout(120_000);

  const deadPort = async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${port}`; // nothing listens here any more
  };

  it("reads from the next endpoint when the first cannot be reached, and a read the first answers does not touch the second", async () => {
    const s = await startStack();
    const net = Network.from(1990);
    const second = await startChaosProxy(s.rpcUrl);
    const provider = new FailoverJsonRpcProvider([await deadPort(), second.url], net, { staticNetwork: net }, 3_000);
    try {
      expect(await provider.getBlockNumber()).to.be.greaterThan(0);
      expect(second.seen).to.include("eth_blockNumber");
      const healthy = await startChaosProxy(s.rpcUrl);
      const first = new FailoverJsonRpcProvider([healthy.url, second.url], net, { staticNetwork: net }, 3_000);
      const before = second.seen.length;
      await first.getBlockNumber();
      expect(healthy.seen).to.include("eth_blockNumber");
      expect(second.seen.length).to.equal(before);
      first.destroy();
      await healthy.close();
    } finally {
      provider.destroy();
      await second.close();
      await s.stop();
    }
  });

  it("never tries a request that sends on another endpoint: if the first fails, the caller decides", async () => {
    const s = await startStack();
    const net = Network.from(1990);
    const backup = await startChaosProxy(s.rpcUrl);
    const wallet = throwawayWallet();
    await setQie(wallet.address, parseEther("1"));
    const provider = new FailoverJsonRpcProvider([await deadPort(), backup.url], net, { staticNetwork: net }, 3_000);
    try {
      const signer = wallet.connect(provider);
      const failed = await rejection(signer.sendTransaction({ to: throwawayWallet().address, value: 1n, gasLimit: 21_000n, gasPrice: 2_000_000_000n, nonce: 0 }).then(() => undefined));
      expect(failed).to.be.instanceOf(Error);
      expect(backup.seen.filter((m) => /^eth_send/.test(m)), "the backup never saw a send").to.deep.equal([]);
      expect(await s.provider.getTransactionCount(wallet.address)).to.equal(0);
    } finally {
      provider.destroy();
      await backup.close();
      await s.stop();
    }
  });

  it("is what the scripts get from providerFor, on the chosen endpoint with the others behind it", async () => {
    const s = await startStack();
    const dead = await deadPort();
    const provider = providerFor({ url: dead, fallbacks: [s.rpcUrl] }, 1990, 3_000);
    try {
      expect(await provider.getBlockNumber()).to.be.a("number");
    } finally {
      provider.destroy();
      await s.stop();
    }
    expect(() => new FailoverJsonRpcProvider([], Network.from(1990), {}, 1_000)).to.throw(/no RPC endpoint/);
  });
});

describe("RPC endpoints: what the programs do with the choice", function () {
  this.timeout(120_000);
  const base = { SLUICE_ROUTER: `0x${"12".repeat(20)}`, SLUICE_PAYEE: `0x${"34".repeat(20)}`, SLUICE_FACILITATOR_URL: "https://f.example.com" };

  it("the facilitator reads settings that say whether the endpoint was named, and the tool server the same", () => {
    const common = { SLUICE_RELAYER_KEY: `0x${"34".repeat(32)}`, SLUICE_ROUTER: base.SLUICE_ROUTER };
    const testnet = { ...common, SLUICE_NETWORK: "testnet", SLUICE_APPROVE: "facilitator", SLUICE_MAX_QIE: "0.1", SLUICE_FACILITATOR_STATE: "/data/q.jsonl" };
    expect(readEnv(testnet)).to.deep.include({ rpcNamed: false, rpcUrl: "https://rpc1testnet.qie.digital/" });
    expect(readEnv({ ...testnet, SLUICE_RPC_URL: "https://rpc4testnet.qie.digital/" })).to.deep.include({ rpcNamed: true, rpcUrl: "https://rpc4testnet.qie.digital/" });
    expect(readEnv({ ...common, SLUICE_NETWORK: "local", SLUICE_RPC_URL: "http://127.0.0.1:8545" }).rpcNamed).to.equal(true);
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "testnet" })).to.deep.include({ rpcNamed: false });
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "testnet", SLUICE_RPC_URL: "https://rpc5testnet.qie.digital/" })).to.deep.include({ rpcNamed: true });
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "local", SLUICE_RPC_URL: "http://127.0.0.1:1" }).rpcNamed).to.equal(true);
  });

  it("the tool server has an explorer only on mainnet by default, so a mainnet explorer never answers for testnet addresses", () => {
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "mainnet" }).explorerUrl).to.equal("https://mainnet.qie.digital");
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "testnet" }).explorerUrl).to.equal(undefined);
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "local", SLUICE_RPC_URL: "http://127.0.0.1:1" }).explorerUrl).to.equal(undefined);
    expect(readToolServerEnv({ ...base, SLUICE_NETWORK: "testnet", SLUICE_EXPLORER_URL: "https://testnet-explorer.example" }).explorerUrl).to.equal("https://testnet-explorer.example");
    expect(() => readToolServerEnv({ ...base, SLUICE_NETWORK: "testnet", SLUICE_EXPLORER_URL: "http://explorer.example" })).to.throw(/SLUICE_EXPLORER_URL/);
  });

  const row = (): RecordedRow => ({
    network: "testnet", date: "2026-12-01T10:00:00Z", event: "Deposited", hash: `0x${"ab".repeat(32)}`, block: "100", contract: `0x${"11".repeat(20)}`, amount: "0.300000",
    who: `0x${"22".repeat(20)}`, claim: "deposit", recheck: "x",
  });

  it("evidence:check probes once per network, says which endpoint it will read, and reads only from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-rpc-"));
    try {
      const file = join(dir, "EVIDENCE.md");
      writeFileSync(file, appendRows(evidenceTemplate(readFileSync(join(__dirname, "..", "..", "docs", "EVIDENCE.md"), "utf8")), [row(), { ...row(), amount: "0.400000" }]));
      const seen: string[] = [];
      const out: string[] = [];
      const code = await checkMain([], {}, (l) => out.push(l), file, { fetchImpl: fakeNetwork(seen) });
      expect(code).to.equal(1); // the fake chain knows nothing of the rows
      expect(out.filter((l) => l.startsWith("testnet: RPC endpoint"))).to.have.length(1); // one probe for two rows
      expect(out.join("\n")).to.contain("RPC endpoint rpc3testnet.qie.digital");
      const afterProbe = seen.slice(5);
      expect(afterProbe.length).to.be.greaterThan(0);
      for (const h of afterProbe) expect(h, "reads go to the chosen endpoint or its fallbacks").to.be.oneOf([host(T[2] as string), host(T[3] as string), host(T[4] as string)]);
      expect(afterProbe[0]).to.equal(host(T[2] as string));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evidence:check reads a named endpoint without probing, and reports rows as skipped, never passed, when no endpoint answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-rpc-"));
    try {
      const file = join(dir, "EVIDENCE.md");
      writeFileSync(file, appendRows(evidenceTemplate(readFileSync(join(__dirname, "..", "..", "docs", "EVIDENCE.md"), "utf8")), [row()]));
      const seen: string[] = [];
      const out: string[] = [];
      await checkMain([], { EVIDENCE_RPC_URL: "http://127.0.0.1:1" }, (l) => out.push(l), file, { fetchImpl: fakeNetwork(seen) });
      expect(out.join("\n")).to.contain("named by SLUICE_RPC_URL, not probed");
      // Rows are read from the named endpoint, and none of QIE's five is asked anything.
      expect(seen.length).to.be.greaterThan(0);
      for (const h of seen) expect(h).to.equal("127.0.0.1:1");
      const dead = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
      const out2: string[] = [];
      const code = await checkMain([], {}, (l) => out2.push(l), file, { fetchImpl: dead });
      expect(out2.join("\n")).to.contain("no RPC endpoint answered with the right chain id, so its rows cannot be checked");
      expect(code).to.not.equal(0);
      expect(out2.join("\n")).to.not.match(/^PASS/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the recorder probes when no endpoint is named, says which it chose, and asks only that endpoint for the claim; a named endpoint is not probed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-rpc-"));
    try {
      const file = join(dir, "EVIDENCE.md");
      writeFileSync(file, evidenceTemplate(readFileSync(join(__dirname, "..", "..", "docs", "EVIDENCE.md"), "utf8")));
      const before = readFileSync(file, "utf8");
      const seen: string[] = [];
      const out: string[] = [];
      const args = ["--claim", "deposit", "--tx", `0x${"11".repeat(32)}`, "--network", "testnet", "--router", `0x${"22".repeat(20)}`, "--file", file];
      const code = await recordMain(args, {}, { log: (l) => out.push(l), fetchImpl: fakeNetwork(seen), evidencePath: file });
      expect(code).to.equal(1); // the fake chain has no such transaction
      expect(out.join("\n")).to.contain("RPC endpoint rpc3testnet.qie.digital");
      expect(seen.slice(0, 5).sort()).to.deep.equal(T.map(host).sort());
      expect(seen.slice(5).length).to.be.greaterThan(0);
      expect(readFileSync(file, "utf8")).to.equal(before);
      // No healthy endpoint: nothing could be verified, so exit 2 and write nothing.
      const dead = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
      const out2: string[] = [];
      expect(await recordMain(args, {}, { log: (l) => out2.push(l), fetchImpl: dead, evidencePath: file })).to.equal(2);
      expect(readFileSync(file, "utf8")).to.equal(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the pre-flight check names the endpoint it chose, reads through it first, and says NO-GO with exit 2 when none answers", async () => {
    // The check reads deployment.json in the folder it is run from, so it is given an empty one: the repository's own is never read.
    const cwd = mkdtempSync(join(tmpdir(), "sluice-preflight-"));
    try {
      const out: string[] = [];
      const code = await preflightMain([], { SLUICE_NETWORK: "testnet" }, { log: (l) => out.push(l), fetchImpl: fakeNetwork(), cwd });
      const text = out.join("\n");
      expect(text).to.contain("RPC endpoint rpc3testnet.qie.digital");
      expect(text).to.match(/RPC endpoints:/);
      expect(code).to.not.equal(undefined);
      const dead = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
      const none: string[] = [];
      expect(await preflightMain([], { SLUICE_NETWORK: "testnet" }, { log: (l) => none.push(l), fetchImpl: dead, cwd })).to.equal(2);
      expect(none.join("\n")).to.contain("NO-GO: no RPC endpoint can be read");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("The cap on one transaction", () => {
  it("is read from SLUICE_MAX_TX_QIE, may not pass the script's total cap, and is left out when it is not set", () => {
    expect(readCaps({})).to.deep.equal({ maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n });
    expect(readCaps({ SLUICE_MAX_TX_QIE: "0.05" })).to.deep.include({ maxTxQieWei: 50_000_000_000_000_000n });
    expect(() => readCaps({ SLUICE_MAX_QIE: "0.04", SLUICE_MAX_TX_QIE: "0.05" })).to.throw(GuardError, /could never apply/);
    expect(() => readCaps({ SLUICE_MAX_TX_QIE: "0" })).to.throw(GuardError);
    expect(() => readCaps({ SLUICE_MAX_TX_QIE: "lots" })).to.throw(GuardError);
  });

  it("stops a transaction that could cost more than the cap before it is sent, and lets one inside it through", () => {
    const meter = new SpendMeter({ maxQusdc: 1n, maxQieWei: 10n ** 18n, maxTxQieWei: 50_000_000_000_000_000n }); // 0.05 QIE
    meter.beforeSend(4_000_000n, 1_125_000_000n); // 0.0045 QIE: fine
    expect(() => meter.beforeSend(4_000_000n, 20_000_000_000n)).to.throw(GuardError, /could cost 0\.08 QIE, above the cap of 0\.05 QIE for a single transaction/);
    const uncapped = new SpendMeter({ maxQusdc: 1n, maxQieWei: 10n ** 18n });
    uncapped.beforeSend(4_000_000n, 20_000_000_000n); // no per-transaction cap set: only the total applies
  });
});
