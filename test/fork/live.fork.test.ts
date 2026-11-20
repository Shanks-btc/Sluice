// The library behind scripts/live/*.ts, run against a local fork of QIE mainnet with the real QUSDC.
// This is as close as the repository gets to the real run without sending anything: the same deploy and
// smoke code, the same token, the same evidence checker, all on a copy of the chain held in memory.
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Provider } from "ethers";
import { checkRow } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import { SpendMeter } from "../../src/guard";
import type { Caps } from "../../src/guard";
import { deployRouter, runSmoke } from "../../src/live";
import type { LiveContext } from "../../src/live";
import { attach, deploy, USDC } from "../helpers";
import { mintQusdc, QUSDC, realQusdc } from "../helpers/fork";

const caps: Caps = { maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n };
const localRpc: Rpc = (method, params) => ethers.provider.send(method, params as never[]);

describe("Fork: deploy and smoke, as the founder will run them, on a copy of mainnet", function () {
  this.timeout(600_000);

  it("deploys the router with QUSDC, runs the full smoke round trip, and every evidence row passes the checker", async () => {
    const w = await deploy(); // only for the signers
    const token = await realQusdc();
    await mintQusdc(w.payer.address, USDC(1)); // the smoke signer needs 0.3 QUSDC
    const lines: string[] = [];
    const ctx = (signer: LiveContext["signer"]): LiveContext => ({
      signer,
      provider: ethers.provider as unknown as Provider,
      meter: new SpendMeter(caps),
      network: "mainnet",
      log: (line) => lines.push(line),
    });

    const deployed = await deployRouter(ctx(w.owner), {
      token: QUSDC,
      owner: w.other.address,
      feeRecipient: w.feeRecipient.address,
      feeBps: 100,
    });
    const router = await attach("PaymentRouter", deployed.router);
    expect(await router.token()).to.equal(QUSDC);
    expect(await router.owner()).to.equal(w.other.address);

    const walletBefore: bigint = await token.balanceOf(w.payer.address);
    const smoke = ctx(w.payer);
    const { rows, stillOwed } = await runSmoke(smoke, { router: deployed.router });
    expect(rows.map((r) => r.event)).to.deep.equal([
      "Deposited",
      "Settled",
      "SessionAuthorized",
      "Settled",
      "SessionRevoked",
      "Withdrawn",
      "Refunded",
    ]);
    // The run costs the signer the 1% fee on 0.15 QUSDC, nothing else.
    expect(walletBefore - (await token.balanceOf(w.payer.address))).to.equal(1_500n);
    expect(stillOwed).to.equal(1_500n);
    expect(await token.balanceOf(deployed.router)).to.equal(1_500n);
    expect(smoke.meter.movedQusdc).to.equal(300_000n);
    expect(smoke.meter.spentQie).to.be.lessThan(10n ** 17n); // under a tenth of a QIE

    for (const row of rows) {
      const result = await checkRow(row, localRpc);
      expect(result.status, `${row.event}: ${result.detail}`).to.equal("PASS");
    }
    expect(lines.join("\n")).to.not.match(/private key|mnemonic|seed phrase/i);
  });
});
