// Rendering and reading docs/GAS.md. The numbers come from test/fork/gas.fork.test.ts (a local fork of QIE
// mainnet); this module only turns them into a table and back, with exact integer arithmetic, so a plain unit
// test can recompute every cost in the file from the basis the file states.

const WEI_PER_QIE = 10n ** 18n;

/** The single operations the report must contain, in the order they appear. */
export const SINGLE_OPERATIONS = [
  "QUSDC transfer to a new holder (for comparison)",
  "QUSDC transfer to an existing holder (for comparison)",
  "Approve QUSDC for the router",
  "Deposit, first for this payer",
  "Deposit, later",
  "Settle, first payment to a builder",
  "Settle, later payment",
  "Withdraw, part of earnings",
  "Withdraw by signature, through a relayer",
  "Refund, part of the balance",
  "Refund by signature, through a relayer",
  "Authorize an agent, one tool",
  "Authorize an agent by signature, one tool",
  "QIE top-up transfer by a facilitator, for a wallet with no QIE",
  "Revoke an agent",
  "Settle signed by an agent, first spend",
  "Deploy the router (creates the vault)",
] as const;

/**
 * The gas limits a wallet signs for the start with no QIE (packages/sdk/src/onboarding.ts: ONBOARD_APPROVE_GAS and
 * ONBOARD_DEPOSIT_GAS). A test checks that these equal the SDK's, so the report cannot quote a stale limit.
 */
export const START_APPROVE_GAS_LIMIT = 60_000n;
export const START_DEPOSIT_GAS_LIMIT = 130_000n;
export const SIGNED_START_GAS = START_APPROVE_GAS_LIMIT + START_DEPOSIT_GAS_LIMIT;

export const BATCH_SIZES = [1, 10, 50] as const;
export const BATCH_SCENARIOS = {
  A: "one payer, one builder (the cheapest case: the same storage is reused by every intent)",
  B: "every intent from a different payer to a different builder (the most expensive case)",
} as const;
export type Scenario = keyof typeof BATCH_SCENARIOS;

export type Basis = {
  date: string; // 2026-11-18
  forkBlock: number;
  blockGasLimit: bigint;
  gasPriceWei: bigint;
  gasPriceSource: string;
  qiePriceMicroUsd: bigint; // $0.164378 is 164378
  qiePriceSource: string;
};

export type SingleRow = { label: string; gas: bigint };
export type BatchRow = { scenario: Scenario; size: number; gas: bigint };

/** wei to a decimal string with `places` decimals, rounded half up. */
function decimal(numerator: bigint, denominator: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = (numerator * scale * 2n + denominator) / (denominator * 2n); // round half up
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(places, "0");
  return `${whole}.${frac}`;
}

/** The cost of `gas` in QIE, 8 decimals. */
export function qieCost(gas: bigint, gasPriceWei: bigint): string {
  return decimal(gas * gasPriceWei, WEI_PER_QIE, 8);
}

/** The cost of `gas` in USD, 8 decimals, at a QIE price given in millionths of a dollar. */
export function usdCost(gas: bigint, gasPriceWei: bigint, qiePriceMicroUsd: bigint): string {
  return decimal(gas * gasPriceWei * qiePriceMicroUsd, WEI_PER_QIE * 1_000_000n, 8);
}

export function formatMicro(micro: bigint): string {
  return `$${decimal(micro, 1_000_000n, 6)}`;
}

export function parseMicro(text: string): bigint {
  const match = /^\$(\d+)\.(\d{6})$/.exec(text.trim());
  if (!match) throw new Error(`not a dollar amount with six decimals: ${text}`);
  return BigInt(match[1] as string) * 1_000_000n + BigInt(match[2] as string);
}

export function formatGwei(wei: bigint): string {
  return `${decimal(wei, 1_000_000_000n, 3)} gwei`;
}

export function withCommas(n: bigint | number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function renderGasReport(basis: Basis, singles: SingleRow[], batches: BatchRow[]): string {
  const price = basis.gasPriceWei;
  const usd = basis.qiePriceMicroUsd;
  const lines: string[] = [];
  lines.push("# Gas and cost");
  lines.push("");
  lines.push(
    `Measured on a local fork of QIE mainnet (chain 1990) at block ${withCommas(basis.forkBlock)}, on ${basis.date}, with the real QUSDC. ` +
      "Nothing was sent to QIE. Regenerate it with `pnpm gas:report`.",
  );
  lines.push("");
  lines.push(
    "Gas used is exact for the state the test built. On the live chain it can differ a little with the state it meets " +
      "(for example whether a balance slot is already set), so read these as measurements, not promises.",
  );
  lines.push("");
  lines.push("## Basis");
  lines.push("");
  lines.push("| Input | Value | Source |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Gas price | ${formatGwei(price)} | ${basis.gasPriceSource} |`);
  lines.push(`| QIE price | ${formatMicro(usd)} | ${basis.qiePriceSource} |`);
  lines.push(`| Block gas limit | ${withCommas(basis.blockGasLimit)} | read from the header of block ${withCommas(basis.forkBlock)} on QIE mainnet |`);
  lines.push("| Compiler | Solidity 0.8.24, Shanghai EVM, optimizer 200 runs | `hardhat.config.ts` |");
  lines.push("");
  lines.push("## Single operations");
  lines.push("");
  lines.push("| Operation | Gas | QIE | USD |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of singles) {
    lines.push(`| ${row.label} | ${withCommas(row.gas)} | ${qieCost(row.gas, price)} | $${usdCost(row.gas, price, usd)} |`);
  }
  for (const scenario of Object.keys(BATCH_SCENARIOS) as Scenario[]) {
    lines.push("");
    lines.push(`## Batch settle, scenario ${scenario}: ${BATCH_SCENARIOS[scenario]}`);
    lines.push("");
    lines.push("| Batch size | Total gas | Gas per intent | QIE per intent | USD per intent |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of batches.filter((b) => b.scenario === scenario)) {
      const per = row.gas / BigInt(row.size);
      lines.push(
        `| ${row.size} | ${withCommas(row.gas)} | ${withCommas(per)} | ${qieCost(per, price)} | $${usdCost(per, price, usd)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Reading this");
  lines.push("");
  lines.push(
    "- A payer deposits once and then every call is signed off-chain, so the per-call cost is the batch row, " +
      "paid by whoever submits the batch (a facilitator), not by the payer or the builder.",
  );
  lines.push(
    "- Settling does not move any QUSDC: it changes two balances inside the router. QUSDC moves only on deposit, " +
      "withdraw and refund.",
  );
  const transfer = singles.find((s) => s.label.startsWith("QIE top-up transfer"));
  if (transfer) {
    const topUp = SIGNED_START_GAS;
    lines.push(
      `- A wallet with QUSDC and no QIE starts through a facilitator. The wallet signs an approve and a deposit with gas limits of ` +
        `${withCommas(START_APPROVE_GAS_LIMIT)} and ${withCommas(START_DEPOSIT_GAS_LIMIT)}; the facilitator sends it the QIE those limits can use ` +
        `(${withCommas(topUp)} gas at the price above, ${qieCost(topUp, price)} QIE) and pays ${withCommas(transfer.gas)} gas for that transfer, ` +
        `${qieCost(topUp + transfer.gas, price)} QIE in all. The wallet keeps what its two transactions do not use.`,
    );
  }
  lines.push(
    "- The block gas limit above is what the chain's header says. Whether the network accepts a single transaction as large as the " +
      "biggest batch here was not tested, because nothing was sent. Keep batches modest until it has been.",
  );
  lines.push("- The USD column depends on the QIE price above, which moves. It is an illustration, not a quote.");
  lines.push("");
  return lines.join("\n");
}

export type ParsedReport = {
  gasPriceWei: bigint;
  qiePriceMicroUsd: bigint;
  blockGasLimit: bigint;
  forkBlock: number;
  singles: Array<{ label: string; gas: bigint; qie: string; usd: string }>;
  batches: Array<{ scenario: Scenario; size: number; gas: bigint; perIntent: bigint; qie: string; usd: string }>;
};

const num = (text: string): bigint => BigInt(text.replace(/[,\s]/g, ""));

/** Reads a report back. Throws if its shape is wrong. */
export function parseGasReport(markdown: string): ParsedReport {
  const lines = markdown.split("\n");
  const cell = (line: string) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const basisRow = (name: string) => {
    const line = lines.find((l) => l.startsWith(`| ${name} |`));
    if (!line) throw new Error(`the report has no ${name} row`);
    return cell(line);
  };
  const gwei = /^([\d.]+) gwei$/.exec(basisRow("Gas price")[1] ?? "");
  if (!gwei) throw new Error("gas price must look like 1.125 gwei");
  const [whole = "0", frac = ""] = (gwei[1] as string).split(".");
  const gasPriceWei = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0").slice(0, 9));
  const forkBlock = /at block ([\d,]+)/.exec(markdown);
  if (!forkBlock) throw new Error("the report does not say which block it was measured at");

  const parsed: ParsedReport = {
    gasPriceWei,
    qiePriceMicroUsd: parseMicro(basisRow("QIE price")[1] ?? ""),
    blockGasLimit: num(basisRow("Block gas limit")[1] ?? ""),
    forkBlock: Number(num(forkBlock[1] as string)),
    singles: [],
    batches: [],
  };
  let section: "single" | Scenario | undefined;
  for (const line of lines) {
    if (line.startsWith("## Single operations")) section = "single";
    else if (/^## Batch settle, scenario A/.test(line)) section = "A";
    else if (/^## Batch settle, scenario B/.test(line)) section = "B";
    else if (line.startsWith("## ")) section = undefined;
    if (!section || !line.startsWith("|")) continue;
    const c = cell(line);
    if (c[0] === "Operation" || c[0] === "Batch size" || /^-+$/.test(c[0] ?? "")) continue;
    if (section === "single") {
      parsed.singles.push({ label: c[0] ?? "", gas: num(c[1] ?? ""), qie: c[2] ?? "", usd: (c[3] ?? "").replace(/^\$/, "") });
    } else {
      parsed.batches.push({
        scenario: section,
        size: Number(c[0]),
        gas: num(c[1] ?? ""),
        perIntent: num(c[2] ?? ""),
        qie: c[3] ?? "",
        usd: (c[4] ?? "").replace(/^\$/, ""),
      });
    }
  }
  return parsed;
}
