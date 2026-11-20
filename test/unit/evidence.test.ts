// The proof harness, tested against a fake chain. A row must PASS only when the chain agrees with every
// column, and every other outcome must be FAIL or SKIPPED, never PASS.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect } from "chai";
import { artifacts } from "hardhat";
import { Interface } from "ethers";
import { EVENTS } from "../../src/events";
import {
  checkAll,
  checkRow,
  checkShape,
  EVIDENCE_COLUMNS,
  exitCodeFor,
  jsonRpc,
  NetworkError,
  NETWORKS,
  parseEvidence,
  parseEvidenceStrict,
  READ_ONLY_METHODS,
} from "../../src/evidence";
import type { EvidenceRow, Rpc } from "../../src/evidence";
import { formatQusdc, parseQusdc } from "../../src/units";

const ROUTER = "0xA1A1A1a1A1a1A1a1a1a1A1a1A1a1a1A1a1A1A1A1";
const VAULT = "0xB2b2B2B2b2B2B2b2B2B2b2b2b2B2b2B2B2B2B2b2";
const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;
const BLOCK = 12_345;
const TIMESTAMP = 1_790_000_000n;
const DATE = new Date(Number(TIMESTAMP) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function logFor(event: string, values: unknown[], address: string) {
  const spec = EVENTS[event]!;
  const iface = new Interface([spec.fragment]);
  const { data, topics } = iface.encodeEventLog(iface.getEvent(event)!, values);
  return { address: address.toLowerCase(), topics, data };
}
const deposited = (account = PAYER, amount = 1_500_000n, address = ROUTER) =>
  logFor("Deposited", [account, OTHER, amount], address);

type Fake = {
  chainId?: string;
  receipt?: unknown;
  block?: unknown;
  throws?: Error;
  calls?: string[];
};
function fakeChain(f: Fake = {}): Rpc {
  return async (method) => {
    f.calls?.push(method);
    if (f.throws) throw f.throws;
    switch (method) {
      case "eth_chainId":
        return f.chainId ?? "0x7c6"; // 1990
      case "eth_getTransactionReceipt":
        return "receipt" in f
          ? f.receipt
          : { status: "0x1", blockNumber: `0x${BLOCK.toString(16)}`, logs: [deposited()] };
      case "eth_getBlockByNumber":
        return "block" in f ? f.block : { timestamp: `0x${TIMESTAMP.toString(16)}` };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}

const row = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  network: "mainnet",
  date: DATE,
  event: "Deposited",
  hash: HASH,
  block: String(BLOCK),
  contract: ROUTER,
  amount: "1.500000",
  who: PAYER,
  ...over,
});

const receiptWith = (logs: unknown[], over: Record<string, unknown> = {}) => ({
  status: "0x1",
  blockNumber: `0x${BLOCK.toString(16)}`,
  logs,
  ...over,
});

describe("Evidence: reading the tables", () => {
  const table = (network: string, rows: string[] = []) =>
    [`## ${network}`, "", `| ${EVIDENCE_COLUMNS.join(" | ")} |`, `|${EVIDENCE_COLUMNS.map(() => "---").join("|")}|`, ...rows, ""].join("\n");
  const line = (r: EvidenceRow) =>
    `| ${[r.date, r.event, r.hash, r.block, r.contract, r.amount, r.who].join(" | ")} |`;

  it("has exactly these seven columns, in this order", () => {
    expect(EVIDENCE_COLUMNS).to.deep.equal([
      "Date (UTC)",
      "Event",
      "Transaction hash",
      "Block",
      "Contract",
      "Amount",
      "Who",
    ]);
  });

  it("reads empty tables as no rows", () => {
    expect(parseEvidence(`${table("Mainnet (chain 1990)")}\n${table("Testnet (chain 1983)")}`)).to.deep.equal([]);
  });

  it("reads rows and files each under the network of its heading", () => {
    const md = `${table("Mainnet (chain 1990)", [line(row())])}\n${table("Testnet (chain 1983)", [line(row({ hash: `0x${"cd".repeat(32)}` }))])}`;
    const rows = parseEvidence(md);
    expect(rows.map((r) => r.network)).to.deep.equal(["mainnet", "testnet"]);
    expect(rows[0]).to.deep.equal(row());
  });

  it("ignores tables and text outside the two network sections", () => {
    const md = `# Evidence\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${table("Mainnet (chain 1990)", [line(row())])}\n## Notes\n\n| x | y |\n|---|---|\n| 1 | 2 |\n`;
    expect(parseEvidence(md)).to.have.length(1);
  });

  it("refuses a table with the wrong columns, a missing column or the columns in another order", () => {
    const bad = (cols: string[]) => `## Mainnet\n\n| ${cols.join(" | ")} |\n|---|\n`;
    expect(() => parseEvidence(bad(EVIDENCE_COLUMNS.slice(0, 6) as unknown as string[]))).to.throw(/exactly the columns/);
    expect(() => parseEvidence(bad([...EVIDENCE_COLUMNS].reverse()))).to.throw(/exactly the columns/);
    expect(() => parseEvidence(bad(["Date", ...EVIDENCE_COLUMNS.slice(1)]))).to.throw(/exactly the columns/);
  });

  it("refuses a row with the wrong number of cells rather than skipping it", () => {
    const md = table("Mainnet (chain 1990)", [`| ${DATE} | Deposited | ${HASH} |`]);
    expect(() => parseEvidence(md)).to.throw(/malformed evidence row/);
  });

  it("reads the real docs/EVIDENCE.md (or fails loudly if it is malformed)", () => {
    const real = readFileSync(join(__dirname, "..", "..", "docs", "EVIDENCE.md"), "utf8");
    const rows = parseEvidenceStrict(real);
    // Deployed and SourceVerified are claims about a contract, not contract events, so the event-shape check is for the other rows.
    for (const r of rows.filter((x) => x.event !== "Deployed" && x.event !== "SourceVerified")) expect(checkShape(r), `${r.event} ${r.hash}`).to.equal(undefined);
  });
});

describe("Evidence: the shape of a row", () => {
  it("accepts a well-formed row of every event", () => {
    expect(checkShape(row())).to.equal(undefined);
    expect(checkShape(row({ event: "SessionRevoked", amount: "—" }))).to.equal(undefined);
    expect(checkShape(row({ event: "SessionAuthorized", amount: "5.000000" }))).to.equal(undefined);
  });

  const bad: Array<[string, Partial<EvidenceRow>, RegExp]> = [
    ["a date without the Z", { date: "2026-12-01T10:00:00" }, /date must look like/],
    ["a date with no time", { date: "2026-12-01" }, /date must look like/],
    ["an unknown event", { event: "Transfer" }, /unknown event/],
    ["a short hash", { hash: "0x1234" }, /transaction hash/],
    ["a hash without 0x", { hash: "ab".repeat(32) }, /transaction hash/],
    ["a block that is not a number", { block: "12,345" }, /block must be a whole number/],
    ["a contract that is not an address", { contract: "router" }, /contract must be an address/],
    ["who that is not an address", { who: "alice" }, /who must be an address/],
    ["an amount with fewer than six decimals", { amount: "1.5" }, /exact decimal with six places/],
    ["an amount with a comma", { amount: "1,500000" }, /exact decimal with six places/],
    ["an amount with a currency sign", { amount: "$1.500000" }, /exact decimal with six places/],
    ["an amount on an event that has none", { event: "SessionRevoked", amount: "1.000000" }, /has no amount/],
  ];
  for (const [name, over, message] of bad) {
    it(`rejects ${name}`, () => expect(checkShape(row(over))).to.match(message));
  }

  it("never reaches the network for a malformed row", async () => {
    const calls: string[] = [];
    const result = await checkRow(row({ hash: "0x12" }), fakeChain({ calls }));
    expect(result.status).to.equal("FAIL");
    expect(calls).to.deep.equal([]);
  });
});

describe("Evidence: a row against the chain", () => {
  it("PASSES when the chain agrees with every column", async () => {
    const result = await checkRow(row(), fakeChain());
    expect(result).to.deep.equal({ status: "PASS", detail: `Deposited confirmed in block ${BLOCK}` });
  });

  it("matches addresses regardless of letter case", async () => {
    expect((await checkRow(row({ contract: ROUTER.toLowerCase(), who: PAYER.toUpperCase().replace("0X", "0x") }), fakeChain())).status).to.equal("PASS");
  });

  it("FAILS when the transaction is missing", async () => {
    const result = await checkRow(row(), fakeChain({ receipt: null }));
    expect(result).to.deep.equal({ status: "FAIL", detail: "transaction not found" });
  });

  it("FAILS when the transaction failed", async () => {
    const result = await checkRow(row(), fakeChain({ receipt: receiptWith([deposited()], { status: "0x0" }) }));
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/failed/);
  });

  it("FAILS when the RPC is on another chain", async () => {
    const result = await checkRow(row(), fakeChain({ chainId: "0x1" }));
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/wrong chain: expected 1990/);
    // A testnet row is checked against chain 1983, not 1990.
    expect((await checkRow(row({ network: "testnet" }), fakeChain())).detail).to.match(/wrong chain: expected 1983/);
    expect((await checkRow(row({ network: "testnet" }), fakeChain({ chainId: "0x7bf" }))).status).to.equal("PASS");
  });

  it("FAILS when the block differs", async () => {
    const result = await checkRow(row({ block: String(BLOCK + 1) }), fakeChain());
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/block differs/);
  });

  it("FAILS when the date differs, even by one second", async () => {
    const off = new Date((Number(TIMESTAMP) + 1) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const result = await checkRow(row({ date: off }), fakeChain());
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/date differs/);
    expect((await checkRow(row(), fakeChain({ block: null }))).detail).to.equal("block not found");
  });

  it("FAILS when the event came from a different contract", async () => {
    const result = await checkRow(row({ contract: OTHER }), fakeChain());
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/wrong contract/);
    const fromElsewhere = receiptWith([deposited(PAYER, 1_500_000n, OTHER)]);
    expect((await checkRow(row(), fakeChain({ receipt: fromElsewhere }))).detail).to.match(/wrong contract/);
  });

  it("FAILS when the transaction has no such event", async () => {
    const settled = logFor("Settled", [PAYER, OTHER, HASH, 1_500_000n, 0n, HASH, PAYER], ROUTER);
    const result = await checkRow(row(), fakeChain({ receipt: receiptWith([settled]) }));
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/no Deposited event/);
    expect((await checkRow(row(), fakeChain({ receipt: receiptWith([]) }))).status).to.equal("FAIL");
  });

  it("FAILS when the amount differs, by even one unit, or is 1000 times out", async () => {
    for (const amount of ["1.500001", "1.499999", "1500.000000", "0.001500"]) {
      const result = await checkRow(row({ amount }), fakeChain());
      expect(result.status, amount).to.equal("FAIL");
      expect(result.detail).to.match(/different amount: row \d+ units, chain 1500000/);
    }
  });

  it("FAILS when the event is about someone else", async () => {
    const result = await checkRow(row({ who: OTHER }), fakeChain());
    expect(result.status).to.equal("FAIL");
    expect(result.detail).to.match(/no Deposited event for/);
  });

  it("finds the right event among many in one transaction (a batch)", async () => {
    const logs = [deposited(OTHER, 7n), deposited(PAYER, 1_500_000n), deposited(OTHER, 9n)];
    expect((await checkRow(row(), fakeChain({ receipt: receiptWith(logs) }))).status).to.equal("PASS");
    // The amount must belong to the same event as the actor, not be borrowed from a neighbour.
    expect((await checkRow(row({ amount: "0.000007" }), fakeChain({ receipt: receiptWith(logs) }))).status).to.equal("FAIL");
  });

  it("checks each kind of event on its own fields", async () => {
    const cases: Array<[string, unknown[], string, string, string]> = [
      ["Settled", [PAYER, OTHER, HASH, 2_000_000n, 20_000n, HASH, PAYER], ROUTER, "2.000000", PAYER],
      ["Withdrawn", [PAYER, OTHER, 3_000_000n, OTHER, 5n], ROUTER, "3.000000", PAYER],
      ["Refunded", [PAYER, OTHER, 4_000_000n, OTHER, 0n], ROUTER, "4.000000", PAYER],
      ["SessionAuthorized", [PAYER, OTHER, 1n, 5_000_000n, 1_000_000n, 1_800_000_000n, HASH], VAULT, "5.000000", PAYER],
      ["SessionRevoked", [PAYER, OTHER, 1n], VAULT, "—", PAYER],
    ];
    for (const [event, values, contract, amount, who] of cases) {
      const receipt = receiptWith([logFor(event, values, contract)]);
      expect((await checkRow(row({ event, contract, amount, who }), fakeChain({ receipt }))).status, event).to.equal("PASS");
      expect((await checkRow(row({ event, contract: ROUTER === contract ? VAULT : ROUTER, amount, who }), fakeChain({ receipt }))).status, `${event} wrong contract`).to.equal("FAIL");
      if (amount !== "—") {
        expect((await checkRow(row({ event, contract, amount: "9.000000", who }), fakeChain({ receipt }))).status, `${event} wrong amount`).to.equal("FAIL");
      }
    }
  });

  it("reports a network problem as SKIPPED, never as PASS or FAIL", async () => {
    const result = await checkRow(row(), fakeChain({ throws: new NetworkError("network unavailable") }));
    expect(result).to.deep.equal({ status: "SKIPPED", detail: "network: network unavailable" });
  });

  it("reports an unexpected response as SKIPPED too, without leaking the response", async () => {
    const result = await checkRow(row(), fakeChain({ receipt: { status: "0x1", blockNumber: "not-a-number", logs: [] } }));
    expect(result.status).to.equal("SKIPPED");
    expect((await checkRow(row(), fakeChain({ throws: new Error("secret-token-123") }))).detail).to.equal("network: unexpected response");
  });
});

describe("Evidence: totals and the exit code", () => {
  const rpcFor = () => fakeChain();
  it("counts passes, fails and skips, and names every row in the output", async () => {
    const rows = [row(), row({ amount: "9.000000" }), row({ hash: "0xbad" })];
    const summary = await checkAll(rows, rpcFor);
    expect([summary.pass, summary.fail, summary.skipped]).to.deep.equal([1, 2, 0]);
    expect(summary.lines).to.have.length(3);
    expect(summary.lines[0]).to.match(/^PASS\s+mainnet Deposited 0xab/);
  });

  it("exits 0 for no rows or all passes, 1 for any failure, 2 when only skips stop it passing", () => {
    expect(exitCodeFor({ pass: 0, fail: 0, skipped: 0, lines: [] })).to.equal(0);
    expect(exitCodeFor({ pass: 3, fail: 0, skipped: 0, lines: [] })).to.equal(0);
    expect(exitCodeFor({ pass: 2, fail: 1, skipped: 1, lines: [] })).to.equal(1);
    expect(exitCodeFor({ pass: 2, fail: 0, skipped: 1, lines: [] })).to.equal(2);
  });

  it("uses the public QIE RPC addresses and chain ids", () => {
    expect(NETWORKS.mainnet).to.include({ chainId: 1990, rpc: "https://rpc1mainnet.qie.digital/" });
    expect(NETWORKS.testnet).to.include({ chainId: 1983, rpc: "https://rpc1testnet.qie.digital/" });
  });
});

describe("Evidence: the checker can only read", () => {
  it("allows exactly four read-only methods", () => {
    expect([...READ_ONLY_METHODS].sort()).to.deep.equal(
      ["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"].sort(),
    );
    for (const method of READ_ONLY_METHODS) expect(method).to.match(/^eth_(chainId|get)/);
  });

  it("refuses every method that could send, sign or change something, before any request leaves", async () => {
    let requests = 0;
    const rpc = jsonRpc("http://127.0.0.1:1", (async () => {
      requests += 1;
      throw new Error("must not be called");
    }) as unknown as typeof fetch);
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_accounts", "eth_call", "wallet_addEthereumChain", "debug_traceTransaction"]) {
      let error: unknown;
      try {
        await rpc(method, []);
      } catch (e) {
        error = e;
      }
      expect(String(error), method).to.match(/method not allowed/);
    }
    expect(requests).to.equal(0);
  });

  const respond = (status: number, body: string | object) =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("turns every transport problem into a NetworkError", async () => {
    const cases: Array<[string, typeof fetch]> = [
      ["offline", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
      ["HTTP 429", respond(429, "")],
      ["HTTP 502", respond(502, "")],
      ["not JSON", respond(200, "<html>")],
      ["a node error", respond(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } })],
    ];
    for (const [name, impl] of cases) {
      let error: unknown;
      try {
        await jsonRpc("http://x", impl)("eth_chainId", []);
      } catch (e) {
        error = e;
      }
      expect(error, name).to.be.instanceOf(NetworkError);
    }
  });

  it("returns the result, and null for a missing one", async () => {
    expect(await jsonRpc("http://x", respond(200, { jsonrpc: "2.0", id: 1, result: "0x7c6" }))("eth_chainId", [])).to.equal("0x7c6");
    expect(await jsonRpc("http://x", respond(200, { jsonrpc: "2.0", id: 1, result: null }))("eth_getTransactionReceipt", [HASH])).to.equal(null);
  });

  it("end to end over real HTTP: a passing row, a failing row, and only read-only methods on the wire", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { id, method } = JSON.parse(raw) as { id: number; method: string };
        seen.push(method);
        const result =
          method === "eth_chainId"
            ? "0x7c6"
            : method === "eth_getTransactionReceipt"
              ? receiptWith([deposited()])
              : { timestamp: `0x${TIMESTAMP.toString(16)}` };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const summary = await checkAll([row(), row({ amount: "2.000000" })], () => jsonRpc(url));
      expect([summary.pass, summary.fail, summary.skipped]).to.deep.equal([1, 1, 0]);
      expect(exitCodeFor(summary)).to.equal(1);
      expect(seen.length).to.be.greaterThan(0);
      for (const method of seen) expect(READ_ONLY_METHODS.has(method), method).to.equal(true);
    } finally {
      server.close();
    }
  });

  it("an unreachable node is SKIPPED and exits 2, not 0", async () => {
    const summary = await checkAll([row()], () => jsonRpc("http://127.0.0.1:1"));
    expect([summary.pass, summary.fail, summary.skipped]).to.deep.equal([0, 0, 1]);
    expect(exitCodeFor(summary)).to.equal(2);
  });
});

describe("Evidence: the command", function () {
  this.timeout(120_000);
  it("pnpm evidence:check exits 0 on the empty tables and says nothing is claimed as live", () => {
    const run = spawnSync(process.execPath, [require.resolve("ts-node/dist/bin.js"), "--transpile-only", "scripts/evidence-check.ts"], {
      cwd: join(__dirname, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, EVIDENCE_RPC_URL: "http://127.0.0.1:1" },
    });
    expect(run.stdout + run.stderr).to.match(/evidence:check \d+ row\(s\)/);
    const rows = parseEvidence(readFileSync(join(__dirname, "..", "..", "docs", "EVIDENCE.md"), "utf8"));
    if (rows.length === 0) {
      expect(run.status).to.equal(0);
      expect(run.stdout).to.contain("nothing is claimed as live");
    } else {
      expect(run.status, "an unreachable node must never yield exit 0 when there are rows").to.not.equal(0);
    }
  });
});

describe("Evidence: events match the compiled contracts", () => {
  const abiFor = async (which: "router" | "vault") =>
    new Interface((await artifacts.readArtifact(which === "router" ? "PaymentRouter" : "AgentVault")).abi);

  for (const [name, spec] of Object.entries(EVENTS)) {
    it(`${name}: the fragment equals the event in the ${spec.contract} contract, field for field`, async () => {
      const compiled = (await abiFor(spec.contract)).getEvent(name);
      expect(compiled, `${name} exists in ${spec.contract}`).to.not.equal(null);
      const written = new Interface([spec.fragment]).getEvent(name)!;
      expect(written.format("full")).to.equal(compiled!.format("full"));
      expect(written.topicHash).to.equal(compiled!.topicHash);
      const inputs = written.inputs;
      const who = inputs.find((i) => i.name === spec.whoField);
      expect(who?.type, "who field is an address").to.equal("address");
      expect(who?.indexed, "who field is indexed").to.equal(true);
      if (spec.amountField) expect(inputs.find((i) => i.name === spec.amountField)?.type).to.equal("uint256");
    });
  }

  it("only lists events the contracts really emit, and never one that is not about money or a session", () => {
    expect(Object.keys(EVENTS).sort()).to.deep.equal(["Deposited", "Refunded", "SessionAuthorized", "SessionRevoked", "Settled", "Withdrawn"]);
  });
});

describe("Units", () => {
  it("formats and parses QUSDC exactly, round trip", () => {
    expect(formatQusdc(10_000n)).to.equal("0.010000");
    expect(formatQusdc(0n)).to.equal("0.000000");
    expect(formatQusdc(1_234_567_890n)).to.equal("1234.567890");
    expect(parseQusdc("0.010000")).to.equal(10_000n);
    expect(parseQusdc("1234.567890")).to.equal(1_234_567_890n);
    for (const n of [0n, 1n, 999_999n, 1_000_000n, 123_456_789_012n]) expect(parseQusdc(formatQusdc(n))).to.equal(n);
  });

  it("refuses anything that is not an exact six-place decimal", () => {
    for (const bad of ["1", "1.5", "1.5000000", ".5", "-1.000000", "1e6", "1,000000", "", "0x10"]) {
      expect(() => parseQusdc(bad), bad).to.throw(/six decimals/);
    }
  });
});
