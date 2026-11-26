// The paid-call summary: the filter that leaves out founder wallets is pinned here, number by number, and the script is
// run against a local chain with real settlements.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, getAddress, id, parseEther } from "ethers";
import {
  FOUNDER_LIST_PATH, FounderListError, SUMMARY_READ_ONLY_METHODS, formatSummary, founderAddresses, ownRowCount, parseFounderList, scanSettled, summarize, summaryRpc,
} from "../../src/summary";
import { parseEvidenceStrict } from "../../src/evidence";
import { countByClaim } from "../../src/recorder";
import type { FounderList, SettledEvent } from "../../src/summary";
import { main } from "../../scripts/evidence-summary";
import { USDC } from "../helpers";
import { rejection } from "../helpers/assert";
import { makePayment, requirementsFor, verifyBody } from "../helpers/payments";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../helpers/stack";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const [A, B, C, X, Y, F, F2] = [addr(0xa1), addr(0xb2), addr(0xc3), addr(0x1a), addr(0x2b), addr(0xf1), addr(0xf2)];

const list = (wallets: string[], over: Partial<FounderList> = {}): FounderList => ({
  version: 3,
  updated: "2026-11-19",
  description: "a test list",
  wallets: wallets.map((address, i) => ({ address, label: `wallet ${i}` })),
  history: [{ version: 3, date: "2026-11-19", note: "test" }],
  ...over,
});

const event = (payer: string, payee: string, amount: bigint, signer = payer): SettledEvent => ({
  payer, payee, toolId: id("t"), amount, fee: 0n, nonce: id(`${payer}${payee}${amount}${signer}`), signer, block: 1, transaction: `0x${"00".repeat(32)}`,
});

describe("Summary: the founder list", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    version: 1, updated: "2026-11-19", description: "d", wallets: [{ address: F, label: "founder" }],
    history: [{ version: 1, date: "2026-11-19", note: "n" }], ...over,
  });

  it("reads a valid list, with addresses in checksum form", () => {
    const parsed = parseFounderList(raw({ wallets: [{ address: F.toLowerCase(), label: "x" }] }));
    expect(parsed.wallets).to.deep.equal([{ address: F, label: "x" }]);
    expect(parsed.version).to.equal(1);
  });

  const bad: Array<[string, Record<string, unknown> | null, RegExp]> = [
    ["not an object", null, /JSON object/],
    ["no version", { ...raw(), version: undefined }, /version/],
    ["a version of zero", raw({ version: 0 }), /version/],
    ["a version that is not whole", raw({ version: 1.5 }), /version/],
    ["no updated date", raw({ updated: "yesterday" }), /updated/],
    ["no description", raw({ description: "" }), /description/],
    ["no wallets array", raw({ wallets: {} }), /wallets/],
    ["a wallet that is not an address", raw({ wallets: [{ address: "0x12", label: "x" }] }), /valid address/],
    ["a wallet with no label", raw({ wallets: [{ address: F, label: "" }] }), /label/],
    ["a repeated wallet", raw({ wallets: [{ address: F, label: "a" }, { address: F.toLowerCase(), label: "b" }] }), /repeats/],
    ["no history", raw({ history: [] }), /history/],
    ["a history whose last entry is not the list's version", raw({ version: 2 }), /history must end/],
  ];
  for (const [name, value, message] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => parseFounderList(value)).to.throw(FounderListError, message);
    });
  }

  const repo = (path: string) => readFileSync(join(__dirname, "..", "..", path), "utf8");
  const publishedRaw = () => JSON.parse(repo(FOUNDER_LIST_PATH)) as FounderList;

  it("the published list in docs/ is valid, versioned, and has a label for every wallet", () => {
    const published = parseFounderList(publishedRaw());
    expect(published.version).to.be.greaterThan(0);
    expect(published.history.at(-1)!.version).to.equal(published.version);
    for (const w of published.wallets) expect(w.label.length).to.be.greaterThan(0);
    // Written in the file in checksum form, as read: the parser would accept any case, so this is checked on the file itself.
    for (const w of publishedRaw().wallets) expect(w.address).to.equal(getAddress(w.address.toLowerCase()));
    // The history only goes up, one entry for each version, and the list's date is its last change's.
    expect(published.history.map((h) => h.version)).to.deep.equal(published.history.map((_, i) => i + 1));
    expect(published.updated).to.equal(published.history.at(-1)!.date);
  });

  it("holds the six wallets of the mainnet deployment and the local mainnet run, each with a label that says what it is", () => {
    const published = parseFounderList(publishedRaw());
    expect(published.version).to.equal(2);
    expect(Object.fromEntries(published.wallets.map((w) => [w.address, w.label.split(":")[0]]))).to.deep.equal({
      "0x539e8616E5D1DD6C5b4F46055242eEF111209b70": "Deployer",
      "0x0A021bC732325C57E0cC838E4111A861b84fFEB1": "Relayer",
      "0x77804b94128cC803C544B9180B03C09F2482DF36": "Owner",
      "0xd76891452555aE4Df9783889F5bF0d7D0b2146D4": "Fee recipient",
      "0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C": "Payer",
      "0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E": "Builder (payee)",
    });
    // The addresses are the ones the repository's own records name for those roles.
    const guide = repo("docs/LOCAL-MAINNET-RUN.md");
    expect(guide).to.contain("| Payer | `0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C`");
    expect(guide).to.contain("| Builder (the payee) | `0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E`");
    expect(guide).to.contain("| Relayer | `0x0A021bC732325C57E0cC838E4111A861b84fFEB1`");
    expect(repo("docs/EVIDENCE.md")).to.contain("| 0x539e8616E5D1DD6C5b4F46055242eEF111209b70 | mainnet | deploy |");
  });

  it("leaves the two settlements made on mainnet so far, and everything the local run would pay, out of the paid-call counts", () => {
    const published = parseFounderList(publishedRaw());
    const deployer = "0x539e8616E5D1DD6C5b4F46055242eEF111209b70";
    const [payer, builder] = ["0xef20188F9AB8E4eAF35E0b65C1386981F5aC039C", "0x56fe374A5B45E22040D9EB0bF93D55Fd15B3831E"];
    const stranger = addr(0x5151);
    // As read from the router's events: blocks 12119315 (signed by the payer) and 12119319 (signed by an agent key that is not listed).
    const soFar = [event(deployer, deployer, 100_000n), event(deployer, deployer, 50_000n, "0x16c311EfA2b9f426b8b62c8cfeD31259Ac2447A5")];
    expect(summarize(soFar, published)).to.include({ settledEvents: 2, excluded: 2, paidCalls: 0, distinctPayers: 0, distinctBuilders: 0, amountUnits: 0n });
    const local = [event(payer, builder, 2_000n), event(payer, builder, 5_000n, stranger), event(payer, builder, 10_000n)];
    expect(summarize(local, published)).to.include({ excluded: 3, paidCalls: 0 });
    // Each role on its own is enough: a stranger paying a listed builder, and a listed wallet paying a stranger's tool.
    expect(summarize([event(stranger, builder, 1n), event(payer, stranger, 1n)], published)).to.include({ excluded: 2, paidCalls: 0 });
    expect(summarize([event(stranger, addr(0x6262), 7n)], published)).to.include({ excluded: 0, paidCalls: 1, amountUnits: 7n });
  });

  it("counts every mainnet row recorded so far as the project's own, so the recorded counts show no other address", () => {
    const published = parseFounderList(publishedRaw());
    const rows = parseEvidenceStrict(repo("docs/EVIDENCE.md"));
    const mainnet = rows.filter((r) => r.network === "mainnet");
    const founders = founderAddresses(published);
    expect(ownRowCount(rows, "mainnet", founders)).to.equal(mainnet.filter((r) => founders.has(r.who.toLowerCase())).length);
    // The first four rows were the deployment's. A later row from someone else would be counted, so this looks at those four.
    const early = mainnet.filter((r) => BigInt(r.block) <= 12_119_323n);
    expect(early).to.have.length(4);
    for (const counts of countByClaim(early, founders)) expect(counts, counts.claim).to.include({ rows: 0, distinct: 0 });
    expect(countByClaim(early, founders).reduce((n, c) => n + c.excluded, 0)).to.equal(4);
    expect(countByClaim(early, new Set()).reduce((n, c) => n + c.rows, 0), "with no list they were all counted").to.equal(4);
  });

  it("is what pnpm evidence:summary prints for the recorded rows", async () => {
    const lines: string[] = [];
    expect(await main({}, (l) => lines.push(l))).to.equal(0);
    const out = lines.join("\n");
    expect(out).to.contain("founder list version 2");
    // Worked out from the file as it is today, so a row recorded later changes the expectation with it.
    const counted = countByClaim(parseEvidenceStrict(repo("docs/EVIDENCE.md")), founderAddresses(parseFounderList(publishedRaw())));
    expect(counted.reduce((n, c) => n + c.excluded, 0), "the list leaves at least the deployment's rows out").to.be.at.least(4);
    for (const c of counted.filter((x) => x.rows > 0 || x.excluded > 0)) {
      expect(out, c.claim).to.match(new RegExp(`  ${c.claim} +rows ${c.rows}, distinct addresses ${c.distinct}${c.excluded ? `, left out as founder wallets ${c.excluded}` : ""}\\n?`));
    }
  });
});

describe("Summary: the filter (pinned)", () => {
  const events = [
    event(A, X, USDC("0.01")), // counted
    event(A, Y, USDC("0.02")), // counted
    event(B, X, USDC("0.03")), // counted
    event(F, X, USDC("0.04")), // founder as payer
    event(C, F, USDC("0.05")), // founder as payee
    event(C, X, USDC("0.06"), F), // founder's key signed for someone else's balance
    event(F, F2, USDC("0.07")), // founder to founder: both roles
  ];

  it("counts what is left after the founder wallets are removed, and says what it removed and why", () => {
    const s = summarize(events, list([F, F2]));
    expect(s).to.deep.equal({
      listVersion: 3,
      founderWallets: 2,
      settledEvents: 7,
      excluded: 4,
      excludedBy: { payer: 2, payee: 2, signer: 3 }, // a founder who pays with their own key is also the signer
      paidCalls: 3,
      distinctPayers: 2, // A and B
      distinctBuilders: 2, // X and Y
      amountUnits: USDC("0.06"), // 0.01 + 0.02 + 0.03
    });
  });

  it("is what makes the difference: with an empty list the same events all count", () => {
    const s = summarize(events, list([]));
    expect(s).to.include({ paidCalls: 7, excluded: 0, distinctPayers: 4, distinctBuilders: 4 });
    expect(summarize(events, list([F, F2])).paidCalls).to.not.equal(s.paidCalls);
  });

  it("matches wallets whatever their letter case, in the list and in the events", () => {
    const lower = events.map((e) => ({ ...e, payer: e.payer.toLowerCase(), payee: e.payee.toLowerCase(), signer: e.signer.toLowerCase() }));
    expect(summarize(lower, list([F.toUpperCase().replace("0X", "0x"), F2.toLowerCase()].map((a) => getAddress(a.toLowerCase())))).paidCalls).to.equal(3);
  });

  it("counts a distinct payer and a distinct builder once, however many calls they made", () => {
    const many = [event(A, X, 1n), event(A, X, 1n), event(A.toLowerCase(), X.toLowerCase(), 1n)];
    expect(summarize(many, list([]))).to.include({ paidCalls: 3, distinctPayers: 1, distinctBuilders: 1 });
  });

  it("gives zeros for no events, and never a negative or a guess", () => {
    expect(summarize([], list([F]))).to.include({ paidCalls: 0, distinctPayers: 0, distinctBuilders: 0, excluded: 0, amountUnits: 0n });
  });

  it("formats the counts so a reader sees which list version did it", () => {
    const text = formatSummary(summarize(events, list([F, F2])), { fromBlock: 10, toBlock: 20 }, A).join("\n");
    expect(text).to.contain("founder list version 3 (2 wallets)");
    expect(text).to.contain("paid calls counted: 3");
    expect(text).to.contain("distinct payers: 2");
    expect(text).to.contain("distinct builders: 2");
    expect(text).to.contain("left out as founder wallets: 4 (as payer 2, as payee 2, as signer 3)");
    expect(text).to.contain("QUSDC paid in counted calls: 0.060000");
  });
});

describe("Summary: reading the chain", () => {
  it("may call three read-only methods and nothing else", async () => {
    expect([...SUMMARY_READ_ONLY_METHODS].sort()).to.deep.equal(["eth_blockNumber", "eth_chainId", "eth_getLogs"]);
    const rpc = summaryRpc("http://127.0.0.1:1");
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_accounts", "hardhat_setBalance"]) {
      expect((await rejection(rpc(method, []))).message, method).to.match(/not allowed/);
    }
    expect((await rejection(rpc("eth_blockNumber", []))).message).to.match(/network unavailable/);
  });

  it("halves its window when the node refuses a wide range, and fails rather than return part of a count", async () => {
    const asked: number[] = [];
    const rpc = async (method: string, params: unknown[]) => {
      if (method !== "eth_getLogs") throw new Error("unexpected");
      const p = params[0] as { fromBlock: string; toBlock: string };
      const width = Number(BigInt(p.toBlock) - BigInt(p.fromBlock) + 1n);
      asked.push(width);
      if (width > 500) throw new Error("range too wide");
      return [];
    };
    const scan = await scanSettled(rpc, A, 0, 3_999, 2_000);
    expect(scan.events).to.deep.equal([]);
    expect(asked.slice(0, 3)).to.deep.equal([2000, 1000, 500]);
    expect(scan.windows).to.equal(8); // 3,999 blocks in windows of 500
    const refuse = async () => {
      throw new Error("no");
    };
    await rejection(scanSettled(refuse, A, 0, 10_000, 2_000));
  });
});

describe("Summary: the script, against a local chain with real settlements", function () {
  this.timeout(120_000);

  it("counts the paid calls, leaves out the founder's wallets, and prints distinct payers and builders", async () => {
    const s = await startStack({ feeBps: 100 });
    try {
      const founder = throwawayWallet();
      const payers = [throwawayWallet(), throwawayWallet(), founder];
      const builders = [throwawayWallet().address, throwawayWallet().address];
      for (const p of payers) {
        await fundWallet(s, p, USDC("2"), parseEther("1"));
        await depositFor(s, p, USDC("2"));
      }
      const plan: Array<[number, number]> = [[0, 0], [0, 1], [1, 0], [1, 0], [2, 0], [2, 1]]; // payer index, builder index
      for (const [pi, bi] of plan) {
        const payer = payers[pi]!;
        const m = await makePayment(s, payer, payer.address, requirementsFor(s, builders[bi]!, USDC("0.01")));
        expect((await s.facilitator.settle(verifyBody(m))).success).to.equal(true);
      }
      expect(await s.facilitator.flush()).to.include({ settled: 6 });

      const published = JSON.parse(readFileSync(join(__dirname, "..", "..", FOUNDER_LIST_PATH), "utf8")) as FounderList;
      const next = published.version + 1;
      const withFounder = JSON.stringify({ ...published, version: next, wallets: [{ address: founder.address, label: "test founder" }], history: [...published.history, { version: next, date: "2026-11-19", note: "test" }] });
      const lines: string[] = [];
      const env = { SLUICE_ROUTER: s.routerAddress, SLUICE_FROM_BLOCK: "0", EVIDENCE_RPC_URL: s.rpcUrl };
      expect(await main(env, (l) => lines.push(l), undefined, withFounder)).to.equal(0);
      const out = lines.join("\n");
      expect(out).to.contain("Settled events found: 6");
      expect(out).to.contain("left out as founder wallets: 2 (as payer 2, as payee 0, as signer 2)");
      expect(out).to.contain("paid calls counted: 4");
      expect(out).to.contain("distinct payers: 2");
      expect(out).to.contain("distinct builders: 2");
      expect(out).to.contain(`founder list version ${next} (1 wallet)`);
      expect(out).to.contain("QUSDC paid in counted calls: 0.040000");

      // The published list, as it is in the repository, holds none of these throwaway wallets, so it leaves none of them out.
      const unfiltered: string[] = [];
      await main(env, (l) => unfiltered.push(l));
      expect(unfiltered.join("\n")).to.contain("paid calls counted: 6");
    } finally {
      await s.stop();
    }
  });

  it("says plainly when there is nothing to count or the input is wrong, and gives no count when the chain cannot be read", async () => {
    const out = (env: Record<string, string>, listText?: string) => {
      const lines: string[] = [];
      return main(env, (l) => lines.push(l), undefined, listText).then((code) => ({ code, text: lines.join("\n") }));
    };
    const router = addr(0xabc);
    expect(await out({})).to.deep.include({ code: 0 });
    expect((await out({})).text).to.match(/Nothing is claimed/);
    expect((await out({ SLUICE_ROUTER: "nope" })).code).to.equal(1);
    expect((await out({ SLUICE_ROUTER: router })).text).to.match(/SLUICE_FROM_BLOCK/);
    expect((await out({ SLUICE_ROUTER: router, SLUICE_FROM_BLOCK: "-1" })).code).to.equal(1);
    expect((await out({ SLUICE_ROUTER: router, SLUICE_FROM_BLOCK: "0", SLUICE_NETWORK: "devnet" })).code).to.equal(1);
    expect((await out({ SLUICE_ROUTER: router, SLUICE_FROM_BLOCK: "0" }, "{}")).text).to.match(/version/);
    const down = await out({ SLUICE_ROUTER: router, SLUICE_FROM_BLOCK: "0", EVIDENCE_RPC_URL: "http://127.0.0.1:1" });
    expect(down.code).to.equal(2);
    expect(down.text).to.match(/never guessed/);
    expect(down.text).to.not.match(/paid calls counted/);
    expect(Wallet.createRandom().address).to.match(/^0x/);
  });
});
