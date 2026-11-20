// The evidence recorder against a local chain: real deposits, withdrawals, batches, zero-QIE starts and a deployment, made with keys
// created for the run, then recorded (or refused) by the same code that will run against QIE. Nothing leaves this machine.
//
// A run on a local chain has chain id 1990, like QIE mainnet, so these tests label their runs "fork", which is what a local copy of
// the chain is, and which is never written to docs/EVIDENCE.md. Rows labelled mainnet are built by hand where a test needs the file's
// own tables.
import { createServer } from "node:http";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, getAddress, parseEther } from "ethers";
import { network } from "hardhat";
import { HARD_CAPS } from "@sluice/facilitator";
import { ONBOARD_APPROVE_GAS, ONBOARD_DEPOSIT_GAS, signOnboarding } from "@sluice/sdk";
import { EVIDENCE_COLUMNS, NetworkError, parseEvidence, parseEvidenceStrict } from "../../src/evidence";
import type { EvidenceRow } from "../../src/evidence";
import {
  CLAIM_TYPES, RELAYED_START_MAX_TOPUP_WEI, RECORDER_READ_ONLY_METHODS, RecordError, appendRows, checkClaimRow, countByClaim, explorerVerifiedFor,
  hashCell, parseClaimCell, publicRpcUrls, recorderRpc, renderRow, rowKey, sameCompiledCode, verifyClaim,
} from "../../src/recorder";
import type { ClaimInput, RecordedRow } from "../../src/recorder";
import { main as recordMain, chooseRpc, parseArgs } from "../../scripts/evidence/record";
import { main as checkMain } from "../../scripts/evidence-check";
import { rejection } from "../helpers/assert";
import { USDC } from "../helpers";
import { makePayment, requirementsFor, verifyBody } from "../helpers/payments";
import { fundWallet, setQie, startStack, throwawayWallet } from "../helpers/stack";
import type { Stack } from "../helpers/stack";

const ROOT = join(__dirname, "..", "..");
const REAL_FILE = join(ROOT, "docs", "EVIDENCE.md");

describe("Recorder: what it is allowed to do", () => {
  it("lists only read-only methods, so nothing it sends can spend, sign or change anything", () => {
    expect([...RECORDER_READ_ONLY_METHODS].sort()).to.deep.equal([
      "eth_call", "eth_chainId", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode", "eth_getTransactionByHash", "eth_getTransactionReceipt",
    ]);
    for (const method of RECORDER_READ_ONLY_METHODS) expect(method).to.match(/^eth_(chainId|get|call$)/);
  });

  it("refuses every method that could send, sign or change something, before any request leaves", async () => {
    let sent = 0;
    const fetchImpl = (async () => {
      sent += 1;
      return new Response(JSON.stringify({ result: "0x1" }));
    }) as typeof fetch;
    const rpc = recorderRpc(["https://rpc1mainnet.qie.digital/"], fetchImpl);
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_accounts", "hardhat_setBalance", "evm_mine", "debug_traceTransaction"]) {
      expect((await rejection(rpc(method, []))).message, method).to.match(/method not allowed/);
    }
    expect(sent).to.equal(0);
    expect(await rpc("eth_chainId", [])).to.equal("0x1");
    expect(sent).to.equal(1);
  });

  it("tries the next endpoint when one fails, tells a transport failure from a refusal, and fails only when every endpoint has", async () => {
    const answers: Record<string, () => Response | Promise<Response>> = {
      "https://a.test/": () => { throw new TypeError("fetch failed"); },
      "https://b.test/": () => new Response("busy", { status: 503 }),
      "https://c.test/": () => new Response(JSON.stringify({ result: "0x7c6" })),
    };
    const used: string[] = [];
    const fetchImpl = (async (url: string) => { used.push(url); return answers[url]!(); }) as unknown as typeof fetch;
    const rpc = recorderRpc(["https://a.test/", "https://b.test/", "https://c.test/"], fetchImpl);
    expect(await rpc("eth_chainId", [])).to.equal("0x7c6");
    expect(used).to.deep.equal(["https://a.test/", "https://b.test/", "https://c.test/"]);
    used.length = 0;
    expect(await rpc("eth_chainId", [])).to.equal("0x7c6"); // it remembers the endpoint that answered
    expect(used).to.deep.equal(["https://c.test/"]);

    const dead = recorderRpc(["https://a.test/", "https://b.test/"], fetchImpl);
    expect(await rejection(dead("eth_chainId", []))).to.be.instanceOf(NetworkError);
    const refusing = recorderRpc(["https://r.test/"], (async () => new Response(JSON.stringify({ error: { code: -32000, message: "missing trie node" } }))) as typeof fetch);
    expect((await rejection(refusing("eth_getBalance", ["0x00", "0x1"]))).name).to.equal("Error");
    expect((await rejection(refusing("eth_getBalance", ["0x00", "0x1"]))).message).to.match(/refused/);
    expect(() => recorderRpc([])).to.throw();
  });

  it("names rpc1 to rpc5 of each network by default", () => {
    expect(publicRpcUrls("mainnet")).to.deep.equal([1, 2, 3, 4, 5].map((n) => `https://rpc${n}mainnet.qie.digital/`));
    expect(publicRpcUrls("testnet")[4]).to.equal("https://rpc5testnet.qie.digital/");
  });

  it("allows a top-up no larger than the facilitator's hard ceiling", () => {
    expect(RELAYED_START_MAX_TOPUP_WEI).to.equal(HARD_CAPS.maxTopUpWei);
  });

  it("knows seven claims", () => {
    expect([...CLAIM_TYPES]).to.deep.equal(["deploy", "verify-link", "settle-batch", "deposit", "relayed-start", "paid-call-settlement", "withdraw"]);
  });
});

describe("Recorder: the file", () => {
  const row = (over: Partial<RecordedRow> = {}): RecordedRow => ({
    network: "mainnet", date: "2026-12-01T10:00:00Z", event: "Deposited", hash: `0x${"ab".repeat(32)}`, block: "100", contract: getAddress(`0x${"11".repeat(20)}`),
    amount: "0.300000", who: getAddress(`0x${"22".repeat(20)}`), claim: "deposit", recheck: `pnpm evidence:check --hash 0x${"ab".repeat(32)}`, ...over,
  });
  const real = () => readFileSync(REAL_FILE, "utf8");

  it("is in the shape the recorder writes: both network tables have the Network, Claim and Re-check columns, and no rows", () => {
    const text = real();
    expect(parseEvidenceStrict(text)).to.deep.equal([]);
    expect(text).to.contain(`| ${[...EVIDENCE_COLUMNS, "Network", "Claim", "Re-check"].join(" | ")} |`);
  });

  it("renders a mainnet row with an explorer link, the network, the claim and the command that checks it again, and reads it back", () => {
    const out = appendRows(real(), [row()]);
    const rows = parseEvidenceStrict(out);
    expect(rows).to.have.length(1);
    expect(rows[0]).to.deep.include({ network: "mainnet", event: "Deposited", hash: row().hash, claim: "deposit", recheck: row().recheck });
    expect(renderRow(row())).to.contain(`[${row().hash}](https://mainnet.qie.digital/tx/${row().hash})`);
    expect(renderRow(row())).to.contain("| mainnet | deposit | `pnpm evidence:check --hash");
    // Only the lines of the one table changed.
    const a = real().split("\n");
    const b = out.split("\n");
    expect(b.length).to.equal(a.length + 1);
  });

  it("links a testnet row to nothing, since the testnet has no explorer this repository knows", () => {
    expect(hashCell(row({ network: "testnet" }))).to.equal(row().hash);
    const out = appendRows(real(), [row({ network: "testnet" })]);
    expect(parseEvidenceStrict(out).map((r) => r.network)).to.deep.equal(["testnet"]);
  });

  it("links a verify-link row to the contract's page", () => {
    const r = row({ event: "SourceVerified", claim: "verify-link", amount: "—" });
    expect(hashCell(r)).to.equal(`[${r.hash}](https://mainnet.qie.digital/address/${r.contract}?tab=contract)`);
    expect(parseEvidenceStrict(appendRows(real(), [r]))[0]?.hash).to.equal(r.hash);
  });

  it("refuses a duplicate and writes nothing", () => {
    const once = appendRows(real(), [row()]);
    expect(() => appendRows(once, [row()])).to.throw(RecordError, /already in the evidence file/);
    // The same transaction with another event, amount or claim is a different row.
    expect(parseEvidenceStrict(appendRows(once, [row({ amount: "0.400000" })]))).to.have.length(2);
    expect(rowKey(row())).to.equal(rowKey(row({ who: row().who.toLowerCase() })));
  });

  it("refuses a row that would sit in the wrong table: each network's rows go under its own heading only", () => {
    const out = appendRows(real(), [row({ network: "testnet" }), row()]);
    const rows = parseEvidenceStrict(out);
    expect(rows.map((r) => r.network).sort()).to.deep.equal(["mainnet", "testnet"]);
    // A mainnet row pasted under the testnet heading is a file nothing will read.
    const mainnetLine = renderRow(row());
    const swapped = real().replace(/(## Testnet \(chain 1983\)[\s\S]*?--- \|\n)/, `$1${mainnetLine}\n`);
    expect(() => parseEvidenceStrict(swapped)).to.throw(/labelled "mainnet" is in the testnet table/);
  });

  it("can never read a fork row, or a testnet row, as mainnet proof", () => {
    const forkLine = renderRow(row({ network: "fork" }));
    const intoMainnet = real().replace(/(## Mainnet \(chain 1990\)[\s\S]*?--- \|\n)/, `$1${forkLine}\n`);
    expect(() => parseEvidenceStrict(intoMainnet)).to.throw(/labelled "fork" is in the mainnet table/);
    expect(() => parseEvidence(intoMainnet)).to.throw(/labelled "fork"/);
    // The Network cell cannot be dropped to dodge the check: a table without the column is refused outright.
    const legacy = real().replace(/(## Mainnet \(chain 1990\)\n\n)[^\n]*\n[^\n]*\n/, `$1| ${EVIDENCE_COLUMNS.join(" | ")} |\n| ${EVIDENCE_COLUMNS.map(() => "---").join(" | ")} |\n| 2026-12-01T10:00:00Z | Deposited | 0x${"ab".repeat(32)} | 1 | 0x${"11".repeat(20)} | 0.300000 | 0x${"22".repeat(20)} |\n`);
    expect(parseEvidence(legacy)).to.have.length(1); // the original reader still reads it...
    expect(() => parseEvidenceStrict(legacy)).to.throw(/no Network column/); // ...and nothing that counts evidence accepts it
  });

  it("writes a fork row to a section of its own, which the evidence readers ignore", () => {
    const out = appendRows(real(), [row({ network: "fork" })]);
    expect(out).to.contain("## Fork (a local copy of QIE mainnet; never counted)");
    expect(parseEvidenceStrict(out)).to.deep.equal([]); // no mainnet row, no testnet row
    expect(appendRows(out, [row({ network: "fork", amount: "0.5" + "00000" })]).match(/## Fork/g)).to.have.length(1);
  });

  it("refuses to change a table in the original format that already has rows, and upgrades an empty one", () => {
    const header = `| ${EVIDENCE_COLUMNS.join(" | ")} |`;
    const sep = `| ${EVIDENCE_COLUMNS.map(() => "---").join(" | ")} |`;
    const empty = `## Mainnet (chain 1990)\n\n${header}\n${sep}\n\n## Testnet (chain 1983)\n\n${header}\n${sep}\n`;
    expect(parseEvidenceStrict(appendRows(empty, [row()]))).to.have.length(1);
    const withRow = `## Mainnet (chain 1990)\n\n${header}\n${sep}\n| a | b | c | d | e | f | g |\n`;
    expect(() => appendRows(withRow, [row()])).to.throw(RecordError, /original seven-column format/);
    expect(() => appendRows("# nothing here\n", [row()])).to.throw(RecordError, /no "## Mainnet/);
    expect(() => appendRows(real(), [])).to.throw(RecordError, /nothing to record/);
  });

  it("parses a claim cell, with its top-up or its tool, and nothing else", () => {
    const top = `0x${"cd".repeat(32)}`;
    expect(parseClaimCell("deposit")).to.deep.equal({ claim: "deposit" });
    expect(parseClaimCell(`relayed-start (top-up ${top})`)).to.deep.equal({ claim: "relayed-start", topup: top });
    expect(parseClaimCell("paid-call-settlement (tool dex_quote)")).to.deep.equal({ claim: "paid-call-settlement", tool: "dex_quote" });
    for (const bad of ["", "mint", "deposit (top-up nope)", "deposit (anything)", "Deposit"]) expect(parseClaimCell(bad), bad).to.equal(undefined);
  });

  it("counts rows per claim, mainnet only, and leaves rows about founder wallets out of the distinct counts", () => {
    const founder = getAddress(`0x${"99".repeat(20)}`);
    const rows: EvidenceRow[] = [
      { ...row(), claim: "deposit", recheck: "x" },
      { ...row({ who: getAddress(`0x${"33".repeat(20)}`) }), claim: "deposit", recheck: "x" },
      { ...row({ who: founder }), claim: "deposit", recheck: "x" },
      { ...row({ who: getAddress(`0x${"22".repeat(20)}`), amount: "0.1" + "00000" }), claim: "deposit", recheck: "x" }, // the same address again
      { ...row({ event: "Settled" }), claim: "paid-call-settlement (tool dex_quote)", recheck: "x" },
      { ...row({ network: "testnet" }), network: "testnet", claim: "deposit", recheck: "x" } as unknown as EvidenceRow,
    ].map((r) => r as EvidenceRow);
    const counts = Object.fromEntries(countByClaim(rows, new Set([founder.toLowerCase()])).map((c) => [c.claim, c]));
    expect(counts.deposit).to.deep.equal({ claim: "deposit", rows: 3, distinct: 2, excluded: 1 });
    expect(counts["paid-call-settlement"]).to.deep.equal({ claim: "paid-call-settlement", rows: 1, distinct: 1, excluded: 0 });
    expect(counts.withdraw).to.deep.equal({ claim: "withdraw", rows: 0, distinct: 0, excluded: 0 });
  });
});

describe("Recorder: against a local chain", function () {
  this.timeout(240_000);
  let s: Stack;
  let dir: string;
  let file: string;
  let payer: Wallet;
  let builder: Wallet;
  let router: string;
  const lines: string[] = [];

  const rpc = () => recorderRpc([s.rpcUrl]);
  const claim = (input: Omit<ClaimInput, "network" | "router"> & { router?: string }) => verifyClaim({ network: "fork", router, ...input } as ClaimInput, { rpc: rpc() });
  const refused = async (input: Omit<ClaimInput, "network" | "router"> & { router?: string; network?: ClaimInput["network"] }, why: RegExp) => {
    const error = await rejection(verifyClaim({ network: "fork", router, ...input } as ClaimInput, { rpc: rpc() }));
    expect(error, error.message).to.be.instanceOf(RecordError);
    expect(error.message).to.match(why);
  };
  /** Approves and deposits for a wallet that holds QIE, and returns the deposit's hash. */
  const deposit = async (who: Wallet, amount: bigint): Promise<string> => {
    const w = who.connect(s.provider);
    await (await (s.token.connect(w) as unknown as { approve: (a: string, n: bigint) => Promise<{ wait: () => Promise<unknown> }> }).approve(router, amount)).wait();
    const receipt = (await (await (s.router.connect(w) as unknown as { deposit: (n: bigint) => Promise<{ wait: () => Promise<{ hash: string }> }> }).deposit(amount)).wait()) as { hash: string };
    return receipt.hash;
  };
  const record = (args: string[]) => recordMain(["--network", "fork", "--router", router, "--rpc", s.rpcUrl, "--file", file, ...args], {}, { log: (l) => lines.push(l) });

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    router = s.routerAddress;
    dir = mkdtempSync(join(tmpdir(), "sluice-evidence-"));
    file = join(dir, "EVIDENCE.md");
    copyFileSync(REAL_FILE, file);
    payer = throwawayWallet();
    builder = throwawayWallet();
    lines.length = 0;
    await fundWallet(s, payer, USDC("10"), parseEther("1"));
    await setQie(builder.address, parseEther("1"));
  });
  afterEach(async () => {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
    await network.provider.send("evm_setAutomine", [true]);
  });

  it("accepts a genuine deposit, and records it with its amount, the payer and the command that checks it again", async () => {
    const hash = await deposit(payer, USDC("0.3"));
    const { rows, notes } = await claim({ claim: "deposit", hash });
    expect(notes).to.deep.equal([]);
    expect(rows).to.have.length(1);
    expect(rows[0]).to.deep.include({ network: "fork", event: "Deposited", hash, contract: getAddress(router), amount: "0.300000", who: payer.address, claim: "deposit" });
    expect(rows[0]?.recheck).to.equal(`pnpm evidence:check --hash ${hash}`);
    expect(rows[0]?.date).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("accepts a genuine withdrawal", async () => {
    await deposit(payer, USDC("1"));
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.5")));
    await s.facilitator.settle(verifyBody(m));
    await s.facilitator.flush();
    const tx = await (s.router.connect(builder.connect(s.provider)) as unknown as { withdraw: (n: bigint, to: string) => Promise<{ wait: () => Promise<{ hash: string }> }> }).withdraw(USDC("0.2"), builder.address);
    const hash = ((await tx.wait()) as { hash: string }).hash;
    const { rows } = await claim({ claim: "withdraw", hash });
    expect(rows[0]).to.deep.include({ event: "Withdrawn", amount: "0.200000", who: builder.address, claim: "withdraw" });
  });

  it("accepts a genuine facilitator batch: one row per settled intent, and the batch's size from the router's own events", async () => {
    await deposit(payer, USDC("2"));
    const other = throwawayWallet();
    await fundWallet(s, other, USDC("2"), parseEther("1"));
    await deposit(other, USDC("2"));
    for (const w of [payer, payer, other]) await s.facilitator.settle(verifyBody(await makePayment(s, w, w.address, requirementsFor(s, builder.address, USDC("0.01")))));
    const flushed = await s.facilitator.flush();
    expect(flushed).to.include({ submitted: 3, settled: 3 });
    const { rows, notes } = await claim({ claim: "settle-batch", hash: flushed.transaction as string });
    expect(rows.map((r) => r.who).sort()).to.deep.equal([payer.address, payer.address, other.address].sort());
    expect(rows.every((r) => r.event === "Settled" && r.amount === "0.010000" && r.claim === "settle-batch")).to.equal(true);
    expect(notes[0]).to.match(/a batch of 3: 3 settled, 0 skipped/);
  });

  it("reports an intent the router skipped as skipped, and does not record it as settled", async () => {
    await deposit(payer, USDC("1"));
    for (let i = 0; i < 3; i++) await s.facilitator.settle(verifyBody(await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.3")))));
    // Between queueing and sending, the payer takes most of the balance back, so the router can pay only two of the three.
    await (await (s.router.connect(payer.connect(s.provider)) as unknown as { refund: (n: bigint, to: string) => Promise<{ wait: () => Promise<unknown> }> }).refund(USDC("0.4"), payer.address)).wait();
    const flushed = await s.facilitator.flush();
    expect(flushed.settled).to.equal(2);
    const { rows, notes } = await claim({ claim: "settle-batch", hash: flushed.transaction as string });
    expect(rows).to.have.length(2);
    expect(notes[0]).to.match(/2 settled, 1 skipped/);
  });

  it("accepts a facilitator-submitted settlement as a paid call, for the tool it names, and refuses another tool", async () => {
    await deposit(payer, USDC("1"));
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.01"), "token_risk_check"));
    await s.facilitator.settle(verifyBody(m));
    const flushed = await s.facilitator.flush();
    const hash = flushed.transaction as string;
    const ok = await claim({ claim: "paid-call-settlement", hash, tool: "token_risk_check" });
    expect(ok.rows[0]).to.deep.include({ event: "Settled", who: payer.address, claim: "paid-call-settlement (tool token_risk_check)" });
    expect(ok.notes[0]).to.match(/not that a tool call took place/);
    expect((await claim({ claim: "paid-call-settlement", hash })).rows[0]?.claim).to.equal("paid-call-settlement");
    await refused({ claim: "paid-call-settlement", hash, tool: "dex_quote" }, /third party for the tool "dex_quote"/);
  });

  it("refuses a payer settling their own payment as a paid call: nobody else submitted it", async () => {
    await deposit(payer, USDC("1"));
    const w = payer.connect(s.provider);
    const m = await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.01")));
    const tx = await (s.router.connect(w) as unknown as { settle: (i: unknown, sig: string) => Promise<{ wait: () => Promise<{ hash: string }> }> }).settle(m.intent, m.signature);
    const hash = ((await tx.wait()) as { hash: string }).hash;
    await refused({ claim: "paid-call-settlement", hash }, /submitted by someone other than its payer, payee and signer/);
    await refused({ claim: "settle-batch", hash }, /not a call to the router's batchSettle/);
  });

  it("accepts a start from zero QIE: a top-up from another address, then the payer's own deposit", async () => {
    const poor = throwawayWallet();
    await fundWallet(s, poor, USDC("5")); // QUSDC and no QIE
    const gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
    const txs = await signOnboarding(poor, { router, asset: s.tokenAddress, amount: USDC("1"), nonce: 0, gasPrice });
    const out = await s.facilitator.onboard({ payer: poor.address, ...txs });
    expect(out.ok, out.detail).to.equal(true);
    const { rows, notes } = await claim({ claim: "relayed-start", hash: out.depositTx as string, topup: out.topUpTx as string });
    expect(rows[0]).to.deep.include({ event: "Deposited", who: poor.address, amount: "1.000000", claim: `relayed-start (top-up ${(out.topUpTx as string).toLowerCase()})` });
    expect(notes[0]).to.match(/QIE balance of the payer before the top-up: 0/);
    expect(ONBOARD_APPROVE_GAS + ONBOARD_DEPOSIT_GAS).to.be.greaterThan(0n);
    // The same deposit without its top-up is not a start from zero QIE.
    await refused({ claim: "relayed-start", hash: out.depositTx as string }, /needs the top-up's transaction hash/);
    // A top-up that went to someone else shows nothing about this payer.
    const elsewhere = throwawayWallet();
    await setQie(elsewhere.address, 1n);
    const unrelated = await (await s.facilitator.relayer.sendTopUp(throwawayWallet().address, 100_000_000_000_000n)).hash;
    await refused({ claim: "relayed-start", hash: out.depositTx as string, topup: unrelated }, /not sent to the payer/);
  });

  it("refuses a start that was not from zero QIE: the payer held QIE before the top-up", async () => {
    const holder = throwawayWallet();
    await fundWallet(s, holder, USDC("5"), parseEther("1")); // holds QIE already
    const gasPrice = (await s.provider.getFeeData()).gasPrice as bigint;
    const txs = await signOnboarding(holder, { router, asset: s.tokenAddress, amount: USDC("1"), nonce: 0, gasPrice });
    await setQie(holder.address, 0n);
    const topped = await s.facilitator.onboard({ payer: holder.address, ...txs });
    expect(topped.ok, topped.detail).to.equal(true);
    // Give the payer QIE before a second top-up lands: the balance before it is not zero.
    await setQie(holder.address, parseEther("1"));
    const extra = await s.facilitator.relayer.sendTopUp(holder.address, 100_000_000_000_000n);
    const second = await deposit(holder, USDC("0.5"));
    await refused({ claim: "relayed-start", hash: second, topup: extra.hash }, /held QIE before the top-up/);
  });

  it("accepts a genuine deployment: the compiled router's code, answering like a Sluice router", async () => {
    const hash = (s.router as unknown as { deploymentTransaction: () => { hash: string } | null }).deploymentTransaction()?.hash as string;
    expect(hash).to.match(/^0x[0-9a-f]{64}$/);
    const { rows, notes } = await claim({ claim: "deploy", hash, router: undefined });
    expect(rows[0]).to.deep.include({ event: "Deployed", contract: getAddress(router), amount: "—", claim: "deploy" });
    expect(notes[0]).to.match(/compiled router's length and metadata hash/);
    // It must be a deployment, and of the router.
    await refused({ claim: "deploy", hash: await deposit(payer, USDC("0.1")), router: undefined }, /did not create a contract/);
    const token = (s.token as unknown as { deploymentTransaction: () => { hash: string } | null }).deploymentTransaction()?.hash as string;
    await refused({ claim: "deploy", hash: token, router: undefined }, /does not answer like a Sluice router/);
  });

  it("compares deployed code with compiled code by length and metadata hash, which immutable values do not change", () => {
    const meta = "a264697066735822" + "12".repeat(34) + "64736f6c63430008180033";
    const compiled = `0x6080${"00".repeat(100)}${meta}`;
    const deployed = `0x6080${"ab".repeat(100)}${meta}`; // immutables filled in: different bytes, same length and metadata
    expect(sameCompiledCode(deployed, compiled)).to.equal(true);
    expect(sameCompiledCode(`${deployed}00`, compiled)).to.equal(false);
    expect(sameCompiledCode(deployed.replace(meta, "a264697066735822" + "34".repeat(34) + "64736f6c63430008180033"), compiled)).to.equal(false);
    expect(sameCompiledCode("0x", "0x")).to.equal(false);
  });

  it("records a verify-link only when the explorer says the source is verified", async () => {
    const hash = (s.router as unknown as { deploymentTransaction: () => { hash: string } | null }).deploymentTransaction()?.hash as string;
    const asked: string[] = [];
    const yes = await verifyClaim({ claim: "verify-link", network: "fork", hash }, { rpc: rpc(), explorerVerified: async (a) => { asked.push(a); return true; } });
    expect(yes.rows[0]).to.deep.include({ event: "SourceVerified", contract: getAddress(router), hash, claim: "verify-link", amount: "—" });
    expect(asked).to.deep.equal([getAddress(router)]);
    const error = await rejection(verifyClaim({ claim: "verify-link", network: "fork", hash }, { rpc: rpc(), explorerVerified: async () => false }));
    expect(error.message).to.match(/does not show verified source/);
  });

  describe("refuses what the chain does not show, and writes nothing", () => {
    it("the wrong event: a withdrawal claimed for a deposit, a deposit claimed for a withdrawal", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      await refused({ claim: "withdraw", hash }, /no Withdrawn event/);
      await refused({ claim: "paid-call-settlement", hash }, /no Settled event/);
    });

    it("a transaction that failed", async () => {
      await network.provider.send("evm_setAutomine", [false]);
      const w = builder.connect(s.provider);
      const tx = await (s.router.connect(w) as unknown as { withdraw: (n: bigint, to: string, o: object) => Promise<{ hash: string }> }).withdraw(USDC("5"), w.address, { gasLimit: 300_000 }); // nothing to withdraw: it reverts
      await network.provider.send("evm_mine", []);
      await network.provider.send("evm_setAutomine", [true]);
      const receipt = await s.provider.getTransactionReceipt(tx.hash);
      expect(receipt?.status, "the transaction was mined and failed").to.equal(0);
      await refused({ claim: "withdraw", hash: tx.hash }, /transaction failed/);
    });

    it("a transaction that does not exist, a malformed hash, and a transaction hash from another network", async () => {
      await refused({ claim: "deposit", hash: `0x${"00".repeat(32)}` }, /was not found/);
      await refused({ claim: "deposit", hash: "0x1234" }, /0x followed by 64 hex/);
      const hash = await deposit(payer, USDC("0.3"));
      const wrong = await rejection(verifyClaim({ claim: "deposit", network: "testnet", hash, router }, { rpc: rpc() }));
      expect(wrong.message).to.match(/wrong network: testnet is chain 1983, but the RPC says 0x7c6/);
    });

    it("an address that is not a Sluice router, and a router that is missing", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      await refused({ claim: "deposit", hash, router: s.tokenAddress }, /does not answer like a Sluice router/);
      await refused({ claim: "deposit", hash, router: throwawayWallet().address }, /no contract at the router address/);
      // A contract that does answer domainSeparator(), with a value that is not this router's domain on this chain: code that returns 32
      // arbitrary bytes to any call. Its answer is read and compared, not just checked for being there.
      const impostor = throwawayWallet().address;
      await network.provider.send("hardhat_setCode", [impostor, `0x7f${"ab".repeat(32)}60005260206000f3`]);
      await refused({ claim: "deposit", hash, router: impostor }, /does not answer like a Sluice router on this chain/);
      await refused({ claim: "deposit", hash, router: undefined as unknown as string }, /needs the router's address/);
    });

    it("an unknown claim type", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      const error = await rejection(verifyClaim({ claim: "mint" as never, network: "fork", hash, router }, { rpc: rpc() }));
      expect(error.message).to.match(/one of deploy, verify-link/);
    });
  });

  describe("the command", () => {
    it("records a genuine deposit in the file it is given, and checking it again passes", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      expect(await record(["--claim", "deposit", "--tx", hash])).to.equal(0);
      expect(lines.join("\n")).to.contain("recorded 1 row for the deposit claim on fork");
      expect(lines.join("\n")).to.contain(`check it again any time with: pnpm evidence:check --hash ${hash}`);
      const text = readFileSync(file, "utf8");
      expect(text).to.contain("## Fork (a local copy of QIE mainnet; never counted)");
      expect(text).to.contain("| fork | deposit |");
      // The real evidence file is not the file it wrote to, and has no row.
      expect(parseEvidenceStrict(readFileSync(REAL_FILE, "utf8"))).to.deep.equal([]);
    });

    it("writes nothing when the claim does not hold: the file is byte for byte what it was", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      const before = readFileSync(file, "utf8");
      expect(await record(["--claim", "withdraw", "--tx", hash])).to.equal(1);
      expect(lines.join("\n")).to.match(/refused: .*no Withdrawn event.*Nothing was written/);
      expect(readFileSync(file, "utf8")).to.equal(before);
    });

    it("refuses a duplicate, and leaves the file as the first recording made it", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      expect(await record(["--claim", "deposit", "--tx", hash])).to.equal(0);
      const once = readFileSync(file, "utf8");
      lines.length = 0;
      expect(await record(["--claim", "deposit", "--tx", hash])).to.equal(1);
      expect(lines.join("\n")).to.contain("already in the evidence file");
      expect(readFileSync(file, "utf8")).to.equal(once);
    });

    it("shows the rows and writes nothing with --dry-run", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      const before = readFileSync(file, "utf8");
      expect(await record(["--claim", "deposit", "--tx", hash, "--dry-run"])).to.equal(0);
      expect(lines.join("\n")).to.contain("dry run: nothing was written");
      expect(readFileSync(file, "utf8")).to.equal(before);
    });

    it("refuses to write a fork run to docs/EVIDENCE.md, and a fork run without a file of its own", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      // A stand-in for docs/EVIDENCE.md, so that a recorder that wrongly wrote there would write into a copy and never into the real file.
      const pretend = join(dir, "pretend-docs-EVIDENCE.md");
      copyFileSync(REAL_FILE, pretend);
      const before = readFileSync(pretend, "utf8");
      const run = (extra: string[]) =>
        recordMain(["--claim", "deposit", "--tx", hash, "--network", "fork", "--router", router, "--rpc", s.rpcUrl, ...extra], {}, { log: (l) => lines.push(l), evidencePath: pretend });
      expect(await run([])).to.equal(1);
      expect(lines.join("\n")).to.match(/needs --file/);
      expect(await run(["--file", pretend])).to.equal(1);
      expect(lines.join("\n")).to.match(/never written to docs\/EVIDENCE\.md/);
      expect(readFileSync(pretend, "utf8")).to.equal(before);
    });

    it("refuses to record a local node as mainnet or testnet, a custom host without the flag, and plain http", () => {
      expect(() => chooseRpc("mainnet", [s.rpcUrl], false)).to.throw(/labelled fork and is never recorded as evidence/);
      expect(() => chooseRpc("mainnet", [s.rpcUrl], true)).to.throw(/labelled fork/);
      expect(() => chooseRpc("testnet", ["https://rpc.example.com/"], false)).to.throw(/not a qie\.digital address/);
      expect(chooseRpc("testnet", ["https://rpc.example.com/"], true)).to.deep.equal(["https://rpc.example.com/"]);
      expect(() => chooseRpc("mainnet", ["http://rpc.example.com/"], true)).to.throw(/https/);
      expect(() => chooseRpc("fork", [], false)).to.throw(/--rpc/);
      expect(() => chooseRpc("fork", ["https://rpc1mainnet.qie.digital/"], false)).to.throw(/on this machine/);
      expect(chooseRpc("mainnet", [], false)).to.have.length(5);
      expect(chooseRpc("mainnet", ["https://rpc3mainnet.qie.digital/"], false)).to.deep.equal(["https://rpc3mainnet.qie.digital/"]);
    });

    it("says it could not read the chain, and exits 2, when no endpoint answers", async () => {
      const code = await recordMain(["--claim", "deposit", "--tx", `0x${"11".repeat(32)}`, "--network", "fork", "--router", router, "--rpc", "http://127.0.0.1:1", "--file", file], {}, { log: (l) => lines.push(l) });
      expect(code).to.equal(2);
      expect(lines.join("\n")).to.match(/nothing was verified and nothing was written/);
    });

    it("rejects bad arguments with a reason and exit 1", async () => {
      const bad = async (args: string[], why: RegExp) => {
        lines.length = 0;
        expect(await recordMain(args, {}, { log: (l) => lines.push(l) })).to.equal(1);
        expect(lines.join("\n")).to.match(why);
      };
      await bad([], /--claim must be one of/);
      await bad(["--claim", "deposit"], /--tx is needed/);
      await bad(["--claim", "deposit", "--tx", `0x${"11".repeat(32)}`], /--network must be/);
      await bad(["--claim", "deposit", "--tx", `0x${"11".repeat(32)}`, "--network", "devnet"], /--network must be/);
      await bad(["--claim", "deposit", "--tx"], /needs a value/);
      await bad(["--claim", "deposit", "--tx", `0x${"11".repeat(32)}`, "--bogus"], /unknown option --bogus/);
      expect(parseArgs(["--rpc", "a", "--rpc", "b", "--dry-run", "--allow-custom-rpc"])).to.deep.include({ rpc: ["a", "b"], dryRun: true, allowCustomRpc: true });
    });

    it("takes the network and the router from the environment", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      const code = await recordMain(["--claim", "deposit", "--tx", hash, "--rpc", s.rpcUrl, "--file", file], { SLUICE_NETWORK: "fork", SLUICE_ROUTER: router }, { log: (l) => lines.push(l) });
      expect(code).to.equal(0);
    });
  });

  describe("checking a recorded row again", () => {
    const mainnetRowFor = async (hash: string, over: Partial<RecordedRow> = {}): Promise<EvidenceRow> => {
      const { rows } = await claim({ claim: "deposit", hash });
      return { ...(rows[0] as RecordedRow), network: "mainnet", ...over } as unknown as EvidenceRow;
    };

    it("passes a row the chain still shows, fails one whose column was changed, and skips when the chain cannot be read", async () => {
      const hash = await deposit(payer, USDC("0.3"));
      const row = await mainnetRowFor(hash, { network: "fork" as never });
      const deps = { rpc: rpc() };
      // The row is about a fork, so it is checked as one: the same code, the same chain.
      expect((await checkClaimRow({ ...row, network: "fork" as never }, deps)).status).to.equal("PASS");
      expect((await checkClaimRow({ ...row, network: "fork" as never, amount: "0.300001" }, deps)).status).to.equal("FAIL");
      expect((await checkClaimRow({ ...row, network: "fork" as never, who: throwawayWallet().address }, deps)).status).to.equal("FAIL");
      expect((await checkClaimRow({ ...row, network: "fork" as never, block: "1" }, deps)).status).to.equal("FAIL");
      expect((await checkClaimRow({ ...row, network: "fork" as never, date: "2020-01-01T00:00:00Z" }, deps)).status).to.equal("FAIL");
      expect((await checkClaimRow({ ...row, network: "fork" as never, claim: "mint" }, deps)).detail).to.match(/unknown claim/);
      const down = recorderRpc(["http://127.0.0.1:1"]);
      expect((await checkClaimRow({ ...row, network: "fork" as never }, { rpc: down })).status).to.equal("SKIPPED");
    });

    it("fails a mainnet row on a chain that is not mainnet, even when everything else matches", async () => {
      // The local chain has mainnet's chain id, but its router holds a test token, which a mainnet row must not.
      const hash = await deposit(payer, USDC("0.3"));
      const row = await mainnetRowFor(hash);
      const result = await checkClaimRow(row, { rpc: rpc() });
      expect(result.status).to.equal("FAIL");
      expect(result.detail).to.match(/on mainnet the router must hold QUSDC/);
    });

    it("pnpm evidence:check --hash checks the rows for one transaction, and says when none has it", async () => {
      const text = readFileSync(REAL_FILE, "utf8");
      const evidence = join(dir, "check.md");
      writeFileSync(evidence, text);
      const out: string[] = [];
      expect(await checkMain(["--hash", `0x${"12".repeat(32)}`], {}, (l) => out.push(l), evidence)).to.equal(1);
      expect(out.join("\n")).to.match(/No row in docs\/EVIDENCE\.md has the transaction/);
      expect(await checkMain(["--hash", "nope"], {}, () => undefined, evidence)).to.equal(1);
      out.length = 0;
      expect(await checkMain([], {}, (l) => out.push(l), evidence)).to.equal(0);
      expect(out.join("\n")).to.contain("nothing is claimed as live");
      writeFileSync(evidence, "## Mainnet (chain 1990)\n\n| Date (UTC) | Event |\n| --- | --- |\n");
      expect(await checkMain([], {}, (l) => out.push(l), evidence)).to.equal(1);
    });
  });
});

describe("Recorder: the explorer", function () {
  this.timeout(30_000);
  const serve = async (answer: (path: string) => { status: number; body: unknown }) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      const r = answer(req.url ?? "");
      res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, paths, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  };
  const address = getAddress(`0x${"77".repeat(20)}`);

  it("says verified when Blockscout's contract record says so, with a GET only", async () => {
    const e = await serve(() => ({ status: 200, body: { is_verified: true, name: "PaymentRouter" } }));
    try {
      expect(await explorerVerifiedFor(e.url)(address)).to.equal(true);
      expect(e.paths).to.deep.equal([`/api/v2/smart-contracts/${address}`]);
    } finally {
      await e.close();
    }
  });

  it("says not verified for a contract the explorer has no source for, and for an explorer that errors or is down", async () => {
    const none = await serve(() => ({ status: 404, body: { message: "Not found" } }));
    try {
      expect(await explorerVerifiedFor(none.url)(address)).to.equal(false);
      expect(none.paths.length).to.equal(2); // the v2 record, then the second opinion
    } finally {
      await none.close();
    }
    const broken = await serve(() => ({ status: 500, body: "nope" }));
    try {
      expect(await explorerVerifiedFor(broken.url)(address)).to.equal(false);
    } finally {
      await broken.close();
    }
    expect(await explorerVerifiedFor("http://127.0.0.1:1")(address)).to.equal(false);
  });

  it("takes the Etherscan-style answer as a second opinion, and refuses 'not verified' in it", async () => {
    const legacy = await serve((path) => path.startsWith("/api/v2") ? { status: 404, body: {} } : { status: 200, body: { result: [{ SourceCode: "contract X {}", ABI: "[]" }] } });
    try {
      expect(await explorerVerifiedFor(legacy.url)(address)).to.equal(true);
    } finally {
      await legacy.close();
    }
    const unverified = await serve((path) => path.startsWith("/api/v2") ? { status: 404, body: {} } : { status: 200, body: { result: [{ SourceCode: "", ABI: "Contract source code not verified" }] } });
    try {
      expect(await explorerVerifiedFor(unverified.url)(address)).to.equal(false);
    } finally {
      await unverified.close();
    }
  });

  it("only talks to the explorer it was built for, over https or this machine", () => {
    expect(() => explorerVerifiedFor("http://explorer.example.com")).to.throw(/https/);
    expect(() => explorerVerifiedFor("https://mainnet.qie.digital")).to.not.throw();
  });
});
