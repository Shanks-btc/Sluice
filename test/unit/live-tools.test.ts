// The go-live tooling, on a local chain: the pre-flight check, the dry run, the contract verification, the testnet token and the key
// maker. None of it sends a real transaction. The local chain has QIE mainnet's chain id (1990), so a test that needs "mainnet" puts a test
// token's code at QUSDC's address on the local chain, which is the stand-in for the real thing.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { JsonRpcProvider, Network, Wallet, getAddress, keccak256, parseEther } from "ethers";
import { ethers, network } from "hardhat";
import { dyn } from "../../src/dyn";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, SMOKE_STEPS_GAS, costWei } from "../../src/gas-figures";
import { MAX_GAS_PRICE_WEI, QUSDC_ADDRESS, SpendMeter } from "../../src/guard";
import { DEFAULT_SMOKE_AMOUNTS, loadArtifact } from "../../src/live";
import { PREFLIGHT_READ_ONLY_METHODS, formatPreflight, preflight } from "../../src/preflight";
import type { PreflightInput } from "../../src/preflight";
import { decodeCall, dryRunDeploy, dryRunSmoke, formatDryRun } from "../../src/dryrun";
import { EXPECTED, VerifyError, buildInput, constructorArguments, flatten, submitVerification, vaultConstructorArguments } from "../../src/verify-contracts";
import { TESTNET_CHAIN_ID, TEST_TOKEN_MINT, deployTestToken, testTokenPlan } from "../../src/test-token";
import { readOnlyRpc } from "../../src/readrpc";
import { copyable, safeReaddir } from "../../src/secret-paths";
import { main as preflightMain } from "../../scripts/live/preflight";
import { main as verifyMain } from "../../scripts/live/verify-contracts";
import { main as deployMain } from "../../scripts/live/deploy";
import { main as smokeMain } from "../../scripts/live/smoke";
import { main as tokenMain } from "../../scripts/live/deploy-test-token";
import { main as newKey } from "../../scripts/live/new-key";
import { deployContract, USDC } from "../helpers";
import { rejection } from "../helpers/assert";
import { startChaosProxy } from "../helpers/chaos";
import { setQie, startStack, throwawayWallet } from "../helpers/stack";
import type { Stack } from "../helpers/stack";

const ROOT = join(__dirname, "..", "..");

describe("Gas figures: the numbers the funding plan, the pre-flight check and the dry run use", () => {
  const doc = readFileSync(join(ROOT, "docs", "GAS.md"), "utf8");
  const gas = (label: string): bigint => {
    const row = doc.split("\n").find((l) => l.startsWith(`| ${label} |`));
    if (!row) throw new Error(`no row for ${label}`);
    return BigInt((row.split("|")[2] as string).trim().replace(/,/g, ""));
  };

  it("are the ones in docs/GAS.md, row for row", () => {
    expect(MEASURED_GAS.deployRouter).to.equal(gas("Deploy the router (creates the vault)"));
    expect(MEASURED_GAS.approve).to.equal(gas("Approve QUSDC for the router"));
    expect(MEASURED_GAS.depositFirst).to.equal(gas("Deposit, first for this payer"));
    expect(MEASURED_GAS.settleFirst).to.equal(gas("Settle, first payment to a builder"));
    expect(MEASURED_GAS.authorize).to.equal(gas("Authorize an agent, one tool"));
    expect(MEASURED_GAS.settleByAgentFirst).to.equal(gas("Settle signed by an agent, first spend"));
    expect(MEASURED_GAS.revoke).to.equal(gas("Revoke an agent"));
    expect(MEASURED_GAS.withdraw).to.equal(gas("Withdraw, part of earnings"));
    expect(MEASURED_GAS.refund).to.equal(gas("Refund, part of the balance"));
    expect(MEASURED_GAS.topUpTransfer).to.equal(gas("QIE top-up transfer by a facilitator, for a wallet with no QIE"));
    const batch = doc.split("\n").find((l) => l.startsWith("| 50 |") && l.includes("3,291,319"));
    expect(batch, "the largest batch measured").to.not.equal(undefined);
    expect(MEASURED_GAS.batch50Worst).to.equal(3_291_319n);
  });

  it("include the batch, signature and top-up figures the funding calculator budgets from, row for row", () => {
    expect(MEASURED_GAS.authorizeBySig).to.equal(gas("Authorize an agent by signature, one tool"));
    expect(MEASURED_GAS.withdrawBySig).to.equal(gas("Withdraw by signature, through a relayer"));
    expect(MEASURED_GAS.refundBySig).to.equal(gas("Refund by signature, through a relayer"));
    // Scenario B (every intent from a different payer to a different builder), batch sizes 1 and 10.
    const scenarioB = doc.split("## Batch settle, scenario B")[1]?.split("\n## ")[0] ?? "";
    const batch = (size: number): bigint => {
      const row = scenarioB.split("\n").find((l) => l.startsWith(`| ${size} |`));
      if (!row) throw new Error(`no scenario B row for ${size}`);
      return BigInt((row.split("|")[2] as string).trim().replace(/,/g, ""));
    };
    expect(MEASURED_GAS.batch1Worst).to.equal(batch(1));
    expect(MEASURED_GAS.batch10Worst).to.equal(batch(10));
    expect(MEASURED_GAS.batch50Worst).to.equal(batch(50));
  });

  it("sum to the smoke run's eight transactions", () => {
    expect(SMOKE_STEPS_GAS).to.have.length(8);
    expect(SMOKE_GAS_TOTAL).to.equal(636_021n);
    expect(costWei(100n, 10n)).to.equal(1000n);
    expect(costWei(100n, 10n, 50n)).to.equal(1500n);
  });
});

describe("Pre-flight: the read-only check before a live run", function () {
  this.timeout(180_000);
  let s: Stack;
  let deployer: Wallet;
  let relayer: Wallet;
  let router: string;
  let vault: string;
  let deployment: { router: string; vault: string; routerCodeHash: string; vaultCodeHash: string };
  let proxy: Awaited<ReturnType<typeof startChaosProxy>>;

  const input = (over: Partial<PreflightInput> = {}): PreflightInput => ({
    network: "mainnet", rpcUrls: [s.rpcUrl], phase: "post-deploy", deployer: deployer.address, relayer: relayer.address, router, deployment, ...over,
  });
  const failed = async (over: Partial<PreflightInput>, deps = {}) => (await preflight(input(over), deps)).failed;

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    const code = loadArtifact("MockQUSDC", "test").deployedBytecode;
    await network.provider.send("hardhat_setCode", [QUSDC_ADDRESS, code]); // the stand-in for QUSDC on this local chain
    const [owner, feeRecipient] = await ethers.getSigners();
    const r = await deployContract("PaymentRouter", [QUSDC_ADDRESS, owner!.address, feeRecipient!.address, 100]);
    router = getAddress(await r.getAddress());
    vault = getAddress((await r.vault()) as string);
    deployer = throwawayWallet();
    relayer = throwawayWallet();
    await setQie(deployer.address, parseEther("1"));
    await setQie(relayer.address, parseEther("1"));
    const token = new ethers.Contract(QUSDC_ADDRESS, ["function mint(address,uint256)"], (await ethers.getSigners())[0]!);
    await (await token.getFunction("mint")(deployer.address, USDC("20"))).wait();
    deployment = { router, vault, routerCodeHash: keccak256(await s.provider.getCode(router)), vaultCodeHash: keccak256(await s.provider.getCode(vault)) };
  });
  afterEach(async () => {
    await proxy?.close();
    await s.stop();
  });

  it("says GO when the chain, QUSDC, the balances and the router are all right, and every check is named", async () => {
    const result = await preflight(input());
    expect(result.failed, JSON.stringify(result.checks)).to.deep.equal([]);
    expect(result.go).to.equal(true);
    const names = result.checks.map((c) => c.name);
    expect(names).to.include.members(["RPC endpoints", "Chain id", "Gas price", "QUSDC", "Deployer QIE", "Deployer QUSDC", "Relayer QIE", "Router", "Deployed code"]);
    const text = formatPreflight(result, "mainnet").join("\n");
    expect(text).to.match(/GO on mainnet/);
    expect(text).to.contain(router);
  });

  it("says NO-GO on the wrong chain, and names the check", async () => {
    expect(await failed({ network: "testnet", token: QUSDC_ADDRESS })).to.include("Chain id");
    const result = await preflight(input({ network: "testnet", token: QUSDC_ADDRESS }));
    expect(result.go).to.equal(false);
    expect(formatPreflight(result, "testnet").join("\n")).to.match(/NO-GO on testnet: .*Chain id/);
  });

  it("says NO-GO when QUSDC has no code, or does not have six decimals", async () => {
    // A node that says there is no code at QUSDC (Hardhat's setCode cannot remove code, so the answer is given by a wrapper).
    const real = readOnlyRpc([s.rpcUrl], PREFLIGHT_READ_ONLY_METHODS);
    const noCode = async (method: string, params: unknown[]) => (method === "eth_getCode" && String(params[0]).toLowerCase() === QUSDC_ADDRESS.toLowerCase() ? "0x" : real(method, params));
    const bare = await preflight(input({ router: undefined, phase: "pre-deploy", deployment: undefined, deployer: undefined, relayer: undefined }), { rpc: noCode });
    expect(bare.checks.find((c) => c.name === "QUSDC")).to.deep.include({ status: "FAIL" });
    expect(bare.checks.find((c) => c.name === "QUSDC")?.detail).to.match(/there is no contract at/);
    expect(bare.go).to.equal(false);
    const odd = await deployContract("MockToken", ["T", 18]);
    await network.provider.send("hardhat_setCode", [QUSDC_ADDRESS, await s.provider.getCode(await odd.getAddress())]); // code whose decimals() is not 6
    const result = await preflight(input({ router: undefined, phase: "pre-deploy", deployment: undefined }));
    expect(result.checks.find((c) => c.name === "QUSDC")?.status).to.equal("FAIL");
  });

  it("says NO-GO when the deployer or the relayer holds too little, and warns when the relayer is under one day's budget", async () => {
    await setQie(deployer.address, 1n);
    expect(await failed({})).to.include("Deployer QIE");
    await setQie(deployer.address, parseEther("1"));
    await setQie(relayer.address, 1n);
    expect(await failed({})).to.include("Relayer QIE");
    await setQie(relayer.address, parseEther("0.1")); // above the floor, below a day's 0.5
    const result = await preflight(input());
    expect(result.checks.find((c) => c.name === "Relayer QIE")?.status).to.equal("WARN");
    expect(result.go).to.equal(true);
    expect(result.warned).to.deep.equal(["Relayer QIE"]);
  });

  it("warns when the deployer holds QUSDC for the smoke run but not for a funded run, and fails below the smoke run's deposit", async () => {
    const token = new ethers.Contract(QUSDC_ADDRESS, ["function burnFrom(address,uint256)", "function mint(address,uint256)"], (await ethers.getSigners())[0]!);
    await (await token.getFunction("burnFrom")(deployer.address, USDC("19.5"))).wait(); // 0.5 left
    expect((await preflight(input())).checks.find((c) => c.name === "Deployer QUSDC")?.status).to.equal("WARN");
    await (await token.getFunction("burnFrom")(deployer.address, USDC("0.3"))).wait(); // 0.2 left
    expect(await failed({})).to.include("Deployer QUSDC");
  });

  it("says NO-GO when the deployer and the relayer are the same address", async () => {
    expect(await failed({ relayer: deployer.address })).to.include("Deployer and relayer");
  });

  it("checks the gas price against the live scripts' stop and the facilitator's ceiling", async () => {
    const real = readOnlyRpc([s.rpcUrl], PREFLIGHT_READ_ONLY_METHODS);
    const priced = (wei: bigint) => async (method: string, params: unknown[]) => (method === "eth_gasPrice" ? `0x${wei.toString(16)}` : real(method, params));
    expect((await preflight(input(), { rpc: priced(1_125_000_000n) })).checks.find((c) => c.name === "Gas price")?.status).to.equal("PASS");
    expect((await preflight(input(), { rpc: priced(6_000_000_000n) })).checks.find((c) => c.name === "Gas price")?.status).to.equal("WARN");
    expect((await preflight(input(), { rpc: priced(MAX_GAS_PRICE_WEI + 1n) })).checks.find((c) => c.name === "Gas price")?.status).to.equal("FAIL");
  });

  it("says NO-GO when the router is missing, is not a Sluice router, holds the wrong token, or the relayer owns it", async () => {
    expect(await failed({ router: undefined })).to.include("Router");
    expect(await failed({ router: throwawayWallet().address })).to.include("Router");
    expect(await failed({ router: QUSDC_ADDRESS })).to.include("Router");
    expect(await failed({ router: "nope" })).to.include("Router");
    const [owner, fee] = await ethers.getSigners();
    const other = await deployContract("PaymentRouter", [s.tokenAddress, owner!.address, fee!.address, 100]); // holds a test token, not QUSDC
    const wrongToken = await preflight(input({ router: await other.getAddress(), deployment: undefined }));
    expect(wrongToken.checks.find((c) => c.name === "Router")?.detail).to.match(/not QUSDC/);
    const owned = await deployContract("PaymentRouter", [QUSDC_ADDRESS, relayer.address, fee!.address, 100]);
    expect((await preflight(input({ router: await owned.getAddress(), deployment: undefined }))).checks.find((c) => c.name === "Router")?.detail).to.match(/owner or its fee recipient/);
  });

  it("compares the router's code with the hash recorded at deployment, and fails when it differs", async () => {
    expect(await failed({ deployment: { ...deployment, routerCodeHash: keccak256("0x00") } })).to.include("Deployed code");
    expect(await failed({ deployment: { ...deployment, vaultCodeHash: keccak256("0x00") } })).to.include("Deployed code");
    expect(await failed({ deployment: { ...deployment, router: throwawayWallet().address } })).to.include("Deployed code");
    const none = await preflight(input({ deployment: undefined }));
    expect(none.checks.find((c) => c.name === "Deployed code")?.status).to.equal("SKIP");
    expect(none.go).to.equal(true); // a missing record is not a failure, but it is not a pass
  });

  it("before a deploy, skips the router and the code hash, and does not fail for them", async () => {
    const result = await preflight(input({ router: undefined, phase: "pre-deploy", deployment: undefined }));
    expect(result.checks.find((c) => c.name === "Router")?.status).to.equal("SKIP");
    expect(result.go).to.equal(true);
  });

  it("answers for each endpoint on its own, warns when only one of several answers, and fails when none does", async () => {
    const one = await preflight(input({ rpcUrls: [s.rpcUrl, "http://127.0.0.1:1"] }));
    expect(one.checks.find((c) => c.name === "RPC endpoints")?.status).to.equal("WARN");
    expect(one.go).to.equal(true);
    const none = await preflight(input({ rpcUrls: ["http://127.0.0.1:1", "http://127.0.0.1:2"] }));
    expect(none.go).to.equal(false);
    expect(none.checks.find((c) => c.name === "RPC endpoints")?.status).to.equal("FAIL");
    expect(none.checks.find((c) => c.name === "Chain id")?.detail).to.match(/no RPC endpoint could be read/);
    const both = await preflight(input({ rpcUrls: [s.rpcUrl, s.rpcUrl] }));
    expect(both.checks.find((c) => c.name === "RPC endpoints")?.status).to.equal("PASS");
    expect(both.checks.find((c) => c.name === "Endpoints agree on the chain's height")?.status).to.equal("PASS");
  });

  it("reports an explorer that does not answer as a warning only", async () => {
    const result = await preflight(input(), { explorerReachable: async () => false });
    expect(result.checks.find((c) => c.name === "Explorer")?.status).to.equal("WARN");
    expect(result.go).to.equal(true);
  });

  it("asks the node only read-only questions, and holds no key", async () => {
    proxy = await startChaosProxy(s.rpcUrl);
    await preflight(input({ rpcUrls: [proxy.url] }));
    expect(proxy.seen.length).to.be.greaterThan(8);
    for (const method of proxy.seen) expect(PREFLIGHT_READ_ONLY_METHODS.has(method), method).to.equal(true);
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign"]) expect(PREFLIGHT_READ_ONLY_METHODS.has(method)).to.equal(false);
    expect([...PREFLIGHT_READ_ONLY_METHODS].sort()).to.deep.equal(["eth_blockNumber", "eth_call", "eth_chainId", "eth_gasPrice", "eth_getBalance", "eth_getCode", "eth_getStorageAt"]);
  });

  describe("the command", () => {
    // The command reads deployment.json in the folder it is run from, so a case with no record of its own is run in an empty folder.
    let empty: string;
    before(() => {
      empty = mkdtempSync(join(tmpdir(), "sluice-pre-empty-"));
    });
    after(() => rmSync(empty, { recursive: true, force: true }));
    const run = async (args: string[], env: Record<string, string | undefined>, cwd: string = empty) => {
      const lines: string[] = [];
      const code = await preflightMain(args, env, { log: (l) => lines.push(l), cwd });
      return { code, text: lines.join("\n") };
    };

    it("exits 0 and says GO for a good deployment, reading the deployment record and taking addresses from keys without printing them", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sluice-pre-"));
      try {
        writeFileSync(join(dir, "deployment.json"), JSON.stringify(deployment));
        const env = { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: s.rpcUrl, SLUICE_ROUTER: router, SLUICE_KEY: deployer.privateKey, SLUICE_RELAYER_KEY: relayer.privateKey };
        const out = await run([], env, dir);
        expect(out.code, out.text).to.equal(0);
        expect(out.text).to.match(/GO on mainnet/);
        expect(out.text).to.contain("post-deploy");
        expect(out.text).to.not.contain(deployer.privateKey);
        expect(out.text).to.not.contain(relayer.privateKey);
        expect(out.text).to.not.contain(deployer.privateKey.slice(2));
        expect(out.text).to.contain("Deployed code: the router's and the vault's code hash match the deployment record");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits 1 and says NO-GO when a check fails, and 2 when the chain cannot be read at all", async () => {
      const env = { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: s.rpcUrl, SLUICE_ROUTER: throwawayWallet().address };
      const bad = await run(["--deployer", deployer.address], env);
      expect(bad.code).to.equal(1);
      expect(bad.text).to.match(/NO-GO on mainnet: .*Router/);
      const down = await run([], { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: "http://127.0.0.1:1" });
      expect(down.code).to.equal(2);
    });

    it("refuses a wrong command with a reason", async () => {
      expect((await run([], {})).text).to.match(/set SLUICE_NETWORK/);
      expect((await run(["--phase", "later"], { SLUICE_NETWORK: "mainnet" })).text).to.match(/pre-deploy or post-deploy/);
      expect((await run(["--bogus"], { SLUICE_NETWORK: "mainnet" })).text).to.match(/unknown option/);
      expect((await run(["--deployer", "nope"], { SLUICE_NETWORK: "mainnet" })).text).to.match(/not an address/);
      expect((await run([], { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: "http://rpc.example.com" })).text).to.match(/must be https/);
      for (const r of [await run(["--phase"], { SLUICE_NETWORK: "mainnet" })]) expect(r.code).to.equal(1);
    });
  });
});

describe("Dry run: what a live script would send, without sending it", function () {
  this.timeout(180_000);
  let s: Stack;
  let proxy: Awaited<ReturnType<typeof startChaosProxy>>;
  let provider: JsonRpcProvider;
  let signer: Wallet;

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    proxy = await startChaosProxy(s.rpcUrl);
    const net = Network.from(1990);
    provider = new JsonRpcProvider(proxy.url, net, { staticNetwork: net });
    signer = throwawayWallet();
    await setQie(signer.address, parseEther("1"));
  });
  afterEach(async () => {
    provider.destroy();
    await proxy.close();
    await s.stop();
  });

  const unchanged = async (run: () => Promise<unknown>) => {
    const before = { nonce: await s.provider.getTransactionCount(signer.address), balance: await s.provider.getBalance(signer.address), block: await s.provider.getBlockNumber() };
    await run();
    expect(await s.provider.getTransactionCount(signer.address), "no transaction was sent").to.equal(before.nonce);
    expect(await s.provider.getBalance(signer.address)).to.equal(before.balance);
    expect(await s.provider.getBlockNumber(), "no block was mined").to.equal(before.block);
    expect(proxy.seen.filter((m) => /^eth_send|sendRawTransaction/.test(m))).to.deep.equal([]);
  };

  it("shows the deployment: where it goes, what its call data decodes to, and what it would cost, and sends nothing", async () => {
    const [owner, fee] = await ethers.getSigners();
    const params = { token: s.tokenAddress, owner: owner!.address, feeRecipient: fee!.address, feeBps: 100 };
    let report!: Awaited<ReturnType<typeof dryRunDeploy>>;
    await unchanged(async () => {
      report = await dryRunDeploy(provider, signer.address, params);
    });
    expect(report.txs).to.have.length(1);
    const tx = report.txs[0]!;
    expect(tx.to).to.equal(null);
    expect(tx.value).to.equal(0n);
    expect(tx.decoded).to.equal(`PaymentRouter(token=${getAddress(s.tokenAddress)}, owner=${owner!.address}, feeRecipient=${fee!.address}, feeBps=100)`);
    expect(tx.gasSource).to.equal("estimated by the node");
    expect(tx.gasLimit > 2_000_000n && tx.gasLimit < 5_000_000n).to.equal(true);
    expect(tx.costWei).to.equal(tx.gasLimit * report.gasPrice);
    expect(report.totalCostWei).to.equal(tx.costWei);
    const text = formatDryRun(report, parseEther("5")).join("\n");
    expect(text).to.contain("DRY RUN of deploy: nothing is sent");
    expect(text).to.contain("(creates a contract)");
    expect(text).to.contain("the plan fits");
    expect(formatDryRun(report, 1n).join("\n")).to.contain("DOES NOT fit");
  });

  it("shows each of the smoke run's eight transactions, decoded, with the gas the node can estimate or the measured figure, and sends nothing", async () => {
    let report!: Awaited<ReturnType<typeof dryRunSmoke>>;
    await unchanged(async () => {
      report = await dryRunSmoke(provider, signer.address, { router: s.routerAddress }, DEFAULT_SMOKE_AMOUNTS);
    });
    expect(report.txs.map((t) => t.step)).to.deep.equal(SMOKE_STEPS_GAS.map(([name]) => name));
    for (const tx of report.txs) {
      expect(tx.value, tx.step).to.equal(0n);
      expect(tx.to, tx.step).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(tx.costWei, tx.step).to.equal(tx.gasLimit * report.gasPrice);
    }
    const byStep = Object.fromEntries(report.txs.map((t) => [t.step, t]));
    expect(byStep.approve?.to).to.equal(getAddress(s.tokenAddress));
    expect(byStep.approve?.decoded).to.equal(`approve(spender=${getAddress(s.routerAddress)}, amount=${DEFAULT_SMOKE_AMOUNTS.deposit})`);
    expect(byStep.approve?.gasSource).to.equal("estimated by the node");
    expect(byStep.deposit?.to).to.equal(getAddress(s.routerAddress));
    expect(byStep.deposit?.decoded).to.equal(`deposit(amount=${DEFAULT_SMOKE_AMOUNTS.deposit})`);
    expect(byStep["authorize agent"]?.to).to.equal(getAddress(s.vaultAddress));
    expect(byStep["settle (payer-signed)"]?.decoded).to.match(/^settle\(intent=\{payer=0x[0-9a-fA-F]{40}, payee=/);
    // A step that depends on an earlier one is given the measured figure and says so.
    expect(report.txs.filter((t) => t.gasSource.startsWith("measured")).length).to.be.greaterThan(0);
    expect(report.totalGas).to.equal(report.txs.reduce((a, t) => a + t.gasLimit, 0n));
    const text = formatDryRun(report, parseEther("5")).join("\n");
    expect(text).to.contain("8. refund");
    expect(text).to.contain("placeholder".slice(0, 0) + "DRY RUN of smoke");
  });

  it("decodes call data back to the call, and refuses call data that is not the call", () => {
    const iface = new ethers.Interface(["function approve(address spender, uint256 amount)"]);
    expect(decodeCall(iface, iface.encodeFunctionData("approve", [s.routerAddress, 5n]))).to.equal(`approve(spender=${getAddress(s.routerAddress)}, amount=5)`);
    expect(() => decodeCall(iface, "0x12345678")).to.throw();
  });

  it("is what `--dry-run` does in deploy.ts and smoke.ts: the plan is printed, the guard still applies, and nothing is sent", async () => {
    const [owner, fee, relayer] = await ethers.getSigners();
    const env = {
      SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: signer.privateKey, SLUICE_RPC_URL: proxy.url, SLUICE_OWNER: owner!.address,
      SLUICE_FEE_RECIPIENT: fee!.address, SLUICE_FEE_BPS: "100", SLUICE_RELAYER: relayer!.address,
    };
    const lines: string[] = [];
    await unchanged(async () => {
      await deployMain(env, (l) => lines.push(l), ["--dry-run"]);
    });
    expect(lines.join("\n")).to.contain("DRY RUN of deploy: nothing is sent");
    expect(lines.join("\n")).to.not.contain(signer.privateKey);
    // Without the approval the guard refuses before it opens a connection, a dry run included.
    const before = proxy.seen.length;
    expect((await rejection(deployMain({ ...env, SLUICE_APPROVE: "smoke" }, () => undefined, ["--dry-run"]))).message).to.match(/refusing to run deploy/);
    expect(proxy.seen.length).to.equal(before);

    const smoke: string[] = [];
    await unchanged(async () => {
      await smokeMain({ ...env, SLUICE_APPROVE: "smoke", SLUICE_ROUTER: s.routerAddress }, (l) => smoke.push(l), ["--dry-run"]);
    });
    expect(smoke.join("\n")).to.contain("DRY RUN of smoke: nothing is sent");
    expect(smoke.join("\n")).to.contain("1. approve");
  });
});

describe("Contract verification: the standard input, the flat file and the explorer's endpoint", function () {
  this.timeout(240_000);

  it("builds the standard JSON input for the router from the compiler's own build info, cut to the files it uses", () => {
    const b = buildInput(ROOT, "contracts/PaymentRouter.sol", "PaymentRouter");
    expect(b.compilerVersion).to.equal(`v${EXPECTED.longVersion}`);
    expect(Object.keys(b.input.sources).sort()).to.deep.equal([
      "contracts/AgentVault.sol", "contracts/PaymentRouter.sol", "contracts/base/Eip712.sol", "contracts/interfaces/IERC20.sol", "contracts/interfaces/ISluiceErrors.sol",
      "contracts/libraries/SafeTransfer.sol", "contracts/libraries/SignatureLib.sol",
    ]);
    const s = b.input.settings as { evmVersion: string; optimizer: { enabled: boolean; runs: number } };
    expect(s).to.deep.include({ evmVersion: "shanghai" });
    expect(s.optimizer).to.deep.equal({ enabled: true, runs: 200 });
    expect(b.input.sources["contracts/PaymentRouter.sol"]?.content).to.equal(readFileSync(join(ROOT, "contracts", "PaymentRouter.sol"), "utf8"));
    expect(b.creationBytecode).to.equal(loadArtifact("PaymentRouter").bytecode);
    const vault = buildInput(ROOT, "contracts/AgentVault.sol", "AgentVault");
    expect(Object.keys(vault.input.sources)).to.not.include("contracts/PaymentRouter.sol");
  });

  it("refuses a build whose settings are not the documented ones, and a contract that was not built", () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-build-"));
    try {
      const info = JSON.parse(readFileSync(join(ROOT, "artifacts", "build-info", readdirBuildInfo()), "utf8"));
      const write = (patch: (i: any) => void) => {
        const copy = JSON.parse(JSON.stringify(info));
        patch(copy);
        mkdirSync(join(dir, "artifacts", "build-info"), { recursive: true });
        writeFileSync(join(dir, "artifacts", "build-info", "a.json"), JSON.stringify(copy));
      };
      write((i) => { i.input.settings.optimizer.runs = 1; });
      expect(() => buildInput(dir, "contracts/PaymentRouter.sol", "PaymentRouter")).to.throw(VerifyError, /optimizer/);
      write((i) => { i.input.settings.evmVersion = "cancun"; });
      expect(() => buildInput(dir, "contracts/PaymentRouter.sol", "PaymentRouter")).to.throw(VerifyError, /cancun EVM/);
      write((i) => { i.solcLongVersion = "0.8.25+commit.x"; });
      expect(() => buildInput(dir, "contracts/PaymentRouter.sol", "PaymentRouter")).to.throw(VerifyError, /not the documented/);
      write(() => undefined);
      expect(() => buildInput(dir, "contracts/PaymentRouter.sol", "Nothing")).to.throw(VerifyError, /no build info holds/);
      expect(() => buildInput(join(dir, "none"), "contracts/PaymentRouter.sol", "PaymentRouter")).to.throw(VerifyError, /pnpm compile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function readdirBuildInfo(): string {
    for (const f of safeReaddir(join(ROOT, "artifacts", "build-info"))) {
      const j = JSON.parse(readFileSync(join(ROOT, "artifacts", "build-info", f), "utf8"));
      if (j.output.contracts["contracts/PaymentRouter.sol"]) return f;
    }
    throw new Error("no build info");
  }

  it("takes the constructor arguments from a real deployment's data, and refuses data that was not built from this source", async () => {
    const s = await startStack({ feeBps: 100 });
    try {
      const b = buildInput(ROOT, "contracts/PaymentRouter.sol", "PaymentRouter");
      const tx = (s.router as unknown as { deploymentTransaction: () => { data: string } }).deploymentTransaction();
      const args = constructorArguments(tx.data, b.creationBytecode);
      expect(args).to.have.length(4 * 64);
      expect(`0x${args.slice(24, 64)}`.toLowerCase()).to.equal(getAddress(s.tokenAddress).toLowerCase());
      expect(args.slice(-4)).to.equal("0064"); // 100 bps
      expect(() => constructorArguments("0x6001600155", b.creationBytecode)).to.throw(VerifyError, /not built from this source/);
      expect(vaultConstructorArguments(s.routerAddress)).to.equal(`${"0".repeat(24)}${getAddress(s.routerAddress).slice(2).toLowerCase()}`);
    } finally {
      await s.stop();
    }
  });

  it("flattens the router to one file that compiles to the same code, and keeps one licence line and one pragma", () => {
    const b = buildInput(ROOT, "contracts/PaymentRouter.sol", "PaymentRouter");
    const flat = flatten(b.input.sources, b.path);
    expect(flat.match(/SPDX-License-Identifier/g)).to.have.length(1);
    expect(flat.match(/^pragma solidity/gm)).to.have.length(1);
    expect(flat).to.not.match(/^\s*import\b/m);
    expect(flat.indexOf("contract Eip712") < flat.indexOf("contract PaymentRouter")).to.equal(true); // dependencies first
    // Compile it with the pinned compiler and compare the runtime code with the real build, ignoring the metadata tail that names the files.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const solc = require("solc") as { compile: (input: string) => string };
    const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "Flat.sol": { content: flat } }, settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } } })));
    expect((out.errors ?? []).filter((e: { severity: string }) => e.severity === "error")).to.deep.equal([]);
    const flatCode: string = out.contracts["Flat.sol"].PaymentRouter.evm.deployedBytecode.object;
    const realCode = loadArtifact("PaymentRouter").deployedBytecode.slice(2);
    expect(flatCode.length).to.equal(realCode.length);
    expect(flatCode.slice(0, -106)).to.equal(realCode.slice(0, -106));
    expect(() => flatten({ "a.sol": { content: 'import "./missing.sol";\ncontract A {}' } }, "a.sol")).to.throw(VerifyError, /source is missing/);
    expect(() => flatten({ "a.sol": { content: "import * as X from './b.sol'; import\n{Y} from './c.sol';\ncontract A {}" } }, "a.sol")).to.throw(VerifyError);
  });

  describe("the explorer's endpoint, against a stand-in with its documented shape", () => {
    type Seen = { method: string; url: string; body: URLSearchParams };
    const serve = async (handler: (seen: Seen, count: number) => { status: number; body: unknown }) => {
      const seen: Seen[] = [];
      const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const entry = { method: req.method ?? "", url: req.url ?? "", body: new URLSearchParams(Buffer.concat(chunks).toString("utf8")) };
          seen.push(entry);
          const r = handler(entry, seen.length);
          res.writeHead(r.status, { "content-type": "application/json" }).end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
    };
    const build = () => buildInput(ROOT, "contracts/PaymentRouter.sol", "PaymentRouter");
    const address = getAddress(`0x${"55".repeat(20)}`);
    const fast = { sleep: async () => undefined, polls: 5, pollMs: 1, retries: 2, retryMs: 1 };

    it("posts the standard input with the settings, then polls until the explorer says verified", async () => {
      let polls = 0;
      const e = await serve((seen) => {
        if (seen.method === "POST") return { status: 200, body: { status: "1", message: "OK", result: "guid-123" } };
        polls += 1;
        return { status: 200, body: { status: "1", result: polls < 3 ? "Pending in queue" : "Pass - Verified" } };
      });
      try {
        const b = build();
        const result = await submitVerification({ base: e.url, address, build: b, constructorArgs: "abcd" }, fast);
        expect(result).to.deep.equal({ state: "verified", detail: "Pass - Verified" });
        const post = e.seen[0]!;
        expect(post.method).to.equal("POST");
        expect(post.url).to.equal("/api?module=contract&action=verifysourcecode");
        expect(Object.fromEntries(post.body.entries())).to.deep.include({
          module: "contract", action: "verifysourcecode", codeformat: "solidity-standard-json-input", contractaddress: address, contractname: "contracts/PaymentRouter.sol:PaymentRouter",
          compilerversion: "v0.8.24+commit.e11b9ed9", constructorArguements: "abcd", constructorArguments: "abcd", optimizationUsed: "1", runs: "200", evmversion: "shanghai",
        });
        expect(JSON.parse(post.body.get("sourceCode") as string)).to.deep.equal(b.input);
        const asks = e.seen.filter((x) => x.method === "GET");
        expect(asks).to.have.length(3);
        expect(asks[0]!.url).to.equal("/api?module=contract&action=checkverifystatus&guid=guid-123");
      } finally {
        await e.close();
      }
    });

    it("retries a 502 with a growing pause, and says the explorer is unreachable when it keeps answering 502", async () => {
      const pauses: number[] = [];
      const once = await serve((_s, n) => (n < 3 ? { status: 502, body: "bad gateway" } : { status: 200, body: { status: "1", result: "g" } }));
      const flaky = await serve((_s, n) => (n < 3 ? { status: 502, body: "x" } : { status: 200, body: { result: "Pass - Verified" } }));
      try {
        const sleep = async (ms: number) => { pauses.push(ms); };
        const ok = await submitVerification({ base: flaky.url, address, build: build(), constructorArgs: "" }, { ...fast, sleep, retryMs: 10 });
        expect(["verified", "failed"]).to.include(ok.state); // the third answer has no ticket, so the explorer's answer is read as a refusal
        expect(pauses.slice(0, 2)).to.deep.equal([10, 20]);
        pauses.length = 0;
        const got = await submitVerification({ base: once.url, address, build: build(), constructorArgs: "" }, { ...fast, sleep, retryMs: 10, pollMs: 1, polls: 1 });
        expect(got.state).to.equal("unreachable"); // a ticket, but no answer to the status ask within the time given
      } finally {
        await once.close();
        await flaky.close();
      }
      const down = await serve(() => ({ status: 502, body: "bad gateway" }));
      try {
        const result = await submitVerification({ base: down.url, address, build: build(), constructorArgs: "" }, fast);
        expect(result.state).to.equal("unreachable");
        expect(result.detail).to.match(/manual steps/);
        expect(down.seen.length).to.equal(3); // the first try and two more
      } finally {
        await down.close();
      }
    });

    it("reports a refusal, a failed verification and an already-verified contract as what they are", async () => {
      const refuse = await serve(() => ({ status: 200, body: { status: "0", message: "Invalid parameter", result: null } }));
      const fail = await serve((s) => (s.method === "POST" ? { status: 200, body: { status: "1", result: "g" } } : { status: 200, body: { result: "Fail - Unable to verify" } }));
      const already = await serve(() => ({ status: 200, body: { status: "0", message: "Contract source code already verified", result: "Contract source code already verified" } }));
      try {
        expect((await submitVerification({ base: refuse.url, address, build: build(), constructorArgs: "" }, fast)).state).to.equal("failed");
        const f = await submitVerification({ base: fail.url, address, build: build(), constructorArgs: "" }, fast);
        expect(f.state).to.equal("failed");
        expect(f.detail).to.match(/could not verify/);
        expect((await submitVerification({ base: already.url, address, build: build(), constructorArgs: "" }, fast)).state).to.equal("already");
      } finally {
        await refuse.close();
        await fail.close();
        await already.close();
      }
    });

    it("gives up on a status that never leaves 'pending', and talks only to https or this machine", async () => {
      const pending = await serve((s) => (s.method === "POST" ? { status: 200, body: { status: "1", result: "g" } } : { status: 200, body: { result: "Pending in queue" } }));
      try {
        const r = await submitVerification({ base: pending.url, address, build: build(), constructorArgs: "" }, { ...fast, polls: 2 });
        expect(r.state).to.equal("unreachable");
        expect(pending.seen.filter((x) => x.method === "GET")).to.have.length(2);
      } finally {
        await pending.close();
      }
      expect((await rejection(submitVerification({ base: "http://explorer.example.com", address, build: build(), constructorArgs: "" }, fast))).message).to.match(/https/);
    });
  });

  describe("the command", () => {
    let s: Stack;
    let root: string;
    let proxy: Awaited<ReturnType<typeof startChaosProxy>>;
    const logs: string[] = [];

    beforeEach(async () => {
      s = await startStack({ feeBps: 100 });
      root = mkdtempSync(join(tmpdir(), "sluice-verify-"));
      mkdirSync(join(root, "artifacts"), { recursive: true });
      // The command reads the build info from the repository's own artifacts: link them in by copying the folder it needs.
      const { cpSync } = require("node:fs") as typeof import("node:fs");
      cpSync(join(ROOT, "artifacts", "build-info"), join(root, "artifacts", "build-info"), { recursive: true, filter: copyable });
      const deploymentTx = (s.router as unknown as { deploymentTransaction: () => { hash: string } }).deploymentTransaction();
      writeFileSync(join(root, "deployment.json"), JSON.stringify({ network: "mainnet", router: s.routerAddress, vault: s.vaultAddress, hash: deploymentTx.hash }));
      proxy = await startChaosProxy(s.rpcUrl);
      logs.length = 0;
    });
    afterEach(async () => {
      await proxy.close();
      await s.stop();
      rmSync(root, { recursive: true, force: true });
    });

    /** A stand-in for Blockscout: it shows a contract as verified once the source has been posted for it. */
    const explorer = async (options: { alwaysBadGateway?: boolean; verifyOnPost?: boolean } = {}) => {
      const verified = new Set<string>();
      const posts: URLSearchParams[] = [];
      /** Every address the explorer was asked about, by a read or by a submission. */
      const asked: string[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const url = new URL(req.url ?? "/", "http://x");
          if (options.alwaysBadGateway) return void res.writeHead(502).end("bad gateway");
          const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
          if (req.method === "POST") {
            const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
            posts.push(form);
            asked.push(String(form.get("contractaddress")));
            if (options.verifyOnPost !== false) verified.add(String(form.get("contractaddress")).toLowerCase());
            return send(200, { status: "1", message: "OK", result: "guid" });
          }
          if (url.pathname === "/api" && url.searchParams.get("action") === "checkverifystatus") return send(200, { result: "Pass - Verified" });
          const m = /^\/api\/v2\/smart-contracts\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
          if (m) asked.push(m[1] as string);
          if (m) return verified.has((m[1] as string).toLowerCase()) ? send(200, { is_verified: true, name: "X" }) : send(404, { message: "Not found" });
          return send(404, {});
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, posts, verified, asked, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
    };
    const run = (args: string[], env: Record<string, string | undefined>, extra = {}) => verifyMain(args, env, { log: (l) => logs.push(l), root, ...extra });
    const baseEnv = () => ({ SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: proxy.url });

    it("prepares the manual route's files, whatever the explorer does: the standard input, the flat file and the constructor arguments, and the exact settings", async () => {
      const code = await run(["--prepare-only", "--explorer", "http://127.0.0.1:1"], baseEnv());
      expect(code, logs.join("\n")).to.equal(0);
      for (const name of ["PaymentRouter", "AgentVault"]) {
        for (const ext of ["standard-input.json", "flat.sol", "constructor-arguments.txt"]) expect(existsSync(join(root, "artifacts", "verification", `${name}.${ext}`)), `${name}.${ext}`).to.equal(true);
      }
      const text = logs.join("\n");
      expect(text).to.contain("compiler v0.8.24+commit.e11b9ed9, optimization on, 200 runs, EVM version shanghai, licence MIT");
      expect(text).to.contain("contract name contracts/PaymentRouter.sol:PaymentRouter");
      // The vault's files are written for a reader to build it again, and the output says this command does not submit them.
      expect(text).to.contain("(for building the vault again; this command does not submit them)");
      expect(text).to.contain("is created by the router's constructor. This command submits nothing for it and does not ask the explorer about it");
      expect(text).to.contain("pnpm live:vaultcheck");
      expect(readFileSync(join(root, "artifacts", "verification", "AgentVault.constructor-arguments.txt"), "utf8").trim()).to.equal(vaultConstructorArguments(s.routerAddress));
      expect(readFileSync(join(root, "artifacts", "verification", "PaymentRouter.constructor-arguments.txt"), "utf8").trim()).to.have.length(4 * 64);
      expect(proxy.seen.every((m) => ["eth_getTransactionByHash"].includes(m))).to.equal(true);
    });

    it("submits the router only, then confirms with a separate read that the explorer shows it verified, and never submits or asks about the vault", async () => {
      const e = await explorer();
      try {
        const code = await run([ "--explorer", e.url ], { ...baseEnv(), SLUICE_APPROVE: "verify" }, { submit: { sleep: async () => undefined, pollMs: 1, retryMs: 1 } });
        expect(code, logs.join("\n")).to.equal(0);
        expect(e.posts).to.have.length(1);
        expect(e.posts.map((p) => p.get("contractname"))).to.deep.equal(["contracts/PaymentRouter.sol:PaymentRouter"]);
        expect(e.posts.map((p) => String(p.get("contractaddress")).toLowerCase())).to.deep.equal([s.routerAddress.toLowerCase()]);
        const text = logs.join("\n");
        expect(text).to.contain("explorer: PaymentRouter now shows verified source");
        expect(text).to.not.match(/explorer: AgentVault/);
        expect(text).to.contain("This command submits nothing for it");
        // The explorer was never asked about the vault's address, so whatever it would answer for the vault changes nothing.
        expect(e.asked.map((a) => a.toLowerCase())).to.not.include(s.vaultAddress.toLowerCase());
      } finally {
        await e.close();
      }
    });

    it("does not count a submission as verified until the explorer says so when it is read", async () => {
      const e = await explorer({ verifyOnPost: false });
      try {
        const code = await run(["--explorer", e.url], { ...baseEnv(), SLUICE_APPROVE: "verify" }, { submit: { sleep: async () => undefined, pollMs: 1, retryMs: 1 } });
        expect(code).to.equal(1);
        expect(logs.join("\n")).to.contain("still does not show verified source");
      } finally {
        await e.close();
      }
    });

    it("with --check-only, only asks the explorer about the router, and exits 0 when the router is verified, whatever the explorer says of the vault", async () => {
      const e = await explorer();
      try {
        expect(await run(["--check-only", "--explorer", e.url], baseEnv())).to.equal(1);
        expect(e.posts).to.have.length(0);
        e.verified.add(s.routerAddress.toLowerCase()); // the vault is not verified on this stand-in explorer, and that is not a failure
        logs.length = 0;
        expect(await run(["--check-only", "--explorer", e.url], baseEnv())).to.equal(0);
        expect(logs.join("\n")).to.contain("explorer: PaymentRouter shows verified source");
        expect(logs.join("\n")).to.not.match(/explorer: AgentVault/);
        expect(e.asked.map((a) => a.toLowerCase())).to.not.include(s.vaultAddress.toLowerCase());
      } finally {
        await e.close();
      }
    });

    it("needs SLUICE_APPROVE=verify to post, a deployment on the same network, and says what to do when the explorer answers 502", async () => {
      const bad = async (args: string[], env: Record<string, string | undefined>, why: RegExp) => {
        logs.length = 0;
        expect(await run(args, env)).to.equal(1);
        expect(logs.join("\n")).to.match(why);
      };
      await bad(["--explorer", "http://127.0.0.1:1"], baseEnv(), /needs SLUICE_APPROVE=verify/);
      await bad(["--check-only"], {}, /set SLUICE_NETWORK/);
      await bad(["--check-only"], { SLUICE_NETWORK: "testnet", SLUICE_RPC_URL: proxy.url }, /deployment is on mainnet, but SLUICE_NETWORK is testnet/);
      await bad(["--check-only", "--bogus"], baseEnv(), /unknown option/);
      await bad(["--check-only", "--deployment", join(root, "nope.json")], baseEnv(), /deployment file was not found/);
      logs.length = 0;
      expect(await run(["--check-only", "--explorer", "http://explorer.example.com"], baseEnv())).to.equal(1);

      const down = await explorer({ alwaysBadGateway: true });
      try {
        logs.length = 0;
        const code = await run(["--explorer", down.url], { ...baseEnv(), SLUICE_APPROVE: "verify" }, { submit: { sleep: async () => undefined, pollMs: 1, retryMs: 1, retries: 1 } });
        expect(code).to.equal(2);
        expect(logs.join("\n")).to.contain("Use the manual steps in docs/MAINNET-RUNBOOK.md");
        expect(existsSync(join(root, "artifacts", "verification", "PaymentRouter.flat.sol"))).to.equal(true); // the manual route's files were written first
      } finally {
        await down.close();
      }
    });
  });
});

describe("The testnet rehearsal token", function () {
  this.timeout(180_000);
  let s: Stack;
  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
  });
  afterEach(async () => {
    await s.stop();
  });

  const ctx = (signer: Wallet, log: string[]) => ({ signer: signer.connect(s.provider), provider: s.provider, meter: new SpendMeter({ maxQusdc: 1n, maxQieWei: parseEther("1") }), log: (l: string) => log.push(l) });

  it("is a six-decimal token with no value that anyone can mint, and the router works with it", async () => {
    const deployer = throwawayWallet();
    await setQie(deployer.address, parseEther("1"));
    const log: string[] = [];
    const out = await deployTestToken(ctx(deployer, log), 1990); // this local chain stands in for the testnet
    const token = dyn(new ethers.Contract(out.token, loadArtifact("TestnetToken", "test").abi as never, s.provider));
    expect(await token.name()).to.equal("Sluice test token (no value)");
    expect(await token.symbol()).to.equal("STT");
    expect(await token.decimals()).to.equal(6n);
    expect(await token.balanceOf(deployer.address)).to.equal(TEST_TOKEN_MINT);
    expect(log.join("\n")).to.contain(`minted 1000.000000 test tokens to ${deployer.address}`);
    // Transfers and allowances behave, and a router built on it takes a deposit.
    const [owner, fee] = await ethers.getSigners();
    const router = await deployContract("PaymentRouter", [out.token, owner!.address, fee!.address, 100]);
    const w = deployer.connect(s.provider);
    await (await (token.connect(w) as unknown as { approve: (a: string, n: bigint) => Promise<{ wait: () => Promise<unknown> }> }).approve(await router.getAddress(), USDC("5"))).wait();
    await (await (router.connect(w) as unknown as { deposit: (n: bigint) => Promise<{ wait: () => Promise<unknown> }> }).deposit(USDC("5"))).wait();
    expect(await router.payerBalance(deployer.address)).to.equal(USDC("5"));
    expect(await token.balanceOf(await router.getAddress())).to.equal(USDC("5"));
    await rejection((token.connect(w) as unknown as { transfer: (a: string, n: bigint) => Promise<unknown> }).transfer(throwawayWallet().address, TEST_TOKEN_MINT * 2n));
  });

  it("refuses mainnet: the function stops on a node that reports chain 1990 before it sends anything", async () => {
    const deployer = throwawayWallet();
    await setQie(deployer.address, parseEther("1"));
    const before = await s.provider.getTransactionCount(deployer.address);
    const error = await rejection(deployTestToken(ctx(deployer, []), TESTNET_CHAIN_ID)); // the local chain is chain 1990, like mainnet
    expect(error.message).to.match(/on QIE mainnet \(chain 1990\): the test token is never deployed there/);
    expect(await s.provider.getTransactionCount(deployer.address)).to.equal(before);
    expect((await rejection(deployTestToken(ctx(deployer, []), 1))).message).to.match(/not the 1 this was asked to use/);
  });

  it("refuses mainnet in the script: by network name before it reads the key, and by the chain id the node reports", async () => {
    const deployer = throwawayWallet();
    await setQie(deployer.address, parseEther("1"));
    const env = { SLUICE_APPROVE: "deploy-test-token", SLUICE_KEY: deployer.privateKey, SLUICE_RPC_URL: s.rpcUrl };
    expect((await rejection(tokenMain({ ...env, SLUICE_NETWORK: "mainnet" }, () => undefined))).message).to.match(/never.*|for the testnet only/);
    expect((await rejection(tokenMain({ ...env, SLUICE_NETWORK: "mainnet", SLUICE_KEY: undefined }, () => undefined))).message).to.match(/for the testnet only/);
    // On "testnet", pointed at a node that is on chain 1990, it still refuses, and sends nothing.
    const before = await s.provider.getTransactionCount(deployer.address);
    const out = (await rejection(tokenMain({ ...env, SLUICE_NETWORK: "testnet" }, () => undefined))).message;
    expect(out).to.match(/the RPC is on chain 1990, not the testnet's 1983/);
    expect(out).to.not.contain(deployer.privateKey);
    expect(await s.provider.getTransactionCount(deployer.address)).to.equal(before);
    // Without its own approval it does not start, and approval for another script is not enough.
    expect((await rejection(tokenMain({ ...env, SLUICE_NETWORK: "testnet", SLUICE_APPROVE: "deploy" }, () => undefined))).message).to.match(/refusing to run deploy-test-token/);
    expect((await rejection(tokenMain({ SLUICE_NETWORK: "testnet" }, () => undefined))).message).to.match(/SLUICE_APPROVE/);
  });

  it("stays inside a gas plan, and the mainnet deploy script still refuses a token that is not QUSDC", async () => {
    expect(testTokenPlan(MAX_GAS_PRICE_WEI).qusdc).to.equal(0n);
    expect(testTokenPlan(MAX_GAS_PRICE_WEI).qieWei).to.equal(1_600_000n * MAX_GAS_PRICE_WEI);
    const [owner, fee] = await ethers.getSigners();
    const signer = throwawayWallet();
    const env = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: signer.privateKey, SLUICE_RPC_URL: s.rpcUrl, SLUICE_OWNER: owner!.address, SLUICE_FEE_RECIPIENT: fee!.address, SLUICE_FEE_BPS: "100", SLUICE_TOKEN: throwawayWallet().address };
    expect((await rejection(deployMain(env, () => undefined, ["--dry-run"]))).message).to.match(/on mainnet SLUICE_TOKEN must be left empty or be the QUSDC address/);
  });
});

describe("The relayer key maker", () => {
  it("writes a key to a new file, prints only the address, and never overwrites a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-key-"));
    try {
      const file = join(dir, "relayer.key");
      const lines: string[] = [];
      expect(newKey([file], (l) => lines.push(l))).to.equal(0);
      const key = readFileSync(file, "utf8").trim();
      expect(key).to.match(/^0x[0-9a-f]{64}$/);
      const text = lines.join("\n");
      expect(text).to.contain(`address: ${new Wallet(key).address}`);
      expect(text).to.not.contain(key);
      expect(text).to.not.contain(key.slice(2));
      // The closing advice is right for either key, and says never to use one key for both.
      expect(text).to.contain("If this is the relayer's key");
      expect(text).to.contain("If this is the deployer's key");
      expect(text).to.contain("Never use one key for both");
      if (process.platform !== "win32") expect(statSync(file).mode & 0o077).to.equal(0); // only its owner can read it
      // A second run does not overwrite it.
      const again: string[] = [];
      expect(newKey([file], (l) => again.push(l))).to.equal(1);
      expect(readFileSync(file, "utf8").trim()).to.equal(key);
      expect(again.join("\n")).to.match(/already exists/);
      // Each key is new.
      const other = join(dir, "second.key");
      newKey([other], () => undefined);
      expect(readFileSync(other, "utf8")).to.not.equal(readFileSync(file, "utf8"));
      expect(newKey([], () => undefined)).to.equal(1);
      expect(newKey(["--x"], () => undefined)).to.equal(1);
      expect(newKey([file, "extra"], () => undefined)).to.equal(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
