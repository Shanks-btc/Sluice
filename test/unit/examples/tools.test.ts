// The three example paid tools, run read-only against the local chain with stand-in explorer data and test contracts.
// The same tools run against the real QUSDC and the real QIEDEX pool in test/fork/tools.fork.test.ts.
import { createServer } from "node:http";
import { expect } from "chai";
import { getAddress, id, keccak256, parseUnits } from "ethers";
import { ethers } from "hardhat";
import {
  DEFAULT_PRICES, DexQuoteError, QIEDEX, amountOut, contractLookup, detectProxy, dexQuote, explorerClient, pushedSelectors, readMetadata,
  rpcFromProvider, selectorOf, tokenRiskCheck,
} from "../../../examples/paid-tools/src";
import { rejection } from "../../helpers/assert";
import { fakeExplorer } from "../../helpers/explorer";
import { deployContract } from "../../helpers";
import type { Dyn } from "../../helpers";

const rpc = () => rpcFromProvider(ethers.provider);
const VAULT_ROLE = id("VAULT_ROLE");

describe("Example tools: bytecode reading", () => {
  it("finds the selectors a contract dispatches on, and not those it lacks", async () => {
    const token = await deployContract("RoleToken", [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address]);
    const code = await ethers.provider.getCode(await token.getAddress());
    const found = pushedSelectors(code);
    for (const sig of ["burn(address,uint256)", "mint(address,uint256)", "hasRole(bytes32,address)", "pause()", "owner()", "grantRole(bytes32,address)"]) {
      expect(found.has(selectorOf(sig)), sig).to.equal(true);
    }
    for (const sig of ["upgradeTo(address)", "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", "setFee(uint256)"]) {
      expect(found.has(selectorOf(sig)), sig).to.equal(false);
    }
  });

  it("reads the compiler version from the metadata tail", async () => {
    const token = await deployContract("RoleToken", [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address]);
    const meta = readMetadata(await ethers.provider.getCode(await token.getAddress()))!;
    expect(meta.solc).to.equal("0.8.24");
    expect(meta.ipfs).to.match(/^0x[0-9a-f]{68}$/); // multihash: 2 prefix bytes and 32 hash bytes
    expect(readMetadata("0x")).to.equal(undefined);
    expect(readMetadata("0x6001600155")).to.equal(undefined); // no metadata tail
  });

  it("detects an ERC-1967 proxy from its slots, and an ERC-1167 clone from its bytes, and a plain contract as neither", async () => {
    const impl = await deployContract("RoleToken", [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address]);
    const admin = ethers.Wallet.createRandom().address;
    const proxy = await deployContract("SlotProxy", [await impl.getAddress(), admin]);
    const proxyAddress = await proxy.getAddress();
    const info = await detectProxy(rpc(), proxyAddress, await ethers.provider.getCode(proxyAddress));
    expect(info).to.deep.include({ isProxy: true, kind: "eip1967", implementation: await impl.getAddress(), admin });
    const implAddress = await impl.getAddress();
    expect(await detectProxy(rpc(), implAddress, await ethers.provider.getCode(implAddress))).to.deep.equal({ isProxy: false });
    const clone = `0x363d3d373d3d3d363d73${(await impl.getAddress()).slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    expect(await detectProxy(rpc(), "0x0000000000000000000000000000000000000001", clone)).to.deep.include({ isProxy: true, kind: "eip1167-minimal", implementation: implAddress });
  });
});

describe("Example tools: token_risk_check", function () {
  this.timeout(120_000);
  type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let admin: Signer;
  let ownerEoa: Signer;
  let holderEoa: Signer;
  let token: Dyn;
  let tokenAddress: string;
  let vaultContract: Dyn; // a contract that holds the burn role, like QUSDC's vault
  let vaultAddress: string;
  let explorer: ReturnType<typeof fakeExplorer>;

  before(async () => {
    [admin, ownerEoa, holderEoa] = (await ethers.getSigners()) as unknown as [Signer, Signer, Signer];
    token = await deployContract("RoleToken", [admin!.address, ownerEoa!.address]);
    tokenAddress = await token.getAddress();
    vaultContract = await deployContract("MockToken", ["V", 6]); // any contract will do as a holder of the role
    vaultAddress = await vaultContract.getAddress();
    await (await token.connect(admin!).grantRole(VAULT_ROLE, vaultAddress)).wait();
    // A role that was granted and then taken back must not be reported as held.
    await (await token.connect(admin!).grantRole(VAULT_ROLE, holderEoa!.address)).wait();
    await (await token.connect(admin!).revokeRole(VAULT_ROLE, holderEoa!.address)).wait();
    // A holder with a balance, for the simulation's victim: mint as the contract holder using an impersonated account.
    await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0xde0b6b3a7640000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
    const asVault = await ethers.getSigner(vaultAddress);
    await (await token.connect(asVault).mint(holderEoa!.address, 5_000_000n)).wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);
    explorer = fakeExplorer(ethers.provider, { holders: { [tokenAddress.toLowerCase()]: [{ address: holderEoa!.address, value: "5000000" }] } });
  });

  it("finds what the admin can do to holders: who can burn and mint now, who can grant that power, who owns the token", async () => {
    const r = await tokenRiskCheck({ rpc: rpc(), explorer }, tokenAddress);
    expect(r).to.deep.include({ isContract: true, address: tokenAddress });
    expect(r.token).to.deep.include({ name: "Role Token", symbol: "RLT", decimals: 6 });
    expect(r.proxy).to.deep.equal({ isProxy: false });
    expect(r.owner).to.deep.equal({ address: ownerEoa!.address, kind: "EOA" });

    expect(r.accessControl.present).to.equal(true);
    expect(r.accessControl.holdersSource).to.equal("explorer-logs");
    const byName = Object.fromEntries(r.accessControl.roles.map((x) => [x.name, x]));
    expect(byName.VAULT_ROLE!.holders).to.deep.equal([{ address: vaultAddress, kind: "contract" }]); // the revoked holder is gone
    expect(byName.VAULT_ROLE!.adminRoleName).to.equal("DEFAULT_ADMIN_ROLE");
    expect(byName.DEFAULT_ADMIN_ROLE!.holders).to.deep.equal([{ address: admin!.address, kind: "EOA" }]);

    expect(r.burn.simulation).to.deep.equal({ victim: holderEoa!.address, amount: "1" });
    expect(r.burn.canBurnNow.map((x) => [x.address, x.kind])).to.deep.equal([[vaultAddress, "contract"]]);
    expect(r.burn.viaRoleAdmin).to.deep.equal([{ role: "VAULT_ROLE", adminRole: "DEFAULT_ADMIN_ROLE", adminHolders: [{ address: admin!.address, kind: "EOA" }] }]);
    expect(r.mint.canMintNow.map((x) => x.address)).to.deep.equal([vaultAddress]);

    const codes = r.flags.map((f) => f.code);
    for (const c of ["admin_can_burn_holders", "role_admin_can_grant_burn", "supply_can_grow", "owner_is_eoa", "pausable"]) expect(codes, c).to.include(c);
    expect(r.flags.find((f) => f.code === "role_admin_can_grant_burn")!.severity).to.equal("high");
    expect(r.functionsFound.burnFromAnyHolder).to.deep.equal(["burn(address,uint256)"]);
  });

  it("states what it cannot see, and does not call the token safe", async () => {
    const r = await tokenRiskCheck({ rpc: rpc(), explorer }, tokenAddress);
    expect(r.limits.length).to.be.greaterThan(2);
    expect(r.disclaimer).to.match(/not a security review/);
    expect(JSON.stringify(r)).to.not.match(/\bsafe\b|audited|guarantee/i);
  });

  it("says role holders are unavailable, rather than guessing, when the explorer is not there or fails", async () => {
    const none = await tokenRiskCheck({ rpc: rpc() }, tokenAddress);
    expect(none.accessControl.holdersSource).to.equal("unavailable");
    expect(none.flags.map((f) => f.code)).to.include("roles_not_listed");
    expect(none.burn.canBurnNow).to.deep.equal([]); // with no holders listed, nobody can be shown to burn
    const broken = await tokenRiskCheck({ rpc: rpc(), explorer: async () => { throw new Error("down"); } }, tokenAddress);
    expect(broken.accessControl.holdersSource).to.equal("unavailable");
  });

  it("reports an upgradeable proxy as the highest-severity finding, and still reads the logic behind it", async () => {
    const proxy = await deployContract("SlotProxy", [tokenAddress, admin!.address]);
    const proxyAddress = await proxy.getAddress();
    const r = await tokenRiskCheck({ rpc: rpc(), explorer: fakeExplorer(ethers.provider) }, proxyAddress);
    expect(r.proxy).to.deep.include({ isProxy: true, kind: "eip1967", implementation: tokenAddress, admin: admin!.address });
    expect(r.analyzedCode).to.equal(tokenAddress);
    expect(r.flags[0]).to.deep.include({ severity: "high", code: "upgradeable_proxy" });
    expect(r.functionsFound.burnFromAnyHolder).to.deep.equal(["burn(address,uint256)"]);
  });

  it("reports a renounced owner as renounced, not as an EOA", async () => {
    const t = await deployContract("RoleToken", [admin!.address, ZeroHashAddress()]);
    const r = await tokenRiskCheck({ rpc: rpc(), explorer: fakeExplorer(ethers.provider) }, await t.getAddress());
    expect(r.owner).to.deep.equal({ address: ZeroHashAddress(), kind: "renounced" });
    expect(r.flags.map((f) => f.code)).to.not.include("owner_is_eoa");
  });

  it("says plainly that an address with no code is not a token, and that a plain token with no admin functions found is not cleared", async () => {
    const none = await tokenRiskCheck({ rpc: rpc() }, ethers.Wallet.createRandom().address);
    expect(none).to.deep.include({ isContract: false, codeSizeBytes: 0 });
    expect(none.flags[0]).to.deep.include({ code: "not_a_contract", severity: "high" });
    const plain = await deployContract("PlainToken", [1_000_000n]);
    const r = await tokenRiskCheck({ rpc: rpc(), explorer: fakeExplorer(ethers.provider) }, await plain.getAddress());
    expect(r.flags.map((f) => f.code)).to.deep.equal(["nothing_found"]);
    expect(r.flags[0]!.text).to.match(/not a clean bill of health/);
    // A token whose mint anyone can call is reported as such, not cleared.
    const open = await deployContract("MockToken", ["OPN", 6]);
    const o = await tokenRiskCheck({ rpc: rpc(), explorer: fakeExplorer(ethers.provider) }, await open.getAddress());
    expect(o.mint.anyoneCanCall).to.equal(true);
    expect(o.flags.map((f) => f.code)).to.include("supply_can_grow");
  });

  it("rejects an address that is not an address", async () => {
    await rejection(tokenRiskCheck({ rpc: rpc() }, "not-an-address"));
  });
});

function ZeroHashAddress(): string {
  return `0x${"0".repeat(40)}`;
}

describe("Example tools: dex_quote", function () {
  let wqie: Dyn;
  let qusdc: Dyn;
  let other: Dyn;
  let cfg: { factory: string; router: string; wqie: string };
  let factory: Dyn;
  const RIN = 28_237_539_588_918_300_797_359n; // WQIE reserve, from the QIEDEX pool measured on 2026-11-19
  const ROUT = 4_631_139_519n; // QUSDC reserve

  before(async () => {
    wqie = await deployContract("MockToken", ["WQIE", 18]);
    qusdc = await deployContract("MockToken", ["QUSDC", 6]);
    other = await deployContract("MockToken", ["OTH", 8]);
    factory = await deployContract("MockFactory");
    const pair = await deployContract("MockPair", [await wqie.getAddress(), await qusdc.getAddress()]);
    await pair.setReserves(await wqie.getAddress(), RIN, ROUT);
    await factory.setPair(await wqie.getAddress(), await qusdc.getAddress(), await pair.getAddress());
    const pair2 = await deployContract("MockPair", [await other.getAddress(), await wqie.getAddress()]);
    await pair2.setReserves(await other.getAddress(), 5_000_000_000_000n, 10_000n * 10n ** 18n);
    await factory.setPair(await other.getAddress(), await wqie.getAddress(), await pair2.getAddress());
    const router = await deployContract("MockRouter", [await factory.getAddress(), await wqie.getAddress(), 997]);
    cfg = { factory: await factory.getAddress(), router: await router.getAddress(), wqie: await wqie.getAddress() };
  });

  it("computes the pool formula exactly, and the measured QIEDEX example", () => {
    expect(amountOut(100n * 10n ** 18n, RIN, ROUT)).to.equal(16_293_916n); // what QIEDEX's router returned for 100 WQIE
    expect(amountOut(0n, RIN, ROUT)).to.equal(0n);
    expect(amountOut(1n, 0n, ROUT)).to.equal(0n);
  });

  it("quotes a swap, agrees with the router, and gives the slippage floor", async () => {
    const q = await dexQuote(rpc(), { tokenIn: await wqie.getAddress(), tokenOut: await qusdc.getAddress(), amountIn: "100", slippageBps: 100 }, cfg);
    expect(q.amountOutUnits).to.equal("16293916");
    expect(q.amountOut).to.equal("16.293916");
    expect(q.minAmountOut).to.equal("16.130976"); // 16,293,916 x (10,000 - 100) / 10,000, rounded down
    expect(q.matchesRouter).to.equal(true);
    expect(q.routerAmountOutUnits).to.equal("16293916");
    expect(q.feeBps).to.equal(30);
    expect(q.slippageBps).to.equal(100);
    expect(q.path).to.deep.equal([await wqie.getAddress(), await qusdc.getAddress()]);
    expect(q.hops).to.have.length(1);
    expect(q.tokenIn).to.deep.include({ symbol: "WQIE", decimals: 18 });
    expect(q.tokenOut).to.deep.include({ symbol: "QUSDC", decimals: 6 });
    // 100 of 28,237 is 0.35% of the pool: the impact is small, and the fee is the bulk of the cost against spot.
    expect(q.priceImpactBps).to.be.within(30, 40);
    expect(q.costVsSpotBps).to.be.within(q.priceImpactBps + 29, q.priceImpactBps + 31);
    expect(Number(q.spotPrice)).to.be.within(0.1639, 0.1641);
    expect(Number(q.executionPrice)).to.be.below(Number(q.spotPrice));
    expect(q.warnings).to.deep.equal([]);
  });

  it("takes the native coin as QIE, and the same pool the other way round", async () => {
    const q = await dexQuote(rpc(), { tokenIn: "QIE", tokenOut: await qusdc.getAddress(), amountIn: "100" }, cfg);
    expect(q.amountOutUnits).to.equal("16293916");
    expect(q.slippageBps).to.equal(50);
    const back = await dexQuote(rpc(), { tokenIn: await qusdc.getAddress(), tokenOut: "qie", amountIn: "10" }, cfg);
    expect(back.amountOutUnits).to.equal(amountOut(10_000_000n, ROUT, RIN).toString());
    expect(back.matchesRouter).to.equal(true);
  });

  it("routes through WQIE when there is no direct pool, and sums the impact of both hops", async () => {
    const q = await dexQuote(rpc(), { tokenIn: await other.getAddress(), tokenOut: await qusdc.getAddress(), amountIn: "1000" }, cfg);
    expect(q.path).to.have.length(3);
    expect(q.hops).to.have.length(2);
    const hop1 = amountOut(parseUnits("1000", 8), 5_000_000_000_000n, 10_000n * 10n ** 18n);
    expect(q.hops[0]!.amountOut).to.equal(hop1.toString());
    expect(q.amountOutUnits).to.equal(amountOut(hop1, RIN, ROUT).toString());
    expect(q.matchesRouter).to.equal(true);
  });

  it("warns on a trade that is a large share of the pool, and when the router disagrees with the pool formula", async () => {
    const big = await dexQuote(rpc(), { tokenIn: await wqie.getAddress(), tokenOut: await qusdc.getAddress(), amountIn: "10000" }, cfg);
    expect(big.warnings.join(" ")).to.match(/more than 1% of the pool/);
    expect(big.priceImpactBps).to.be.greaterThan(2500);
    const oddRouter = await deployContract("MockRouter", [cfg.factory, cfg.wqie, 990]);
    const odd = await dexQuote(rpc(), { tokenIn: await wqie.getAddress(), tokenOut: await qusdc.getAddress(), amountIn: "100" }, { ...cfg, router: await oddRouter.getAddress() });
    expect(odd.matchesRouter).to.equal(false);
    expect(odd.warnings.join(" ")).to.match(/router's own quote differs/);
    const noRouter = await dexQuote(rpc(), { tokenIn: await wqie.getAddress(), tokenOut: await qusdc.getAddress(), amountIn: "100" }, { ...cfg, router: ZeroHashAddress() });
    expect(noRouter.warnings.join(" ")).to.match(/router could not be asked/);
  });

  it("refuses what it cannot quote, with a message that names the problem", async () => {
    const t = (over: Record<string, unknown>) =>
      dexQuote(rpc(), { tokenIn: "QIE", tokenOut: "0x0000000000000000000000000000000000000001", amountIn: "1", ...over } as never, cfg);
    const q = await qusdc.getAddress();
    const w = await wqie.getAddress();
    expect((await rejection(dexQuote(rpc(), { tokenIn: w, tokenOut: w, amountIn: "1" }, cfg))).message).to.match(/same token/);
    expect((await rejection(dexQuote(rpc(), { tokenIn: w, tokenOut: q, amountIn: "0" }, cfg))).message).to.match(/above zero/);
    expect((await rejection(dexQuote(rpc(), { tokenIn: w, tokenOut: q, amountIn: "1.0000000000000000001" }, cfg))).message).to.match(/at most 18 places/);
    expect((await rejection(dexQuote(rpc(), { tokenIn: w, tokenOut: q, amountIn: "abc" }, cfg))).message).to.match(/decimal/);
    expect((await rejection(dexQuote(rpc(), { tokenIn: w, tokenOut: q, amountIn: "1", slippageBps: 9999 }, cfg))).message).to.match(/0 to 5000/);
    expect((await rejection(dexQuote(rpc(), { tokenIn: w, tokenOut: q, amountIn: "1", slippageBps: 1.5 }, cfg))).message).to.match(/whole number/);
    expect((await rejection(t({}))).message).to.match(/not a token/);
    const lonely = await deployContract("MockToken", ["LON", 6]);
    const err = await rejection(dexQuote(rpc(), { tokenIn: await lonely.getAddress(), tokenOut: q, amountIn: "1" }, cfg));
    expect(err).to.be.instanceOf(DexQuoteError);
    expect(err.message).to.match(/no pool/);
  });

  it("knows where QIEDEX is, from the router's own answers", () => {
    expect(QIEDEX.factory).to.equal("0x8E23128a5511223bE6c0d64106e2D4508C08398C");
    expect(QIEDEX.router).to.equal("0x08cd2e72e156D8563B4351eb4065C262A9f553Ef");
    expect(QIEDEX.wqie).to.equal("0x0087904D95BEe9E5F24dc8852804b547981A9139");
  });
});

describe("Example tools: contract_lookup", function () {
  let target: Dyn;
  let targetAddress: string;
  let code: string;

  before(async () => {
    target = await deployContract("RoleToken", [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address]);
    targetAddress = await target.getAddress();
    code = await ethers.provider.getCode(targetAddress);
  });

  const verifiedBody = (over: Record<string, unknown> = {}) => ({
    name: "RoleToken", is_verified: true, is_fully_verified: true, compiler_version: "v0.8.24+commit.e11b9ed9", evm_version: "shanghai",
    optimization_enabled: true, optimization_runs: 200, license_type: "mit", language: "solidity", verified_at: "2026-11-19T00:00:00Z",
    source_code: "contract RoleToken {}", additional_sources: [{ file_path: "a.sol", source_code: "" }], deployed_bytecode: code,
    abi: [
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }] },
      { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }] },
      { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }] },
      { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [] },
      { type: "event", name: "Transfer", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }] },
    ],
    ...over,
  });

  it("reports verification, compiler, proxy status and that the explorer's bytecode matches the node's", async () => {
    const explorer = fakeExplorer(ethers.provider, {
      contracts: { [targetAddress.toLowerCase()]: verifiedBody() },
      addresses: { [targetAddress.toLowerCase()]: { creator_address_hash: "0x00000000000000000000000000000000000000aa", creation_transaction_hash: `0x${"ab".repeat(32)}` } },
    });
    const r = await contractLookup({ rpc: rpc(), explorer }, targetAddress);
    expect(r).to.deep.include({ isContract: true, address: targetAddress });
    expect(r.codeHash).to.equal(keccak256(code));
    expect(r.compilerFromBytecode?.solc).to.equal("0.8.24");
    expect(r.proxy).to.deep.equal({ isProxy: false });
    expect(r.explorer).to.deep.include({
      available: true, verified: true, name: "RoleToken", compilerVersion: "v0.8.24+commit.e11b9ed9", evmVersion: "shanghai", optimization: true,
      optimizationRuns: 200, license: "mit", fullyVerified: true, sourceFiles: 2, bytecodeMatchesNode: true, compilerMatchesBytecode: true,
      creator: getAddress("0x00000000000000000000000000000000000000aa"), creationTransaction: `0x${"ab".repeat(32)}`,
    });
    expect(r.explorer.abi).to.deep.equal({ readFunctions: 1, writeFunctions: ["mint(address,uint256)", "transfer(address,uint256)", "pause()"], events: ["Transfer(address,address,uint256)"], adminLike: ["mint(address,uint256)", "pause()"] });
  });

  it("flags an explorer copy whose bytecode differs from what is deployed", async () => {
    const explorer = fakeExplorer(ethers.provider, { contracts: { [targetAddress.toLowerCase()]: verifiedBody({ deployed_bytecode: `${code}00` }) } });
    const r = await contractLookup({ rpc: rpc(), explorer }, targetAddress);
    expect(r.explorer.bytecodeMatchesNode).to.equal(false);
    expect(r.notes.join(" ")).to.match(/differs from the node's/);
  });

  it("says a contract is unverified when the explorer has no source, and that the explorer was down when it was", async () => {
    const none = await contractLookup({ rpc: rpc(), explorer: fakeExplorer(ethers.provider) }, targetAddress);
    expect(none.explorer).to.deep.include({ available: true, verified: false });
    expect(none.codeHash).to.equal(keccak256(code));
    const down = await contractLookup({ rpc: rpc(), explorer: async () => { throw new Error("down"); } }, targetAddress);
    expect(down.explorer).to.deep.include({ available: false });
    expect(down.codeSizeBytes).to.be.greaterThan(100);
    const absent = await contractLookup({ rpc: rpc() }, targetAddress);
    expect(absent.explorer.reason).to.match(/no explorer/);
    const eoa = await contractLookup({ rpc: rpc() }, ethers.Wallet.createRandom().address);
    expect(eoa).to.deep.include({ isContract: false });
  });

  it("warns that the verified source of a proxy may describe the proxy and not its logic", async () => {
    const proxy = await deployContract("SlotProxy", [targetAddress, ethers.Wallet.createRandom().address]);
    const proxyAddress = await proxy.getAddress();
    const proxyCode = await ethers.provider.getCode(proxyAddress);
    const explorer = fakeExplorer(ethers.provider, { contracts: { [proxyAddress.toLowerCase()]: verifiedBody({ name: "SlotProxy", deployed_bytecode: proxyCode }) } });
    const r = await contractLookup({ rpc: rpc(), explorer }, proxyAddress);
    expect(r.proxy).to.deep.include({ isProxy: true, implementation: targetAddress });
    expect(r.notes.join(" ")).to.match(/proxy: the verified source above may describe the proxy/);
  });
});

describe("Example tools: the explorer client reads one explorer, over https, and nothing else", () => {
  it("refuses a plain-http remote explorer and a path that leaves the explorer's origin", async () => {
    expect(() => explorerClient("http://example.com")).to.throw(/https/);
    const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const get = explorerClient(`http://127.0.0.1:${port}`);
      expect(await get("/x")).to.deep.equal({ status: 200, json: { ok: true } });
      expect((await rejection(get("http://127.0.0.1:1/other"))).message).to.match(/origin/);
      expect((await rejection(get("https://evil.example/steal"))).message).to.match(/origin/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lists the prices the tools charge", () => {
    expect(DEFAULT_PRICES).to.deep.equal({ token_risk_check: "0.01", dex_quote: "0.002", contract_lookup: "0.005" });
  });
});
