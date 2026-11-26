// The testnet rehearsal's logic, with a pretend chain: what it refuses, what it asks for in QIE, how it keeps its place, and what it does
// when a step stops, fails or is refused. Nothing here reaches QIE. The one node that is reached is a local stand-in that answers eth_chainId.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Interface, Wallet, getAddress, parseEther } from "ethers";
import { preflight } from "../../src/preflight";
import {
  DEPLOYER_PARTS, EXPECTED_ADDRESSES, FUNDING_STEP_WEI, GAS_DOC, PER_TX_CAP_WEI, PRICE_FLOOR_WEI, RELAYER_DAILY_BUDGET_WEI, RELAYER_PARTS, STEPS, RehearsalRefused,
  StateError, addTx, assertTestnetChain, assertUnderTxCap, faucetStopLines, formatGwei, fundingNeeds, hashesIn, measuredFor, newState, parseState, refuseUnsafeSettings,
  runRehearsal, serializeState, shortfalls, statusLines,
} from "../../src/rehearsal";
import type { RehearsalState, StepDef, StepId, StepOutcome } from "../../src/rehearsal";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, costWei } from "../../src/gas-figures";
import { main as rehearsal, openTestnet, readCheckedKey } from "../../scripts/rehearsal/testnet";
import { rejection } from "../helpers/assert";

const root = join(__dirname, "..", "..");
const GWEI = 1_000_000_000n;
const NOW = "2026-12-01T10:00:00Z";
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("Rehearsal: it never touches chain 1990", () => {
  it("accepts the testnet's chain id in any form, and refuses every other, with mainnet named", () => {
    for (const ok of [1983, 1983n, "1983", "0x7bf"]) expect(() => assertTestnetChain(ok), String(ok)).to.not.throw();
    const mainnet = (() => { try { assertTestnetChain(1990, "the endpoint rpc1mainnet.qie.digital"); } catch (e) { return e as Error; } })();
    expect(mainnet).to.be.instanceOf(RehearsalRefused);
    expect(mainnet?.message).to.equal("refusing to send: the endpoint rpc1mainnet.qie.digital reports chain 1990, which is QIE mainnet. This rehearsal sends on the testnet (chain 1983) and nowhere else");
    for (const bad of [1, 31337, "0x7c7", 0n, 1984]) expect(() => assertTestnetChain(bad), String(bad)).to.throw(RehearsalRefused, /not the testnet's 1983/);
    expect(() => assertTestnetChain("0x7c6")).to.throw(RehearsalRefused, /QIE mainnet/); // 0x7c6 is 1990
    expect(() => assertTestnetChain("not a number")).to.throw(RehearsalRefused, /gave no chain id/);
  });

  it("refuses a command line or environment that names another network, before anything is read or opened", () => {
    expect(refuseUnsafeSettings({}, [])).to.deep.equal({ status: false });
    expect(refuseUnsafeSettings({ SLUICE_NETWORK: "testnet" }, ["--status"])).to.deep.equal({ status: true });
    expect(refuseUnsafeSettings({ SLUICE_NETWORK: "  " }, [])).to.deep.equal({ status: false });
    expect(() => refuseUnsafeSettings({ SLUICE_NETWORK: "mainnet" }, [])).to.throw(RehearsalRefused, /runs on the testnet only/);
    expect(() => refuseUnsafeSettings({ SLUICE_NETWORK: "local" }, [])).to.throw(RehearsalRefused);
    expect(() => refuseUnsafeSettings({ SLUICE_RPC_URL: "https://rpc2mainnet.qie.digital/" }, [])).to.throw(RehearsalRefused, /names a mainnet endpoint/);
    expect(() => refuseUnsafeSettings({}, ["--network", "mainnet"])).to.throw(RehearsalRefused, /network is not a choice/);
    expect(() => refuseUnsafeSettings({}, ["--network=testnet"])).to.throw(RehearsalRefused, /network is not a choice/);
    expect(() => refuseUnsafeSettings({}, ["--faucet"])).to.throw(RehearsalRefused, /unknown option --faucet/);
  });

  it("refuses to send a transaction whose worst case is above 0.05 QIE, and lets one at the cap through", () => {
    expect(PER_TX_CAP_WEI).to.equal(parseEther("0.05"));
    assertUnderTxCap(4_000_000n, 12_500_000_000n, "the deploy"); // exactly 0.05 QIE
    expect(() => assertUnderTxCap(4_000_000n, 12_500_000_001n, "the deploy")).to.throw(RehearsalRefused, /refusing to send the deploy: it could cost 0\.050000000004 QIE, above the cap of 0\.05 QIE for one transaction/);
    assertUnderTxCap(3_200_000n, 1_125_000_000n, "the router deploy"); // what docs/GAS.md measured, with room
    expect(() => assertUnderTxCap(1_000_000n, 51n * GWEI, "a settle")).to.throw(RehearsalRefused);
  });

  describe("the connection", function () {
    this.timeout(60_000);
    const node = async (chain: string) => {
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", () => {
          const call = JSON.parse(body) as { id: number; method: string } | Array<{ id: number; method: string }>;
          const one = (c: { id: number; method: string }) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_chainId" ? chain : "0x1" });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(Array.isArray(call) ? call.map(one) : one(call)));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
    };

    it("stops when the node it chose is on chain 1990, and goes on when it is on 1983", async () => {
      const main = await node("0x7c6");
      const test = await node("0x7bf");
      try {
        const error = await rejection(openTestnet({ SLUICE_RPC_URL: main.url }, () => undefined));
        expect(error).to.be.instanceOf(RehearsalRefused);
        expect(error.message).to.match(/reports chain 1990, which is QIE mainnet/);
        const lines: string[] = [];
        const open = await openTestnet({ SLUICE_RPC_URL: test.url }, (l) => lines.push(l));
        expect(open.choice.url).to.equal(test.url);
        expect(lines.join("\n")).to.contain("named by SLUICE_RPC_URL, not probed");
        open.provider.destroy();
      } finally {
        await main.close();
        await test.close();
      }
    });
  });
});

describe("Rehearsal: the key files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sluice-keys-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns a key that belongs to the address it is meant to hold, with or without the 0x prefix and a trailing newline", () => {
    const w = Wallet.createRandom();
    writeFileSync(join(dir, "a.key"), `${w.privateKey}\n`);
    expect(readCheckedKey(dir, "a.key", w.address)).to.equal(w.privateKey);
    writeFileSync(join(dir, "b.key"), `${w.privateKey.slice(2)}\r\n`);
    expect(readCheckedKey(dir, "b.key", w.address.toLowerCase())).to.equal(w.privateKey);
  });

  it("refuses a key for another address, a missing file and a file that is not a key, and never puts a key in its message", () => {
    const w = Wallet.createRandom();
    const other = Wallet.createRandom();
    writeFileSync(join(dir, "a.key"), w.privateKey);
    const wrong = (() => { try { readCheckedKey(dir, "a.key", other.address); } catch (e) { return e as Error; } })();
    expect(wrong?.message).to.equal(`a.key does not belong to ${other.address}, so it is not used`);
    expect(wrong?.message).to.not.contain(w.privateKey.slice(2));
    expect(() => readCheckedKey(dir, "missing.key", w.address)).to.throw(/missing\.key is not in the repository root/);
    const almost = w.privateKey.slice(0, -1);
    writeFileSync(join(dir, "c.key"), almost);
    const bad = (() => { try { readCheckedKey(dir, "c.key", w.address); } catch (e) { return e as Error; } })();
    expect(bad?.message).to.equal("c.key does not hold a 32-byte hex key on one line");
    expect(bad?.message).to.not.contain(almost.slice(2));
  });

  it("holds the two addresses the founder gave", () => {
    expect(getAddress(EXPECTED_ADDRESSES.deployer)).to.equal("0xA628018769dacfcdB84dc58A68D2CaA982C77877");
    expect(getAddress(EXPECTED_ADDRESSES.relayer)).to.equal("0x5f49b193BAe4D8Ec010a191DC41b8d5fAC16D772");
  });

  it("is ignored by git and kept out of Docker builds, with the rehearsal's own files", () => {
    const git = readFileSync(join(root, ".gitignore"), "utf8").replace(/\r\n/g, "\n");
    for (const entry of ["*.key", "rehearsal-state.json", ".rehearsal/"]) expect(git.split("\n"), entry).to.include(entry);
    const docker = readFileSync(join(root, ".dockerignore"), "utf8").replace(/\r\n/g, "\n").split("\n");
    for (const entry of ["**/*.key", "/.rehearsal", "/rehearsal-state.json"]) expect(docker, entry).to.include(entry);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- funding

const iface = new Interface(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
function pretendNode(balances: Record<string, bigint>, gasPrice: bigint) {
  return async (method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case "eth_chainId": return "0x7bf";
      case "eth_gasPrice": return `0x${gasPrice.toString(16)}`;
      case "eth_getCode": return "0x6001";
      case "eth_getBalance": return `0x${(balances[getAddress(String(params[0]))] ?? 0n).toString(16)}`;
      case "eth_call": {
        const data = String((params[0] as { data: string }).data);
        return data.startsWith(iface.getFunction("decimals")?.selector as string) ? iface.encodeFunctionResult("decimals", [6]) : iface.encodeFunctionResult("balanceOf", [1_000_000_000n]);
      }
    }
    throw new Error(`unexpected ${method}`);
  };
}

describe("Rehearsal: how much QIE it asks for", () => {
  const who = { deployer: getAddress(EXPECTED_ADDRESSES.deployer), relayer: getAddress(EXPECTED_ADDRESSES.relayer) };

  it("sizes each address from docs/GAS.md at the gas price, with half again on top, in steps of 0.005 QIE", () => {
    const n = fundingNeeds(1_125_000_000n, who);
    const deployerGas = DEPLOYER_PARTS.reduce((s, p) => s + p.gas, 0n);
    expect(deployerGas).to.equal(1_500_000n + 100_000n + MEASURED_GAS.deployRouter + SMOKE_GAS_TOTAL + 100_000n + MEASURED_GAS.withdraw);
    expect(n.deployer.minWei).to.be.at.least(costWei(deployerGas, 1_125_000_000n, 50n));
    expect(n.deployer.minWei - costWei(deployerGas, 1_125_000_000n, 50n)).to.be.lessThan(FUNDING_STEP_WEI);
    expect(n.deployer.minWei % FUNDING_STEP_WEI).to.equal(0n);
    expect(n.relayer.minWei % FUNDING_STEP_WEI).to.equal(0n);
    expect(n.deployer.address).to.equal(who.deployer);
    expect(n.relayer.address).to.equal(who.relayer);
    expect(n.deployer.minWei).to.equal(parseEther("0.01"));
    expect(n.relayer.minWei).to.equal(parseEther("0.025"));
    expect(RELAYER_PARTS.map((p) => p.gas)).to.deep.equal([GAS_DOC.authorizeBySignature, MEASURED_GAS.topUpTransfer, 4n * GAS_DOC.batch10Worst]);
  });

  it("never sizes from a price below the one docs/GAS.md measured, and grows with a dearer price", () => {
    expect(fundingNeeds(1n, who).deployer.minWei).to.equal(fundingNeeds(PRICE_FLOOR_WEI, who).deployer.minWei);
    expect(fundingNeeds(1n, who).deployer.priceWei).to.equal(PRICE_FLOOR_WEI);
    const dear = fundingNeeds(10n * GWEI, who);
    expect(dear.deployer.minWei).to.be.greaterThan(fundingNeeds(PRICE_FLOOR_WEI, who).deployer.minWei);
    expect(dear.relayer.minWei).to.be.greaterThan(fundingNeeds(PRICE_FLOOR_WEI, who).relayer.minWei);
  });

  it("is never below what the pre-flight check asks, so a funded address does not fail it, at any price", async () => {
    for (const price of [500_000_000n, 1_125_000_000n, 2n * GWEI, 5n * GWEI, 20n * GWEI]) {
      const n = fundingNeeds(price, who);
      const rpc = pretendNode({ [who.deployer]: n.deployer.minWei, [who.relayer]: n.relayer.minWei }, price);
      const result = await preflight({ network: "testnet", rpcUrls: [], phase: "pre-deploy", deployer: who.deployer, relayer: who.relayer, token: `0x${"cd".repeat(20)}`, relayerBudgetWei: RELAYER_DAILY_BUDGET_WEI }, { rpc });
      const mine = result.checks.filter((c) => c.name === "Deployer QIE" || c.name === "Relayer QIE");
      expect(mine.map((c) => c.status), `at ${Number(price) / 1e9} gwei: ${mine.map((c) => c.detail).join("; ")}`).to.not.include("FAIL");
      expect(mine).to.have.length(2);
    }
  });

  it("holds the figures it takes from docs/GAS.md to what that document says", () => {
    const gas = readFileSync(join(root, "docs", "GAS.md"), "utf8");
    const withCommas = (n: bigint) => n.toLocaleString("en-US");
    expect(gas).to.contain(`| Authorize an agent by signature, one tool | ${withCommas(GAS_DOC.authorizeBySignature)} |`);
    expect(gas).to.contain(`| 10 | ${withCommas(GAS_DOC.batch10Worst)} |`);
  });

  it("says which address needs how much, where to get it, and that no faucet was called, when an address holds too little", () => {
    const n = fundingNeeds(1_125_000_000n, who);
    const short = shortfalls(n, { deployer: 0n, relayer: parseEther("0.03") });
    expect(short).to.deep.equal([{ role: "deployer", address: who.deployer, have: 0n, need: parseEther("0.01") }]);
    const lines = faucetStopLines(shortfalls(n, { deployer: 0n, relayer: parseEther("0.0125") }), 1_125_000_000n);
    expect(lines[0]).to.equal("STOP: the rehearsal needs testnet QIE before it can send anything.");
    expect(lines).to.include(`  deployer ${who.deployer} holds 0 QIE and needs at least 0.01 QIE (0.01 more).`);
    expect(lines).to.include(`  relayer ${who.relayer} holds 0.0125 QIE and needs at least 0.025 QIE (0.0125 more).`);
    expect(lines).to.include("  Get it from QIE's testnet faucet, then run pnpm rehearsal:testnet again.");
    expect(lines).to.include("  QIE's documentation gives the faucet as https://www.qie.digital/faucet. This run did not open it.");
    expect(faucetStopLines(short, 1_125_000_000n, 7n)).to.include("  The testnet's own gas price reads 0.000000007 gwei just now, so the real cost may be far below this; the run asks for the larger figure in case the price rises.");
    expect(formatGwei(1_125_000_000n)).to.equal("1.125");
    expect(formatGwei(2n * 1_000_000_000n)).to.equal("2");
    expect(formatGwei(7n)).to.equal("0.000000007");
    expect(lines.join("\n")).to.contain("called no faucet and sent nothing");
    expect(shortfalls(n, { deployer: n.deployer.minWei, relayer: n.relayer.minWei })).to.deep.equal([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- state

describe("Rehearsal: its place in rehearsal-state.json", () => {
  it("round-trips, and a new state is for the testnet and has done nothing", () => {
    const s = newState(NOW);
    s.steps.keys = { status: "done", at: NOW, attempts: 1, note: "ok" };
    s.data.router = `0x${"12".repeat(20)}`;
    addTx(s, { step: "deploy", label: "deploy router", hash: HASH(1), block: 5 });
    s.drills.restart = ["a line"];
    const back = parseState(serializeState(s));
    expect(back).to.deep.equal(s);
    expect(newState(NOW)).to.deep.include({ network: "testnet", chainId: 1983, version: 1 });
    expect(Object.keys(newState(NOW).steps)).to.deep.equal([]);
  });

  it("refuses text that is not readable, is for another network, or holds something it should not, and says what it is", () => {
    expect(() => parseState("{ not json")).to.throw(StateError, /not readable JSON/);
    expect(() => parseState(JSON.stringify({ ...newState(NOW), version: 2 }))).to.throw(StateError, /unknown version/);
    expect(() => parseState(JSON.stringify({ ...newState(NOW), network: "mainnet", chainId: 1990 }))).to.throw(StateError, /not for the testnet/);
    expect(() => parseState(JSON.stringify({ ...newState(NOW), steps: { bogus: { status: "done", at: NOW, attempts: 1 } } }))).to.throw(StateError, /a step it does not know: bogus/);
    expect(() => parseState(JSON.stringify({ ...newState(NOW), steps: { keys: { status: "weird", at: NOW, attempts: 1 } } }))).to.throw(StateError);
    expect(() => parseState(JSON.stringify({ ...newState(NOW), txs: [{ step: "keys", label: "x", hash: "0x12" }] }))).to.throw(StateError, /not a transaction hash/);
    expect(() => parseState(JSON.stringify({ version: 1, network: "testnet", chainId: 1983 }))).to.throw(StateError, /missing parts/);
  });

  it("will not write a state that holds a key it was told about", () => {
    const s = newState(NOW);
    const key = Wallet.createRandom().privateKey;
    s.data.note = `the key is ${key}`;
    expect(() => serializeState(s, [key])).to.throw(StateError, /would hold a key/);
    expect(() => serializeState(newState(NOW), [key])).to.not.throw();
    expect(() => serializeState(newState(NOW), ["", "short"])).to.not.throw();
  });

  it("records a transaction once, and a later record fills in what the first lacked without changing what it had", () => {
    const s = newState(NOW);
    addTx(s, { step: "smoke", label: "approve", hash: HASH(7).toUpperCase().replace("0X", "0x") });
    addTx(s, { step: "smoke", label: "something else", hash: HASH(7), block: 9, gasUsed: "46973", costWei: "52844" });
    expect(s.txs).to.have.length(1);
    expect(s.txs[0]).to.deep.equal({ step: "smoke", label: "approve", hash: HASH(7), block: 9, gasUsed: "46973", costWei: "52844" });
  });

  it("finds the transaction hashes in a script's lines and labels them, and does not take an address for a hash", () => {
    const found = hashesIn("smoke", [
      `approve: ${HASH(1)} in block 12`,
      `test token 0x${"ab".repeat(20)} (${HASH(2)}, block 7)`,
      `deposit:  ${HASH(3)}`,
      `top-up from the facilitator: ${HASH(4)} (210000000000000 wei)`,
      `router 0x${"cd".repeat(20)}`,
      "no hash here",
    ]);
    expect(found).to.deep.equal([
      { step: "smoke", label: "approve", hash: HASH(1), block: 12 },
      { step: "smoke", label: "test token", hash: HASH(2), block: 7 },
      { step: "smoke", label: "deposit", hash: HASH(3) },
      { step: "smoke", label: "top-up from the facilitator", hash: HASH(4) },
    ]);
  });

  it("matches a transaction to the figure in docs/GAS.md by its label, and says nothing for one that has no figure", () => {
    expect(measuredFor("approve")?.gas).to.equal(46_973n);
    expect(measuredFor("deposit")?.gas).to.equal(112_937n);
    expect(measuredFor("settle (payer-signed)")?.gas).to.equal(110_078n);
    expect(measuredFor("settle (agent-signed)")?.gas).to.equal(93_204n);
    expect(measuredFor("authorize agent")?.gas).to.equal(119_499n);
    expect(measuredFor("withdraw the builder's earnings")?.gas).to.equal(71_538n);
    expect(measuredFor("deploy router")?.gas).to.equal(3_158_652n);
    expect(measuredFor("top-up from the facilitator")?.gas).to.equal(21_000n);
    expect(measuredFor("deploy test token")).to.equal(undefined);
    expect(measuredFor("batchSettle by the facilitator")).to.equal(undefined);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ the engine

type Harness = { state: RehearsalState; log: string[]; ran: StepId[]; saves: () => number; go: () => ReturnType<typeof runRehearsal> };

function harness(behave: (step: StepDef) => StepOutcome | Promise<StepOutcome> | never, state: RehearsalState = newState(NOW)): Harness {
  const log: string[] = [];
  const ran: StepId[] = [];
  let saves = 0;
  return {
    state, log, ran, saves: () => saves,
    go: () => runRehearsal(STEPS, { state, save: () => { saves += 1; }, log: (l) => log.push(l), now: () => NOW, run: async (step) => { ran.push(step.id); return behave(step); } }),
  };
}
const ok: StepOutcome = { kind: "done" };
/** What the state file would hold after the process ended: the text, read again. */
const reloaded = (s: RehearsalState): RehearsalState => parseState(serializeState(s));

describe("Rehearsal: the steps, in order, with a pretend chain", () => {
  it("lists the brief's steps in order, with each step's prerequisites naming steps that come before it", () => {
    const seen = new Set<string>();
    for (const step of STEPS) {
      for (const need of step.needs) expect(seen.has(need), `${step.id} needs ${need}, which must come first`).to.equal(true);
      seen.add(step.id);
    }
    expect(new Set(STEPS.map((s) => s.id)).size).to.equal(STEPS.length);
    expect(STEPS.map((s) => s.group)).to.deep.equal([1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5, 6, 6, 9, 9, 7, 8]);
  });

  it("stops at the faucet step with the message, runs nothing after it, and carries on from there once the address is funded", async () => {
    const a = harness((step) => (step.id === "funding" ? { kind: "stop", lines: ["STOP: the rehearsal needs testnet QIE", "  deployer 0xA6… needs 0.01"] } : ok));
    const first = await a.go();
    expect(a.ran).to.deep.equal(["keys", "endpoint", "funding"]);
    expect(first).to.deep.include({ stopped: "funding" });
    expect(first.done).to.deep.equal(["keys", "endpoint"]);
    expect(a.state.steps.funding?.status).to.equal("stopped");
    expect(a.log).to.include("STOP: the rehearsal needs testnet QIE");
    expect(a.saves()).to.be.greaterThan(2);
    expect(Object.keys(a.state.steps)).to.not.include("token");

    // The next run: the file is read back, the address is funded, and the steps already done are not run again.
    const b = harness(() => ok, reloaded(a.state));
    const second = await b.go();
    expect(second.skipped).to.deep.equal(["keys", "endpoint"]);
    expect(b.ran[0]).to.equal("funding");
    expect(b.ran).to.have.length(STEPS.length - 2);
    expect(second).to.deep.include({ failed: [], blocked: [] });
    expect(b.state.steps.funding).to.deep.include({ status: "done", attempts: 2 });
    expect(statusLines(b.state).every((l) => !/not run/.test(l))).to.equal(true);
  });

  it("fails one step with its exact error, blocks what needs it, runs what does not, and retries the failure on the next run", async () => {
    const a = harness((step) => { if (step.id === "token") throw new Error("the token's deployment failed (0xabc): replacement transaction underpriced"); return ok; });
    const first = await a.go();
    expect(first.failed).to.deep.equal(["token"]);
    expect(a.state.steps.token).to.deep.include({ status: "failed", error: "the token's deployment failed (0xabc): replacement transaction underpriced", attempts: 1 });
    expect(a.log).to.include("  FAILED: the token's deployment failed (0xabc): replacement transaction underpriced");
    for (const blocked of ["preflight-pre", "deploy", "smoke", "facilitator", "funded-flow", "withdraw", "verify-source"]) expect(first.blocked, blocked).to.include(blocked as StepId);
    expect(a.ran).to.not.include("deploy");
    expect(first.done, "a step that needs nothing still runs").to.include("evidence");
    expect(a.state.steps.deploy?.status).to.equal("blocked");

    const b = harness(() => ok, reloaded(a.state));
    const second = await b.go();
    expect(second.failed).to.deep.equal([]);
    expect(second.blocked).to.deep.equal([]);
    expect(b.state.steps.token).to.deep.include({ status: "done", attempts: 2 });
    expect(b.ran).to.not.include("keys");
    expect(b.ran).to.not.include("evidence"); // done in the first run
  });

  it("a step that is refused for the wrong chain ends the run: nothing after it runs, and a second run still starts at that step", async () => {
    const a = harness((step) => { if (step.id === "endpoint") throw new RehearsalRefused("refusing to send: the node reports chain 1990, which is QIE mainnet"); return ok; });
    const first = await a.go();
    expect(first.aborted).to.equal("endpoint");
    expect(a.ran).to.deep.equal(["keys", "endpoint"]);
    expect(a.state.steps.endpoint?.status).to.equal("failed");
    expect(a.log.join("\n")).to.contain("nothing after it may run");
    const b = harness(() => ok, reloaded(a.state));
    await b.go();
    expect(b.ran[0]).to.equal("endpoint");
  });

  it("a pretend chain on 1990 sends nothing: the guard stops the run at the endpoint step, before the balances are read", async () => {
    const sent: string[] = [];
    const chain = (id: number) => ({ chainId: async () => BigInt(id), balance: async () => { sent.push("balance read"); return 0n; } });
    const behave = (c: ReturnType<typeof chain>) => async (step: StepDef): Promise<StepOutcome> => {
      if (step.id === "endpoint") assertTestnetChain(await c.chainId(), "the node");
      if (step.id === "funding") await c.balance();
      return ok;
    };
    const wrong = harness(behave(chain(1990)));
    const result = await wrong.go();
    expect(result.aborted).to.equal("endpoint");
    expect(sent).to.deep.equal([]);
    const right = harness(behave(chain(1983)));
    expect((await right.go()).aborted).to.equal(undefined);
    expect(sent).to.deep.equal(["balance read"]);
  });

  it("redacts what it logs and records of a failure, when it is given a way to", async () => {
    const key = Wallet.createRandom().privateKey;
    const state = newState(NOW);
    const log: string[] = [];
    await runRehearsal(STEPS, { state, save: () => undefined, log: (l) => log.push(l), now: () => NOW, redact: (t) => t.split(key).join("[redacted]"), run: async (step) => { if (step.id === "keys") throw new Error(`bad key ${key}`); return ok; } });
    expect(state.steps.keys?.error).to.equal("bad key [redacted]");
    expect(log.join("\n")).to.not.contain(key);
    expect(serializeState(state, [key])).to.not.contain(key);
  });

  it("counts an attempt each time a step runs, and none for a step that was only blocked", async () => {
    const a = harness((step) => { if (step.id === "keys") throw new Error("no key file"); return ok; });
    await a.go();
    expect(a.state.steps.keys?.attempts).to.equal(1);
    expect(a.state.steps.endpoint).to.deep.include({ status: "blocked", attempts: 0 });
    await harness((step) => { if (step.id === "keys") throw new Error("no key file"); return ok; }, reloaded(a.state)).go();
  });
});

// --------------------------------------------------------------------------------------------------------------------------- the command

describe("Rehearsal: the command", function () {
  this.timeout(60_000);
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sluice-rehearsal-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("refuses another network and an unknown option, says why, and creates nothing", async () => {
    for (const [argv, env] of [[["--network", "mainnet"], {}], [[], { SLUICE_NETWORK: "mainnet" }], [[], { SLUICE_RPC_URL: "https://rpc1mainnet.qie.digital/" }], [["--faucet"], {}]] as Array<[string[], Record<string, string>]>) {
      const out: string[] = [];
      expect(await rehearsal(argv, env, { root: dir, log: (l) => out.push(l) }), `${argv.join(" ")} ${JSON.stringify(env)}`).to.equal(1);
      expect(out.join("\n")).to.match(/refusing to run/);
    }
    expect(existsSync(join(dir, ".rehearsal"))).to.equal(false);
    expect(existsSync(join(dir, "rehearsal-state.json"))).to.equal(false);
  });

  it("--status says where it has got to and changes nothing", async () => {
    const out: string[] = [];
    expect(await rehearsal(["--status"], {}, { root: dir, log: (l) => out.push(l) })).to.equal(0);
    expect(out[0]).to.match(/^rehearsal on the testnet \(chain 1983\), started /);
    expect(out.filter((l) => /not run/.test(l))).to.have.length(STEPS.length);
    expect(existsSync(join(dir, "rehearsal-state.json"))).to.equal(false);
    expect(existsSync(join(dir, ".rehearsal"))).to.equal(false);
    const s = newState(NOW);
    s.steps.keys = { status: "done", at: NOW, attempts: 1, note: "both key files hold the addresses they should" };
    s.steps.funding = { status: "stopped", at: NOW, attempts: 1, note: "STOP: the rehearsal needs testnet QIE" };
    writeFileSync(join(dir, "rehearsal-state.json"), serializeState(s));
    const again: string[] = [];
    await rehearsal(["--status"], {}, { root: dir, log: (l) => again.push(l) });
    expect(again.find((l) => /\bkeys\b/.test(l))).to.match(/done\s+both key files hold the addresses they should/);
    expect(again.find((l) => /\bfunding\b/.test(l))).to.match(/stopped\s+STOP: the rehearsal needs testnet QIE/);
  });

  it("will not run from a state file that is damaged or is for another network, and leaves the file as it is", async () => {
    const file = join(dir, "rehearsal-state.json");
    for (const text of ["{ broken", JSON.stringify({ ...newState(NOW), network: "mainnet", chainId: 1990 })]) {
      writeFileSync(file, text);
      const out: string[] = [];
      expect(await rehearsal([], {}, { root: dir, log: (l) => out.push(l) })).to.equal(1);
      expect(out.join("\n")).to.match(/rehearsal-state\.json/);
      expect(readFileSync(file, "utf8")).to.equal(text);
    }
  });
});
