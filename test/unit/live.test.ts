// The code behind scripts/live/*.ts, run on the local EVM with a mock token. The scripts themselves are not
// run here: this is the same library they call, given a local signer, so the first contact with a real network
// is not also the first time this code runs.
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Provider } from "ethers";
import { checkRow, parseEvidence } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import { GuardError, SpendMeter } from "../../src/guard";
import type { Caps } from "../../src/guard";
import {
  DEFAULT_SMOKE_AMOUNTS,
  deployRouter,
  evidenceLines,
  readDeployParams,
  readSmokeParams,
  runSmoke,
} from "../../src/live";
import type { LiveContext } from "../../src/live";
import { attach, deploy, USDC } from "../helpers";
import type { World } from "../helpers";

const caps: Caps = { maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n };
const localRpc: Rpc = (method, params) => ethers.provider.send(method, params as never[]);

function contextFor(w: World, over: Partial<LiveContext> = {}, withCaps: Caps = caps) {
  const lines: string[] = [];
  const ctx: LiveContext = {
    signer: w.payer,
    provider: ethers.provider as unknown as Provider,
    meter: new SpendMeter(withCaps),
    network: "mainnet",
    log: (line) => lines.push(line),
    ...over,
  };
  return { ctx, lines };
}

async function readyWorld() {
  const w = await deploy({ feeBps: 100 });
  await w.token.mint(w.payer.address, USDC(5));
  return w;
}

describe("Live library: the smoke round trip", () => {
  it("runs every step in order and yields one evidence row per recorded event", async () => {
    const w = await readyWorld();
    const { ctx, lines } = contextFor(w);
    const { rows, stillOwed } = await runSmoke(ctx, { router: w.routerAddress });
    expect(rows.map((r) => r.event)).to.deep.equal([
      "Deposited",
      "Settled",
      "SessionAuthorized",
      "Settled",
      "SessionRevoked",
      "Withdrawn",
      "Refunded",
    ]);
    expect(rows.map((r) => r.amount)).to.deep.equal([
      "0.300000", // deposit
      "0.100000", // payer-signed call
      "0.100000", // the agent's budget
      "0.050000", // agent-signed call
      "—",
      "0.148500", // 0.15 earned minus the 1% fee on each call
      "0.150000", // the unspent balance
    ]);
    for (const row of rows) {
      expect(row.who).to.equal(w.payer.address);
      expect(row.network).to.equal("mainnet");
    }
    expect(stillOwed).to.equal(1_500n); // only the fee recipient's fees remain
    expect(lines.some((l) => l.startsWith("approve:"))).to.equal(true);
    expect(lines.join("\n"), "the log never mentions a key or seed phrase").to.not.match(/private key|mnemonic|seed phrase/i);
  });

  it("costs the signer only the fee, and the router ends up holding exactly what it owes", async () => {
    const w = await readyWorld();
    const before: bigint = await w.token.balanceOf(w.payer.address);
    const { ctx } = contextFor(w);
    const { stillOwed } = await runSmoke(ctx, { router: w.routerAddress });
    expect(before - (await w.token.balanceOf(w.payer.address))).to.equal(1_500n);
    expect(await w.token.balanceOf(w.routerAddress)).to.equal(stillOwed);
    expect(await w.router.totalLiabilities()).to.equal(stillOwed);
    expect(await w.router.payerBalance(w.payer.address)).to.equal(0);
    expect(await w.router.earnings(w.payer.address)).to.equal(0);
    expect(await w.router.earnings(w.feeRecipient.address)).to.equal(1_500n);
    // The agent's session is revoked and its allowance to the router is fully used.
    expect(await w.token.allowance(w.payer.address, w.routerAddress)).to.equal(0);
  });

  it("every row it produces is confirmed by the real evidence checker against the chain", async () => {
    const w = await readyWorld();
    const { ctx } = contextFor(w);
    const { rows } = await runSmoke(ctx, { router: w.routerAddress });
    for (const row of rows) {
      const result = await checkRow(row, localRpc);
      expect(result, `${row.event} ${row.hash}`).to.deep.equal({ status: "PASS", detail: `${row.event} confirmed in block ${row.block}` });
    }
    // And a row with one digit changed is not.
    const tampered = { ...rows[1]!, amount: "0.100001" };
    expect((await checkRow(tampered, localRpc)).status).to.equal("FAIL");
  });

  it("prints rows that paste straight into docs/EVIDENCE.md and read back identically", async () => {
    const w = await readyWorld();
    const { ctx } = contextFor(w);
    const { rows } = await runSmoke(ctx, { router: w.routerAddress });
    const table = [
      "## Mainnet (chain 1990)",
      "",
      "| Date (UTC) | Event | Transaction hash | Block | Contract | Amount | Who |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...evidenceLines(rows),
      "",
    ].join("\n");
    expect(parseEvidence(table)).to.deep.equal(rows);
  });

  it("with another address as payee, leaves that payee's earnings for the payee to withdraw", async () => {
    const w = await readyWorld();
    const { ctx, lines } = contextFor(w);
    const { rows, stillOwed } = await runSmoke(ctx, { router: w.routerAddress, payee: w.builder.address });
    expect(rows.map((r) => r.event)).to.not.include("Withdrawn");
    expect(await w.router.earnings(w.builder.address)).to.equal(148_500n);
    expect(stillOwed).to.equal(150_000n);
    expect(lines.some((l) => l.includes("must withdraw its own"))).to.equal(true);
    await w.router.connect(w.builder).withdraw(148_500n, w.builder.address); // and they can
  });

  it("counts what it moved and what it spent against the meter", async () => {
    const w = await readyWorld();
    const { ctx } = contextFor(w);
    await runSmoke(ctx, { router: w.routerAddress });
    expect(ctx.meter.movedQusdc).to.equal(DEFAULT_SMOKE_AMOUNTS.deposit);
    expect(ctx.meter.spentQie).to.be.greaterThan(0n);
    expect(ctx.meter.spentQie).to.be.lessThan(10n ** 17n); // a tenth of a QIE
  });

  it("refuses an address that is not a Sluice router, before sending anything", async () => {
    const w = await readyWorld();
    for (const target of [w.tokenAddress, w.vaultAddress, w.stranger.address]) {
      const { ctx } = contextFor(w);
      let failed = false;
      try {
        await runSmoke(ctx, { router: target });
      } catch {
        failed = true;
      }
      expect(failed, target).to.equal(true);
      expect(ctx.meter.spentQie, "nothing was sent").to.equal(0n);
    }
    expect(await w.token.allowance(w.payer.address, w.routerAddress)).to.equal(0);
  });

  it("refuses when the signer holds less QUSDC than the deposit, before sending anything", async () => {
    const w = await deploy({ feeBps: 100 });
    await w.token.mint(w.payer.address, 299_999n);
    const { ctx } = contextFor(w);
    let error: unknown;
    try {
      await runSmoke(ctx, { router: w.routerAddress });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(GuardError);
    expect(String(error)).to.match(/less QUSDC than the deposit/);
    expect(ctx.meter.spentQie).to.equal(0n);
  });

  it("stops at the QUSDC cap before the first transaction", async () => {
    const w = await readyWorld();
    const { ctx } = contextFor(w, {}, { maxQusdc: 299_999n, maxQieWei: caps.maxQieWei });
    let error: unknown;
    try {
      await runSmoke(ctx, { router: w.routerAddress });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(GuardError);
    expect(String(error)).to.match(/would pass the cap/);
    expect(ctx.meter.spentQie).to.equal(0n);
    expect(await w.token.allowance(w.payer.address, w.routerAddress)).to.equal(0);
  });

  it("stops at the QIE cap, and a run stopped half way leaves every unit recoverable", async () => {
    // Measure a full run, then allow only half of that gas on a fresh deployment.
    const measured = await readyWorld();
    const full = contextFor(measured);
    await runSmoke(full.ctx, { router: measured.routerAddress });
    const half = full.ctx.meter.spentQie / 2n;

    const w = await readyWorld();
    const { ctx, lines } = contextFor(w, {}, { maxQusdc: caps.maxQusdc, maxQieWei: half });
    let error: unknown;
    try {
      await runSmoke(ctx, { router: w.routerAddress });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(GuardError);
    expect(String(error)).to.match(/could pass the cap/);
    expect(lines.length, "it got some of the way").to.be.greaterThan(0);

    // Whatever was deposited is the signer's to take back, and the router is solvent.
    const [held, owed] = await w.router.solvency();
    expect(held).to.equal(owed);
    const prepaid: bigint = await w.router.payerBalance(w.payer.address);
    const earned: bigint = await w.router.earnings(w.payer.address);
    if (prepaid > 0n) await w.router.connect(w.payer).refund(prepaid, w.payer.address);
    if (earned > 0n) await w.router.connect(w.payer).withdraw(earned, w.payer.address);
    const fees: bigint = await w.router.earnings(w.feeRecipient.address);
    expect(await w.token.balanceOf(w.payer.address)).to.equal(USDC(5) - fees);
  });

  it("refuses amounts that do not fit together", async () => {
    const w = await readyWorld();
    const { ctx } = contextFor(w);
    let error: unknown;
    try {
      await runSmoke(ctx, { router: w.routerAddress }, { ...DEFAULT_SMOKE_AMOUNTS, agentCall: 60_000n });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(GuardError);
  });
});

describe("Live library: the deployment", () => {
  it("deploys a router and its vault, reads them back, and spends gas within the meter", async () => {
    const w = await deploy();
    const { ctx, lines } = contextFor(w, { signer: w.owner });
    const deployed = await deployRouter(ctx, {
      token: w.tokenAddress,
      owner: w.other.address,
      feeRecipient: w.feeRecipient.address,
      feeBps: 150,
    });
    const router = await attach("PaymentRouter", deployed.router);
    expect(await router.owner()).to.equal(w.other.address);
    expect(await router.feeRecipient()).to.equal(w.feeRecipient.address);
    expect(await router.feeBps()).to.equal(150);
    expect(await router.token()).to.equal(w.tokenAddress);
    expect(await router.vault()).to.equal(deployed.vault);
    expect(await router.MAX_FEE_BPS()).to.equal(200);
    expect(ctx.meter.spentQie).to.be.greaterThan(0n);
    expect(ctx.meter.spentQie).to.be.lessThan(2n * 10n ** 17n);
    expect(lines.join("\n")).to.contain(deployed.router);
    expect((await ethers.provider.getTransactionReceipt(deployed.hash))!.blockNumber).to.equal(deployed.block);
  });

  it("refuses a fee above the cap before sending, and stops at the QIE cap", async () => {
    const w = await deploy();
    const good = { token: w.tokenAddress, owner: w.other.address, feeRecipient: w.feeRecipient.address, feeBps: 100 };
    const a = contextFor(w, { signer: w.owner });
    let error: unknown;
    try {
      await deployRouter(a.ctx, { ...good, feeBps: 201 });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(GuardError);
    expect(a.ctx.meter.spentQie).to.equal(0n);

    const b = contextFor(w, { signer: w.owner }, { maxQusdc: 1n, maxQieWei: 1_000_000n });
    error = undefined;
    try {
      await deployRouter(b.ctx, good);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(GuardError);
    expect(String(error)).to.match(/could pass the cap/);
  });
});

describe("Live library: reading parameters", () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const recipient = "0x2222222222222222222222222222222222222222";
  const ok = { SLUICE_OWNER: owner, SLUICE_FEE_RECIPIENT: recipient, SLUICE_FEE_BPS: "100" };

  it("on mainnet the token defaults to QUSDC, and any other token is refused", () => {
    const params = readDeployParams(ok, "mainnet");
    expect(params.token).to.equal("0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5");
    expect(readDeployParams({ ...ok, SLUICE_TOKEN: "0x3f43da82ec9a4f5285f10faf1f26eca7319e5da5" }, "mainnet").token).to.equal(params.token);
    expect(() => readDeployParams({ ...ok, SLUICE_TOKEN: owner }, "mainnet")).to.throw(/must be left empty or be the QUSDC address/);
  });

  it("on testnet the token must be given", () => {
    expect(() => readDeployParams(ok, "testnet")).to.throw(/SLUICE_TOKEN/);
    expect(readDeployParams({ ...ok, SLUICE_TOKEN: owner }, "testnet").token).to.equal(owner);
  });

  it("has no default owner, fee recipient or fee: each must be chosen on purpose", () => {
    for (const missing of ["SLUICE_OWNER", "SLUICE_FEE_RECIPIENT", "SLUICE_FEE_BPS"]) {
      const env = { ...ok, [missing]: undefined };
      expect(() => readDeployParams(env, "mainnet"), missing).to.throw(GuardError);
    }
  });

  it("accepts a fee from 0 to 200 and refuses anything else", () => {
    for (const fee of ["0", "1", "100", "200"]) expect(readDeployParams({ ...ok, SLUICE_FEE_BPS: fee }, "mainnet").feeBps).to.equal(Number(fee));
    for (const fee of ["201", "-1", "1.5", "abc", "", "0x10", "1000", "1e2", " "]) {
      expect(() => readDeployParams({ ...ok, SLUICE_FEE_BPS: fee }, "mainnet"), JSON.stringify(fee)).to.throw(/0 to 200/);
    }
  });

  it("refuses an owner or recipient that is not an address, without repeating it", () => {
    expect(() => readDeployParams({ ...ok, SLUICE_OWNER: "alice" }, "mainnet")).to.throw(/SLUICE_OWNER is not a valid address/);
    try {
      readDeployParams({ ...ok, SLUICE_FEE_RECIPIENT: "not-an-address-secret" }, "mainnet");
    } catch (e) {
      expect((e as Error).message).to.not.contain("secret");
    }
  });

  it("reads the smoke parameters: a router is required, a payee is optional", () => {
    expect(readSmokeParams({ SLUICE_ROUTER: owner })).to.deep.equal({ router: owner });
    expect(readSmokeParams({ SLUICE_ROUTER: owner, SLUICE_PAYEE: recipient })).to.deep.equal({ router: owner, payee: recipient });
    expect(() => readSmokeParams({})).to.throw(/SLUICE_ROUTER/);
    expect(() => readSmokeParams({ SLUICE_ROUTER: "0x12" })).to.throw(/not a valid address/);
  });
});
