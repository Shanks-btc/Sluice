// Measures gas on a local fork of QIE mainnet with the real QUSDC, and (only with GAS_REPORT=1, which is what
// `pnpm gas:report` sets) writes docs/GAS.md. Without it the test still measures and checks, but writes nothing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { ethers } from "hardhat";
import { BATCH_SIZES, renderGasReport, SINGLE_OPERATIONS } from "../../src/gas";
import type { Basis, BatchRow, Scenario, SingleRow } from "../../src/gas";
import { NETWORKS } from "../../src/evidence";
import {
  authorizeTypes,
  fundBalance,
  nowSeconds,
  randomNonce,
  refundTypes,
  routerDomain,
  signedIntent,
  toolId,
  USDC,
  vaultDomain,
  withdrawTypes,
} from "../helpers";
import type { TypedSigner } from "../helpers";
import { deployOnFork } from "../helpers/fork";

const WRITE = process.env.GAS_REPORT === "1";
const DEFAULT_GAS_PRICE_WEI = 1_125_000_000n;
const DEFAULT_QIE_PRICE_MICRO = 164_378n; // $0.164378

function microFromEnv(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) throw new Error("QIE_PRICE_USD must be a decimal with at most six places, like 0.164378");
  return BigInt(match[1] as string) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** Reads QIE's current gas price over the public RPC. Read-only; falls back to the default if unreachable. */
async function liveGasPrice(): Promise<bigint | undefined> {
  try {
    const res = await fetch(NETWORKS.mainnet.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? BigInt(body.result) : undefined;
  } catch {
    return undefined;
  }
}

type Sent = Promise<{ wait: () => Promise<{ gasUsed: bigint } | null> }>;
async function gasOf(tx: Sent): Promise<bigint> {
  const receipt = await (await tx).wait();
  if (!receipt) throw new Error("no receipt");
  return receipt.gasUsed;
}

describe("Fork: gas on QIE mainnet's QUSDC", function () {
  this.timeout(900_000);

  const singles: SingleRow[] = [];
  const batches: BatchRow[] = [];
  let forkBlock = 0;
  let blockGasLimit = 0n;

  before(async () => {
    forkBlock = await ethers.provider.getBlockNumber();
    const header = await ethers.provider.getBlock(forkBlock);
    blockGasLimit = header!.gasLimit;
  });

  const add = (label: (typeof SINGLE_OPERATIONS)[number], gas: bigint) => singles.push({ label, gas });

  it("measures each single operation", async () => {
    const w = await deployOnFork(100);
    const { router, vault, token } = w;
    await w.mint(w.payer.address, USDC(100));
    await w.mint(w.other.address, USDC(1));

    add("QUSDC transfer to a new holder (for comparison)", await gasOf(token.connect(w.payer).transfer(ethers.Wallet.createRandom().address, USDC(1))));
    add("QUSDC transfer to an existing holder (for comparison)", await gasOf(token.connect(w.payer).transfer(w.other.address, USDC(1))));
    add("Approve QUSDC for the router", await gasOf(token.connect(w.payer).approve(w.routerAddress, USDC(50))));
    add("Deposit, first for this payer", await gasOf(router.connect(w.payer).deposit(USDC(10))));
    add("Deposit, later", await gasOf(router.connect(w.payer).deposit(USDC(1))));

    const first = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC("0.5"));
    add("Settle, first payment to a builder", await gasOf(router.connect(w.relayer).settle(first.intent, first.signature)));
    const later = await signedIntent(w, w.payer, w.payer.address, w.builder.address, USDC("0.5"));
    add("Settle, later payment", await gasOf(router.connect(w.relayer).settle(later.intent, later.signature)));

    add("Withdraw, part of earnings", await gasOf(router.connect(w.builder).withdraw(USDC("0.1"), w.builder.address)));
    add("Refund, part of the balance", await gasOf(router.connect(w.payer).refund(USDC(1), w.payer.address)));

    const agent = ethers.Wallet.createRandom();
    const grant = { agent: agent.address, budget: USDC(5), perCallCap: USDC(1), expiry: (await nowSeconds()) + 3600n };
    const tools = [{ payee: w.builder.address, toolId: toolId("tool") }];
    add("Authorize an agent, one tool", await gasOf(vault.connect(w.payer).authorize(grant, tools)));
    const spend = await signedIntent(w, agent, w.payer.address, w.builder.address, USDC("0.1"), { toolId: toolId("tool") });
    add("Settle signed by an agent, first spend", await gasOf(router.connect(w.relayer).settle(spend.intent, spend.signature)));
    add("Revoke an agent", await gasOf(vault.connect(w.payer).revoke(agent.address)));

    // By signature, for accounts that hold no QIE: the relayer pays the gas.
    const builder = ethers.Wallet.createRandom();
    const pay = await signedIntent(w, w.payer, w.payer.address, builder.address, USDC(2));
    await router.settle(pay.intent, pay.signature);
    const deadline = (await nowSeconds()) + 3600n;
    const wNonce = randomNonce();
    const wSig = await builder.signTypedData(routerDomain(w.routerAddress), withdrawTypes, {
      account: builder.address, to: builder.address, amount: USDC(1), relayerFee: 0, nonce: wNonce, deadline,
    });
    add(
      "Withdraw by signature, through a relayer",
      await gasOf(router.connect(w.relayer).withdrawBySig(builder.address, builder.address, USDC(1), 0, wNonce, deadline, wSig)),
    );

    const payer = ethers.Wallet.createRandom();
    await router.connect(w.payer).depositFor(payer.address, USDC(4));
    const rNonce = randomNonce();
    const rSig = await payer.signTypedData(routerDomain(w.routerAddress), refundTypes, {
      payer: payer.address, to: payer.address, amount: USDC(1), relayerFee: 0, nonce: rNonce, deadline,
    });
    add(
      "Refund by signature, through a relayer",
      await gasOf(router.connect(w.relayer).refundBySig(payer.address, payer.address, USDC(1), 0, rNonce, deadline, rSig)),
    );

    const agent2 = ethers.Wallet.createRandom();
    const grant2 = { ...grant, agent: agent2.address };
    const aSig = await payer.signTypedData(vaultDomain(w.vaultAddress), authorizeTypes, {
      payer: payer.address, ...grant2, tools, nonce: 0, deadline,
    });
    add("Authorize an agent by signature, one tool", await gasOf(vault.connect(w.relayer).authorizeBySig(payer.address, grant2, tools, deadline, aSig)));

    // The facilitator's top-up for a wallet that holds QUSDC and no QIE is a plain transfer of QIE.
    const [topUpSender] = await ethers.getSigners();
    add(
      "QIE top-up transfer by a facilitator, for a wallet with no QIE",
      await gasOf(topUpSender!.sendTransaction({ to: ethers.Wallet.createRandom().address, value: 1_000n })),
    );

    const deployment = router.deploymentTransaction();
    const receipt = await ethers.provider.getTransactionReceipt(deployment!.hash);
    add("Deploy the router (creates the vault)", receipt!.gasUsed);

    for (const label of SINGLE_OPERATIONS) expect(singles.some((s) => s.label === label), label).to.equal(true);
    for (const row of singles) {
      expect(row.gas, row.label).to.be.greaterThanOrEqual(21_000n); // a plain transfer of QIE costs exactly the 21,000 intrinsic gas
      expect(row.gas, row.label).to.be.lessThan(blockGasLimit);
    }
  });

  async function batch(scenario: Scenario, size: number): Promise<bigint> {
    const w = await deployOnFork(100);
    await w.mint(w.payer.address, USDC(size + 5));
    await w.token.connect(w.payer).approve(w.routerAddress, USDC(size + 5));
    const amount = 10_000n; // 0.01 QUSDC: large enough that the 1% fee is a whole number of units
    const intents = [];
    const signatures: string[] = [];
    if (scenario === "A") {
      await w.router.connect(w.payer).deposit(USDC(size + 5));
      for (let i = 0; i < size; i++) {
        const item = await signedIntent(w, w.payer, w.payer.address, w.builder.address, amount);
        intents.push(item.intent);
        signatures.push(item.signature);
      }
    } else {
      for (let i = 0; i < size; i++) {
        const payer = ethers.Wallet.createRandom();
        await w.router.connect(w.payer).depositFor(payer.address, USDC(1));
        const item = await signedIntent(w, payer as TypedSigner, payer.address, ethers.Wallet.createRandom().address, amount);
        intents.push(item.intent);
        signatures.push(item.signature);
      }
    }
    const tx = await w.router.connect(w.relayer).batchSettle(intents, signatures);
    const receipt = await tx.wait();
    const settledTopic = w.router.interface.getEvent("Settled")!.topicHash;
    const settled = receipt.logs.filter((l: { topics: string[] }) => l.topics[0] === settledTopic).length;
    expect(settled, `every intent in the batch of ${size} settled`).to.equal(size);
    return receipt.gasUsed as bigint;
  }

  for (const scenario of ["A", "B"] as const) {
    for (const size of BATCH_SIZES) {
      it(`measures a batch of ${size}, scenario ${scenario}`, async () => {
        batches.push({ scenario, size, gas: await batch(scenario, size) });
      });
    }
  }

  it("checks the numbers make sense, and writes docs/GAS.md when GAS_REPORT=1", async () => {
    // Bigger batches cost more in total and less per intent than a single settle plus its transaction overhead.
    for (const scenario of ["A", "B"] as const) {
      const rows = batches.filter((b) => b.scenario === scenario).sort((a, b) => a.size - b.size);
      expect(rows).to.have.length(BATCH_SIZES.length);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.gas, `${scenario}: total grows with size`).to.be.greaterThan(rows[i - 1]!.gas);
        expect(rows[i]!.gas / BigInt(rows[i]!.size), `${scenario}: per-intent cost falls or holds`).to.be.lessThanOrEqual(
          rows[i - 1]!.gas / BigInt(rows[i - 1]!.size),
        );
      }
    }
    const byLabel = (label: string) => singles.find((s) => s.label === label)!.gas;
    expect(byLabel("Settle, first payment to a builder")).to.be.greaterThan(byLabel("Settle, later payment"));
    expect(byLabel("Deposit, first for this payer")).to.be.greaterThan(byLabel("Deposit, later"));

    const liveGas = process.env.GAS_PRICE_WEI?.trim() ? undefined : await liveGasPrice();
    const gasPriceWei = process.env.GAS_PRICE_WEI?.trim() ? BigInt(process.env.GAS_PRICE_WEI.trim()) : (liveGas ?? DEFAULT_GAS_PRICE_WEI);
    const basis: Basis = {
      date: new Date().toISOString().slice(0, 10),
      forkBlock,
      blockGasLimit,
      gasPriceWei,
      gasPriceSource: process.env.GAS_PRICE_WEI?.trim()
        ? "set by `GAS_PRICE_WEI` when this was generated"
        : liveGas
          ? "QIE's public RPC, `eth_gasPrice`, read when this was generated"
          : "default, because QIE's RPC could not be reached when this was generated",
      qiePriceMicroUsd: process.env.QIE_PRICE_USD?.trim() ? microFromEnv(process.env.QIE_PRICE_USD) : DEFAULT_QIE_PRICE_MICRO,
      qiePriceSource: process.env.QIE_PRICE_USD?.trim()
        ? "set by `QIE_PRICE_USD` when this was generated"
        : "an assumed price: a quote taken on 2026-11-18. QIE's price moves; set `QIE_PRICE_USD` to change it",
    };
    const ordered = SINGLE_OPERATIONS.map((label) => ({ label, gas: byLabel(label) }));
    const report = renderGasReport(basis, ordered, batches);
    if (WRITE) {
      writeFileSync(join(__dirname, "..", "..", "docs", "GAS.md"), report);
      console.log("      wrote docs/GAS.md");
    }
    console.log(report);
  });
});
