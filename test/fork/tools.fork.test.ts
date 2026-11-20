// The three example paid tools against QIE mainnet as it is: the real QUSDC, the real QIEDEX pool, the public explorer.
// The chain part runs on the local fork (nothing is sent). The explorer part reads QIE's public explorer with GET requests
// only; if the explorer cannot be reached those tests are skipped, never passed.
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";
import { QIEDEX, contractLookup, dexQuote, explorerClient, rpcFromProvider, tokenRiskCheck } from "../../examples/paid-tools/src";
import { asAccount, QUSDC, QUSDC_ADMIN, QUSDC_VAULT } from "../helpers/fork";

describe("Fork: the example paid tools on the real QUSDC and the real QIEDEX pool", function () {
  this.timeout(300_000);
  const rpc = () => rpcFromProvider(ethers.provider);
  const explorer = explorerClient();
  let explorerUp = false;

  before(async () => {
    // The fork's state is shared by every file in a run. test/fork/qusdc.fork.test.ts grants the QUSDC admin VAULT_ROLE on the fork to
    // show what the admin could do, and that change would still be there when this file runs. These tests describe the chain as it is,
    // so put the role back the way the real chain has it.
    const token = new Contract(
      QUSDC,
      ["function hasRole(bytes32,address) view returns (bool)", "function VAULT_ROLE() view returns (bytes32)", "function revokeRole(bytes32,address)"],
      ethers.provider,
    );
    const role = (await token.getFunction("VAULT_ROLE")()) as string;
    if ((await token.getFunction("hasRole")(role, QUSDC_ADMIN)) as boolean) {
      await asAccount(QUSDC_ADMIN, async (admin) => void (await (await token.connect(admin).getFunction("revokeRole")(role, QUSDC_ADMIN)).wait()));
    }
    expect(await token.getFunction("hasRole")(role, QUSDC_ADMIN), "the admin holds no VAULT_ROLE, as on the real chain").to.equal(false);

    try {
      explorerUp = (await explorer("/api/v2/stats")).status === 200;
    } catch {
      explorerUp = false;
    }
  });

  it("token_risk_check: QUSDC is not a proxy, its VAULT_ROLE contract can burn holders, and its admin key can grant that role", async function () {
    if (!explorerUp) this.skip();
    const r = await tokenRiskCheck({ rpc: rpc(), explorer }, QUSDC);
    // The explorer answered the pre-check but can fail during the call. That is a skipped test, never a passed or a failed one.
    if (r.accessControl.holdersSource !== "explorer-logs") this.skip();
    expect(r).to.deep.include({ isContract: true, address: QUSDC });
    expect(r.token).to.deep.include({ name: "QUSDC", symbol: "QUSDC", decimals: 6 });
    expect(r.proxy).to.deep.equal({ isProxy: false });
    expect(r.accessControl.present).to.equal(true);
    expect(r.accessControl.holdersSource).to.equal("explorer-logs");
    const roles = Object.fromEntries(r.accessControl.roles.map((x) => [x.name, x]));
    expect(roles.DEFAULT_ADMIN_ROLE!.holders).to.deep.equal([{ address: QUSDC_ADMIN, kind: "EOA" }]);
    expect(roles.VAULT_ROLE!.holders).to.deep.equal([{ address: QUSDC_VAULT, kind: "contract" }]);
    expect(roles.VAULT_ROLE!.adminRoleName).to.equal("DEFAULT_ADMIN_ROLE");

    expect(r.functionsFound.burnFromAnyHolder).to.include("burn(address,uint256)");
    expect(r.burn.canBurnNow.map((b) => b.address)).to.include(QUSDC_VAULT);
    expect(r.burn.viaRoleAdmin).to.deep.equal([{ role: "VAULT_ROLE", adminRole: "DEFAULT_ADMIN_ROLE", adminHolders: [{ address: QUSDC_ADMIN, kind: "EOA" }] }]);
    const codes = r.flags.map((f) => f.code);
    expect(codes).to.include.members(["admin_can_burn_holders", "role_admin_can_grant_burn"]);
    expect(codes).to.not.include("upgradeable_proxy");
    expect(r.disclaimer).to.match(/not a security review/);
  });

  it("token_risk_check: still reports the bytecode facts when the explorer is not available, and says roles are not listed", async () => {
    const r = await tokenRiskCheck({ rpc: rpc() }, QUSDC);
    expect(r.proxy).to.deep.equal({ isProxy: false });
    expect(r.functionsFound.burnFromAnyHolder).to.include("burn(address,uint256)");
    expect(r.accessControl.holdersSource).to.equal("unavailable");
    expect(r.flags.map((f) => f.code)).to.include("roles_not_listed");
  });

  it("dex_quote: the real QIEDEX pool, priced by the pool formula and confirmed by QIEDEX's own router", async () => {
    const q = await dexQuote(rpc(), { tokenIn: "QIE", tokenOut: QUSDC, amountIn: "100", slippageBps: 100 });
    expect(q.path).to.deep.equal([QIEDEX.wqie, QUSDC]);
    expect(q.matchesRouter, "the router's getAmountsOut equals the pool formula").to.equal(true);
    expect(q.feeBps).to.equal(30);
    expect(q.tokenIn).to.deep.include({ symbol: "WQIE", decimals: 18 });
    expect(q.tokenOut).to.deep.include({ symbol: "QUSDC", decimals: 6 });
    const out = BigInt(q.amountOutUnits);
    expect(out > 0n).to.equal(true);
    // The router, asked directly, says the same.
    const router = new Contract(QIEDEX.router, ["function getAmountsOut(uint256,address[]) view returns (uint256[])"], ethers.provider);
    const direct = (await router.getFunction("getAmountsOut")(100n * 10n ** 18n, [QIEDEX.wqie, QUSDC])) as bigint[];
    expect(direct[1]).to.equal(out);
    // Against the pool's own spot price the 0.3% fee and a small impact are all the trade gives up.
    expect(q.costVsSpotBps).to.be.within(30, 400);
    expect(Number(q.executionPrice)).to.be.below(Number(q.spotPrice));
    expect(BigInt(q.hops[0]!.reserveOut) > 0n).to.equal(true);
    expect(Number(q.minAmountOut)).to.be.approximately(Number(q.amountOut) * 0.99, 0.000002);
  });

  it("dex_quote: refuses a pair with no pool, and a size it would return nothing for", async () => {
    let message = "";
    await dexQuote(rpc(), { tokenIn: QUSDC, tokenOut: "0x0000000000000000000000000000000000000001", amountIn: "1" }).catch((e: Error) => (message = e.message));
    expect(message).to.match(/not a token/);
    let tiny = "";
    await dexQuote(rpc(), { tokenIn: QUSDC, tokenOut: "QIE", amountIn: "0.000001" }).catch((e: Error) => (tiny = e.message));
    expect(tiny === "" || /zero/.test(tiny)).to.equal(true); // one micro-QUSDC buys a few QIE-wei, which is not zero: either is honest
  });

  it("contract_lookup: QUSDC is verified on the explorer, built with 0.8.20, and the explorer's bytecode is the deployed bytecode", async function () {
    if (!explorerUp) this.skip();
    const r = await contractLookup({ rpc: rpc(), explorer }, QUSDC);
    if (!r.explorer.available) this.skip();
    expect(r).to.deep.include({ isContract: true, address: QUSDC });
    expect(r.proxy).to.deep.equal({ isProxy: false });
    expect(r.compilerFromBytecode?.solc).to.equal("0.8.20");
    expect(r.explorer).to.deep.include({ available: true, verified: true, name: "QUSDC", bytecodeMatchesNode: true, compilerMatchesBytecode: true });
    expect(r.explorer.compilerVersion).to.match(/^v0\.8\.20\+commit\./);
    expect(r.explorer.abi!.adminLike.join(" ")).to.match(/grantRole|mint|burn/);
  });

  it("contract_lookup: an address with no code is reported as such", async () => {
    const r = await contractLookup({ rpc: rpc(), explorer }, "0x0000000000000000000000000000000000000001");
    expect(r.isContract).to.equal(false);
  });
});
