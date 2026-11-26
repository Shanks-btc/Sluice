// The mainnet path's guards, checked on a local chain that has QIE mainnet's chain id (1990) and, where a case needs a node that says it is
// on another chain, a tiny node that does. Nothing here sends to any network. Each case that says "before it connects" counts the calls a
// recording proxy saw and expects none: a refusal that comes after a connection could have come after a transaction.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Contract, Wallet, getAddress, hexlify, parseEther, randomBytes } from "ethers";
import { network } from "hardhat";
import { NoHealthyEndpoint, QIE_ENDPOINTS, describeSelection, requireNodeChain, resolveEndpoint, signRefund, signWithdraw } from "@sluice/sdk";
import { CEILING_QIE_WEI, CEILING_QUSDC, DEFAULT_MAX_QIE_WEI, DEFAULT_MAX_QUSDC, GuardError, MAX_GAS_PRICE_WEI, QUSDC_ADDRESS, readCaps, requireApproval } from "../../src/guard";
import { DEFAULT_FEE_BPS, MAX_FEE_BPS, checkDeployRoles, checkDeployToken, deployPlan, deployRouter, readDeployParams, smokePlan } from "../../src/live";
import { SpendMeter } from "../../src/guard";
import { appendRows, hashCell, renderRow } from "../../src/recorder";
import { exitWith } from "../../src/exit";
import { chooseRpc } from "../../src/rpc-use";
import { safeEntries } from "../../src/secret-paths";
import { main as deployMain, parseDeployArgs } from "../../scripts/live/deploy";
import { main as smokeMain } from "../../scripts/live/smoke";
import { main as tokenMain } from "../../scripts/live/deploy-test-token";
import { main as ownerMain } from "../../scripts/client/owner-setup";
import { main as recordMain } from "../../scripts/evidence/record";
import { main as checkMain } from "../../scripts/evidence-check";
import { main as summaryMain } from "../../scripts/evidence-summary";
import { deployContract, signedIntent, USDC } from "../helpers";
import { rejection } from "../helpers/assert";
import { startChaosProxy } from "../helpers/chaos";
import { depositFor, freshChain, fundWallet, setQie, startStack, throwawayWallet } from "../helpers/stack";
import type { Stack } from "../helpers/stack";

const ROOT = join(__dirname, "..", "..");
const A = (n: number): string => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const QUSDC = getAddress(QUSDC_ADDRESS);

// ------------------------------------------------------------------------------------------------------- the deploy's parameters

describe("Mainnet deploy: the parameters", () => {
  const base = { SLUICE_OWNER: A(1), SLUICE_FEE_RECIPIENT: A(2) };

  it("uses QUSDC on mainnet whether the token is left out or given, and refuses any other token there", () => {
    expect(readDeployParams(base, "mainnet").token).to.equal(QUSDC);
    expect(readDeployParams({ ...base, SLUICE_TOKEN: QUSDC.toLowerCase() }, "mainnet").token).to.equal(QUSDC);
    expect(() => readDeployParams({ ...base, SLUICE_TOKEN: A(9) }, "mainnet")).to.throw(GuardError, /on mainnet SLUICE_TOKEN must be left empty or be the QUSDC address/);
    expect(() => readDeployParams({ ...base, SLUICE_TOKEN: "0x123" }, "mainnet")).to.throw(GuardError, /SLUICE_TOKEN is not a valid address/);
    // A testnet router names its token, because testnet has no QUSDC.
    expect(() => readDeployParams(base, "testnet")).to.throw(GuardError, /SLUICE_TOKEN must be set to an address/);
    expect(readDeployParams({ ...base, SLUICE_TOKEN: A(9) }, "testnet").token).to.equal(A(9));
  });

  it("defaults the fee to 100 basis points, takes 0 to 200, and refuses anything above or malformed", () => {
    expect(DEFAULT_FEE_BPS).to.equal(100);
    expect(MAX_FEE_BPS).to.equal(200);
    expect(readDeployParams(base, "mainnet").feeBps).to.equal(100);
    expect(readDeployParams({ ...base, SLUICE_FEE_BPS: "  " }, "mainnet").feeBps).to.equal(100);
    expect(readDeployParams({ ...base, SLUICE_FEE_BPS: "0" }, "mainnet").feeBps).to.equal(0);
    expect(readDeployParams({ ...base, SLUICE_FEE_BPS: "150" }, "mainnet").feeBps).to.equal(150);
    expect(readDeployParams({ ...base, SLUICE_FEE_BPS: " 200 " }, "mainnet").feeBps).to.equal(200);
    for (const bad of ["201", "999", "1000", "-1", "1.5", "1e2", "abc", "0x10", "+5"]) {
      expect(() => readDeployParams({ ...base, SLUICE_FEE_BPS: bad }, "mainnet"), bad).to.throw(GuardError, /SLUICE_FEE_BPS must be a whole number from 0 to 200/);
    }
  });

  it("needs the owner and the fee recipient to be named, real addresses, and not the zero address", () => {
    expect(() => readDeployParams({ SLUICE_FEE_RECIPIENT: A(2) }, "mainnet")).to.throw(GuardError, /SLUICE_OWNER must be set to an address/);
    expect(() => readDeployParams({ SLUICE_OWNER: A(1) }, "mainnet")).to.throw(GuardError, /SLUICE_FEE_RECIPIENT must be set to an address/);
    expect(() => readDeployParams({ ...base, SLUICE_OWNER: "0xnothex" }, "mainnet")).to.throw(GuardError, /SLUICE_OWNER is not a valid address/);
    const zero = `0x${"00".repeat(20)}`;
    expect(() => readDeployParams({ ...base, SLUICE_OWNER: zero }, "mainnet")).to.throw(GuardError, /SLUICE_OWNER is the zero address/);
    expect(() => readDeployParams({ ...base, SLUICE_FEE_RECIPIENT: zero }, "mainnet")).to.throw(GuardError, /SLUICE_FEE_RECIPIENT is the zero address/);
  });
});

describe("Mainnet deploy: the roles are kept apart", () => {
  const params = (owner: string, feeRecipient: string) => ({ token: QUSDC, owner, feeRecipient, feeBps: 100 });
  const deployer = A(10);
  const relayer = A(11);

  it("accepts an owner and a fee recipient that are neither the deployer nor the relayer, and an owner that is also the fee recipient", () => {
    checkDeployRoles(params(A(1), A(2)), { deployer, relayer }, "mainnet");
    checkDeployRoles(params(A(1), A(1)), { deployer, relayer }, "mainnet");
  });

  it("refuses the deployer key's own address as the owner or the fee recipient, with a reason that names which", () => {
    expect(() => checkDeployRoles(params(deployer, A(2)), { deployer, relayer }, "mainnet")).to.throw(GuardError, /SLUICE_OWNER is the deployer key's own address/);
    expect(() => checkDeployRoles(params(A(1), deployer), { deployer, relayer }, "mainnet")).to.throw(GuardError, /SLUICE_FEE_RECIPIENT is the deployer key's own address/);
    // Whatever the letter case the address was written in.
    expect(() => checkDeployRoles(params(deployer.toLowerCase(), A(2)), { deployer, relayer }, "mainnet")).to.throw(GuardError, /deployer key's own address/);
    expect(() => checkDeployRoles(params(A(1), A(2)), { deployer: deployer.toLowerCase(), relayer }, "mainnet")).to.not.throw();
  });

  it("refuses the relayer's address as the owner or the fee recipient, and the deployer and the relayer being one address", () => {
    expect(() => checkDeployRoles(params(relayer, A(2)), { deployer, relayer }, "mainnet")).to.throw(GuardError, /SLUICE_OWNER is the relayer's address/);
    expect(() => checkDeployRoles(params(A(1), relayer), { deployer, relayer }, "mainnet")).to.throw(GuardError, /SLUICE_FEE_RECIPIENT is the relayer's address/);
    expect(() => checkDeployRoles(params(A(1), A(2)), { deployer, relayer: deployer }, "mainnet")).to.throw(GuardError, /the same address: the relayer is a hot key/);
  });

  it("needs the relayer's address on mainnet, so the check cannot be skipped by leaving it out, and checks it on testnet only when given", () => {
    expect(() => checkDeployRoles(params(A(1), A(2)), { deployer }, "mainnet")).to.throw(GuardError, /on mainnet, give the relayer's address \(SLUICE_RELAYER, or --relayer\)/);
    checkDeployRoles(params(A(1), A(2)), { deployer }, "testnet");
    expect(() => checkDeployRoles(params(relayer, A(2)), { deployer, relayer }, "testnet")).to.throw(GuardError, /relayer's address/);
    expect(() => checkDeployRoles(params(deployer, A(2)), { deployer }, "testnet")).to.throw(GuardError, /deployer key's own address/);
  });

  it("takes only --dry-run and --relayer <address>, and refuses any other option so a typo can never become a real deployment", () => {
    expect(parseDeployArgs([])).to.deep.equal({ dryRun: false });
    expect(parseDeployArgs(["--dry-run"])).to.deep.equal({ dryRun: true });
    expect(parseDeployArgs(["--relayer", A(3), "--dry-run"])).to.deep.equal({ dryRun: true, relayer: A(3) });
    for (const bad of [["--dry-ruun"], ["--dryrun"], ["-n"], ["dry-run"], ["--force"], ["--relayer"], ["--relayer", "--dry-run"]]) {
      expect(() => parseDeployArgs(bad), bad.join(" ")).to.throw(GuardError);
    }
  });
});

// ------------------------------------------------------------------------------------------------------- caps and the approval

describe("Mainnet: the approval and the spending caps", () => {
  const key = `0x${"07".repeat(32)}`;
  const env = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: key };

  it("defaults to 10 QUSDC and 5 QIE and never lets either pass the ceilings of 100 and 50", () => {
    expect(readCaps({})).to.deep.equal({ maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n });
    expect(DEFAULT_MAX_QUSDC).to.equal(10_000_000n);
    expect(DEFAULT_MAX_QIE_WEI).to.equal(5n * 10n ** 18n);
    expect(CEILING_QUSDC).to.equal(100_000_000n);
    expect(CEILING_QIE_WEI).to.equal(50n * 10n ** 18n);
    expect(readCaps({ SLUICE_MAX_QUSDC: "100", SLUICE_MAX_QIE: "50" })).to.deep.equal({ maxQusdc: 100_000_000n, maxQieWei: 50n * 10n ** 18n });
    expect(() => readCaps({ SLUICE_MAX_QUSDC: "100.000001" })).to.throw(GuardError, /above the hard ceiling of 100.000000 QUSDC/);
    expect(() => readCaps({ SLUICE_MAX_QIE: "50.000000000000000001" })).to.throw(GuardError, /above the hard ceiling of 50 QIE/);
    for (const bad of ["0", "-1", "1e1", "abc", "1,5"]) expect(() => readCaps({ SLUICE_MAX_QUSDC: bad }), bad).to.throw(GuardError);
    expect(() => readCaps({ SLUICE_MAX_TX_QIE: "6" })).to.throw(GuardError, /above SLUICE_MAX_QIE/);
  });

  it("refuses a script whose worst case does not fit its caps, whichever script it is", () => {
    expect(requireApproval("deploy", env, deployPlan()).chainId).to.equal(1990);
    expect(() => requireApproval("deploy", { ...env, SLUICE_MAX_QIE: "0.1" }, deployPlan())).to.throw(GuardError, /it may spend 0.2 QIE on gas, above the cap of 0.1/);
    expect(() => requireApproval("smoke", { ...env, SLUICE_APPROVE: "smoke", SLUICE_MAX_QUSDC: "0.2" }, smokePlan())).to.throw(GuardError, /it may move 0.300000 QUSDC, above the cap of 0.200000/);
    expect(MAX_GAS_PRICE_WEI).to.equal(50_000_000_000n);
  });

  it("stops a run at its caps while it is spending, on QUSDC, on QIE and on a single transaction", () => {
    const meter = new SpendMeter({ maxQusdc: 1_000_000n, maxQieWei: 10n ** 16n, maxTxQieWei: 5n * 10n ** 15n });
    meter.beforeQusdc(600_000n);
    expect(() => meter.beforeQusdc(400_001n)).to.throw(GuardError, /would pass the cap/);
    meter.beforeQusdc(400_000n);
    expect(() => meter.beforeSend(10_000_000n, 1_000_000_000n)).to.throw(GuardError, /one transaction could cost/);
    expect(() => meter.beforeSend(1_000n, MAX_GAS_PRICE_WEI + 1n)).to.throw(GuardError, /gas price is above 50 gwei/);
    meter.beforeSend(2_000_000n, 1_000_000_000n);
    meter.beforeSend(4_500_000n, 1_000_000_000n);
    expect(() => meter.beforeSend(4_500_000n, 1_000_000_000n)).to.throw(GuardError, /the next transaction could pass the cap/);
  });

  it("refuses every sending script without the approval that names it, without a network, and with a key that is not a key", () => {
    const refused = (e: Record<string, string | undefined>, pattern: RegExp, script = "deploy") => expect(() => requireApproval(script, e, deployPlan()), JSON.stringify(Object.keys(e))).to.throw(GuardError, pattern);
    refused({ SLUICE_KEY: key, SLUICE_APPROVE: "deploy" }, /set SLUICE_NETWORK to mainnet or testnet/);
    refused({ SLUICE_NETWORK: "local", SLUICE_KEY: key, SLUICE_APPROVE: "deploy" }, /set SLUICE_NETWORK to mainnet or testnet/);
    refused({ SLUICE_NETWORK: "mainnet", SLUICE_KEY: key }, /set SLUICE_APPROVE=deploy/);
    refused({ SLUICE_NETWORK: "mainnet", SLUICE_KEY: key, SLUICE_APPROVE: "smoke" }, /approves "smoke", not "deploy"/);
    refused({ SLUICE_NETWORK: "mainnet", SLUICE_KEY: key, SLUICE_APPROVE: "deploy" }, /approves "deploy", not "smoke"/, "smoke");
    refused({ SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy" }, /SLUICE_KEY must be set/);
    refused({ SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: "0x1234" }, /SLUICE_KEY must be set/);
    refused({ ...env, SLUICE_RPC_URL: "http://rpc.example.com" }, /SLUICE_RPC_URL must be https/);
    // A secret pasted into the approval is never repeated in the message.
    const secret = `0x${"ab".repeat(32)}`;
    try {
      requireApproval("deploy", { ...env, SLUICE_APPROVE: secret }, deployPlan());
      expect.fail("it should have refused");
    } catch (err) {
      expect((err as Error).message).to.not.contain(secret);
    }
  });
});

// ------------------------------------------------------------------------------------------------------- the scripts on a node

/** A node that says it is chain `chainId` and answers nothing else, counting what it was asked. */
async function nodeSaying(chainId: number): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string } | Array<{ id: number; method: string }>;
      const one = (m: { id: number; method: string }) => {
        seen.push(m.method);
        return m.method === "eth_chainId" ? { jsonrpc: "2.0", id: m.id, result: `0x${chainId.toString(16)}` } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "this node answers only eth_chainId" } };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const SENDING = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_estimateGas"]);

describe("Mainnet scripts: what they refuse, and before they connect", function () {
  this.timeout(240_000);
  let s: Stack;
  let proxy: Awaited<ReturnType<typeof startChaosProxy>>;
  let deployer: Wallet;
  const owner = A(21);
  const fee = A(22);
  const relayer = A(23);
  const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: deployer.privateKey, SLUICE_RPC_URL: proxy.url, SLUICE_OWNER: owner, SLUICE_FEE_RECIPIENT: fee, SLUICE_RELAYER: relayer, ...extra,
  });

  beforeEach(async () => {
    // The local chain has mainnet's id but not QUSDC. Hardhat's setCode cannot remove code, and other test files put a stand-in at QUSDC's
    // address on the shared chain, so a fresh chain is what makes the address empty: a test that wants QUSDC there puts it there itself.
    await freshChain();
    s = await startStack({ feeBps: 100 });
    proxy = await startChaosProxy(s.rpcUrl);
    deployer = throwawayWallet();
    await setQie(deployer.address, parseEther("1"));
  });
  afterEach(async () => {
    await proxy.close?.();
    await s.stop();
  });
  after(async () => {
    await freshChain(); // leave the shared chain without the stand-in a test here may have put at QUSDC's address
  });

  const before = () => proxy.seen.length;

  it("refuses the owner being the deployer, the relayer being missing, and an unknown option, all before it opens a connection", async () => {
    const calls = before();
    expect((await rejection(deployMain(env({ SLUICE_OWNER: deployer.address }), () => undefined, ["--dry-run"]))).message).to.match(/SLUICE_OWNER is the deployer key's own address/);
    expect((await rejection(deployMain(env({ SLUICE_FEE_RECIPIENT: deployer.address }), () => undefined, ["--dry-run"]))).message).to.match(/SLUICE_FEE_RECIPIENT is the deployer key's own address/);
    expect((await rejection(deployMain(env({ SLUICE_OWNER: relayer }), () => undefined, ["--dry-run"]))).message).to.match(/SLUICE_OWNER is the relayer's address/);
    expect((await rejection(deployMain(env({ SLUICE_RELAYER: undefined }), () => undefined, ["--dry-run"]))).message).to.match(/on mainnet, give the relayer's address/);
    expect((await rejection(deployMain(env({ SLUICE_RELAYER: "0x12" }), () => undefined, ["--dry-run"]))).message).to.match(/relayer's address .* is not a valid address/);
    expect((await rejection(deployMain(env(), () => undefined, ["--dry-ruun"]))).message).to.match(/unknown option --dry-ruun/);
    expect((await rejection(deployMain(env({ SLUICE_FEE_BPS: "201" }), () => undefined, ["--dry-run"]))).message).to.match(/SLUICE_FEE_BPS must be a whole number from 0 to 200/);
    expect((await rejection(deployMain(env({ SLUICE_TOKEN: A(9) }), () => undefined, ["--dry-run"]))).message).to.match(/must be left empty or be the QUSDC address/);
    expect((await rejection(deployMain(env({ SLUICE_OWNER: undefined }), () => undefined, ["--dry-run"]))).message).to.match(/SLUICE_OWNER must be set/);
    expect(proxy.seen.length, "no call reached the node").to.equal(calls);
    // The relayer may be given on the command line instead.
    const lines: string[] = [];
    await rejection(deployMain(env({ SLUICE_RELAYER: undefined }), (l) => lines.push(l), ["--relayer", owner, "--dry-run"])); // the owner and the relayer are one address
    expect(proxy.seen.length).to.equal(calls);
  });

  it("refuses to deploy to a node that says it is not on chain 1990, and sends and estimates nothing", async () => {
    const wrong = await nodeSaying(1983);
    try {
      const message = (await rejection(deployMain(env({ SLUICE_RPC_URL: wrong.url }), () => undefined, ["--dry-run"]))).message;
      expect(message).to.equal("the RPC is on chain 1983, but mainnet is chain 1990");
      expect((await rejection(deployMain(env({ SLUICE_RPC_URL: wrong.url }), () => undefined, []))).message).to.equal("the RPC is on chain 1983, but mainnet is chain 1990");
      expect(wrong.seen.filter((m) => SENDING.has(m))).to.deep.equal([]);
      expect(new Set(wrong.seen)).to.deep.equal(new Set(["eth_chainId"]));
    } finally {
      await wrong.close();
    }
  });

  it("refuses to run the smoke run on a node that says it is not on chain 1990, and sends nothing", async () => {
    const wrong = await nodeSaying(1983);
    try {
      const out = await rejection(smokeMain(env({ SLUICE_APPROVE: "smoke", SLUICE_RPC_URL: wrong.url, SLUICE_ROUTER: s.routerAddress }), () => undefined, ["--dry-run"]));
      expect(out.message).to.equal("the RPC is on chain 1983, but mainnet is chain 1990");
      expect(wrong.seen.filter((m) => SENDING.has(m))).to.deep.equal([]);
    } finally {
      await wrong.close();
    }
  });

  it("refuses the owner script on a node that says it is not on chain 1990, and sends nothing", async () => {
    const wrong = await nodeSaying(1983);
    try {
      const lines: string[] = [];
      const code = await ownerMain(["start", "--amount", "1"], { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "owner-setup", SLUICE_KEY: deployer.privateKey, SLUICE_ROUTER: s.routerAddress, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: wrong.url }, { log: (l) => lines.push(l) });
      expect(code).to.equal(1);
      expect(lines.join("\n")).to.contain("the RPC is on chain 1983, but mainnet is chain 1990");
      expect(wrong.seen.filter((m) => SENDING.has(m))).to.deep.equal([]);
    } finally {
      await wrong.close();
    }
  });

  it("refuses to deploy when there is no contract at QUSDC's address on the chain, or the token does not have six decimals, before it sends anything", async () => {
    const calls = before();
    const none = (await rejection(deployMain(env(), () => undefined, ["--dry-run"]))).message;
    expect(none).to.match(/there is no contract at the token address 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5 on this chain/);
    expect((await rejection(deployMain(env(), () => undefined, []))).message).to.match(/there is no contract at the token address/);
    expect(proxy.seen.slice(calls).filter((m) => SENDING.has(m))).to.deep.equal([]);
    // A token with the wrong number of decimals, and an address that is a contract but not a token.
    const eighteen = await deployContract("MockToken", ["T18", 18]);
    expect((await rejection(checkDeployToken(s.provider, await eighteen.getAddress()))).message).to.match(/has 18 decimals, and Sluice needs 6/);
    expect((await rejection(checkDeployToken(s.provider, s.routerAddress))).message).to.match(/did not answer decimals\(\)/);
    await checkDeployToken(s.provider, s.tokenAddress); // a six-decimal token passes
  });

  it("checks the token the same way inside the deploy function, so no caller can skip it", async () => {
    const lines: string[] = [];
    const ctx = { signer: deployer.connect(s.provider), provider: s.provider, meter: new SpendMeter({ maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n }), network: "mainnet" as const, log: (l: string) => lines.push(l) };
    const eighteen = await deployContract("MockToken", ["T18", 18]);
    expect((await rejection(deployRouter(ctx, { token: await eighteen.getAddress(), owner, feeRecipient: fee, feeBps: 100 }))).message).to.match(/has 18 decimals, and Sluice needs 6/);
    expect((await rejection(deployRouter(ctx, { token: s.routerAddress, owner, feeRecipient: fee, feeBps: 100 }))).message).to.match(/did not answer decimals\(\)/);
    expect((await rejection(deployRouter(ctx, { token: A(77), owner, feeRecipient: fee, feeBps: 100 }))).message).to.match(/there is no contract at the token address/);
    expect((await rejection(deployRouter(ctx, { token: s.tokenAddress, owner, feeRecipient: fee, feeBps: 201 }))).message).to.match(/fee above the 200 bps cap/);
    expect(await s.provider.getBalance(deployer.address)).to.equal(parseEther("1"));
  });

  it("prints the roles, the token's check and the default fee in a dry run, and says the fee was the default", async () => {
    // QUSDC's address holds a six-decimal token here, which is what the real address holds on mainnet.
    const mock = await deployContract("MockQUSDC");
    await network.provider.send("hardhat_setCode", [QUSDC, await network.provider.send("eth_getCode", [await mock.getAddress(), "latest"])]);
    const lines: string[] = [];
    await deployMain(env(), (l) => lines.push(l), ["--dry-run"]);
    const text = lines.join("\n");
    expect(text).to.contain(`relayer ${relayer}; owner and fee recipient are not the deployer or the relayer`);
    expect(text).to.contain(`token ${QUSDC} (has code and 6 decimals), owner ${owner}, fee recipient ${fee}, fee 100 bps (the default of 100; SLUICE_FEE_BPS was not set)`);
    expect(text).to.contain("DRY RUN of deploy: nothing is sent");
    expect(text).to.not.contain(deployer.privateKey);
    const given: string[] = [];
    await deployMain(env({ SLUICE_FEE_BPS: "50" }), (l) => given.push(l), ["--dry-run"]);
    expect(given.join("\n")).to.contain("fee 50 bps");
    expect(given.join("\n")).to.not.contain("the default");
  });

  it("refuses the smoke run, the owner script and the test token without the approval that names them, before it connects", async () => {
    const calls = before();
    expect((await rejection(smokeMain(env({ SLUICE_APPROVE: "deploy", SLUICE_ROUTER: s.routerAddress }), () => undefined))).message).to.match(/approves "deploy", not "smoke"/);
    expect((await rejection(smokeMain(env({ SLUICE_APPROVE: undefined, SLUICE_ROUTER: s.routerAddress }), () => undefined))).message).to.match(/set SLUICE_APPROVE=smoke/);
    expect((await rejection(smokeMain(env({ SLUICE_APPROVE: "smoke", SLUICE_ROUTER: s.routerAddress }), () => undefined, ["--dry-ruun"]))).message).to.match(/unknown option --dry-ruun/);
    const lines: string[] = [];
    expect(await ownerMain(["start", "--amount", "1"], { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "smoke", SLUICE_KEY: deployer.privateKey, SLUICE_ROUTER: s.routerAddress, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: proxy.url }, { log: (l) => lines.push(l) })).to.equal(1);
    expect(lines.join("\n")).to.match(/refusing to run owner-setup/);
    expect((await rejection(tokenMain(env({ SLUICE_NETWORK: "mainnet" }), () => undefined))).message).to.match(/for the testnet only/);
    expect((await rejection(tokenMain(env({ SLUICE_NETWORK: "testnet", SLUICE_APPROVE: "deploy" }), () => undefined))).message).to.match(/refusing to run deploy-test-token/);
    expect(proxy.seen.length, "no call reached the node").to.equal(calls);
  });
});

describe("How a command ends", () => {
  it("sets the exit code and lets the process end by itself, instead of calling process.exit while connections close", () => {
    const before = process.exitCode;
    const ended: number[] = [];
    try {
      const a = exitWith(0, (c) => ended.push(c));
      expect(process.exitCode).to.equal(0);
      const b = exitWith(3, (c) => ended.push(c));
      expect(process.exitCode).to.equal(3);
      // The safety net is a timer that does not keep the process alive, and that ends it with the same code if it fires. The tests clear it:
      // a command's own safety net must never end a test run.
      expect((b as unknown as { hasRef(): boolean }).hasRef()).to.equal(false);
      clearTimeout(a);
      clearTimeout(b);
      expect(ended).to.deep.equal([]);
    } finally {
      process.exitCode = before;
    }
  });

  it("is what every command-line program that uses the network does: none of them calls process.exit() directly", () => {
    // process.exit() while a connection is closing can abort Node 24 on Windows with a libuv assertion, after the work has succeeded and
    // printed its result. The two programs that touch no network end the process themselves, and src/exit.ts is the one place that may.
    const allowed = new Set(["scripts/live/wire.ts", "scripts/live/new-key.ts", "scripts/mainnet-dryrun.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of safeEntries(join(ROOT, dir))) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith(".ts") && /\bprocess\.exit\(/.test(readFileSync(join(ROOT, rel), "utf8")) && !allowed.has(rel)) offenders.push(rel);
      }
    };
    for (const dir of ["scripts/live", "scripts/client", "scripts/evidence"]) walk(dir);
    for (const file of ["scripts/evidence-check.ts", "scripts/evidence-summary.ts"]) if (/\bprocess\.exit\(/.test(readFileSync(join(ROOT, file), "utf8"))) offenders.push(file);
    expect(offenders).to.deep.equal([]);
    for (const file of ["scripts/evidence/record.ts", "scripts/evidence-check.ts", "scripts/evidence-summary.ts", "scripts/live/preflight.ts", "scripts/live/facts.ts", "scripts/live/funding.ts", "scripts/live/verify-contracts.ts", "scripts/client/owner-setup.ts", "scripts/client/smoke-client.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).to.contain("exitWith(");
    }
  });
});

describe("Mainnet: the node's chain id is checked by the shared helper", () => {
  it("passes on 1990, and refuses another chain or a node that will not say, naming the network", async () => {
    await requireNodeChain({ send: async () => "0x7c6" }, 1990, "mainnet");
    await requireNodeChain({ send: async () => 1990 }, 1990, "mainnet");
    expect((await rejection(requireNodeChain({ send: async () => "0x7bf" }, 1990, "mainnet"))).message).to.equal("the RPC is on chain 1983, but mainnet is chain 1990");
    expect((await rejection(requireNodeChain({ send: async () => "0x1" }, 1990, "mainnet"))).message).to.equal("the RPC is on chain 1, but mainnet is chain 1990");
    expect((await rejection(requireNodeChain({ send: async () => { throw new Error("down"); } }, 1990, "mainnet"))).message).to.match(/did not answer eth_chainId, so its chain could not be checked: mainnet is chain 1990/);
    expect((await rejection(requireNodeChain({ send: async () => "not a number" }, 1990, "mainnet"))).message).to.match(/did not answer eth_chainId|Cannot convert/);
  });
});

// ------------------------------------------------------------------------------------------------------- QIE's endpoints on mainnet

describe("Mainnet: reads go through the first of rpc1 to rpc5 that answers with chain 1990, and fall back to the others", () => {
  const chainReply = (id: number) => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: `0x${id.toString(16)}` }) });
  /** A fetch where each endpoint does what the table says: "down", "slow" (never answers), "500", or a chain id. */
  const fetchWhere = (table: Record<string, string | number>): typeof fetch =>
    (async (url: string, init: { signal?: AbortSignal }) => {
      const what = table[new URL(url).host.split(".")[0] as string];
      if (what === "down") throw new Error("ECONNREFUSED");
      if (what === "slow") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      if (what === "500") return { status: 500, json: async () => ({}) };
      return chainReply(what as number);
    }) as unknown as typeof fetch;

  it("names QIE's five mainnet endpoints, rpc1 to rpc5", () => {
    expect(QIE_ENDPOINTS.mainnet).to.deep.equal([1, 2, 3, 4, 5].map((n) => `https://rpc${n}mainnet.qie.digital/`));
    expect(QIE_ENDPOINTS.testnet.every((u) => u.includes("testnet"))).to.equal(true);
  });

  it("skips a dead endpoint, one on the wrong chain, one that errors and one that never answers, and keeps the healthy ones as fallbacks", async () => {
    const fetchImpl = fetchWhere({ rpc1mainnet: "down", rpc2mainnet: 1983, rpc3mainnet: 1990, rpc4mainnet: "500", rpc5mainnet: 1990 });
    const sel = await resolveEndpoint("mainnet", undefined, { fetchImpl, timeoutMs: 200 });
    expect(sel.url).to.equal("https://rpc3mainnet.qie.digital/");
    expect(sel.fallbacks).to.deep.equal(["https://rpc5mainnet.qie.digital/"]);
    expect(sel.probes.map((p) => p.reason ?? "ok")).to.deep.equal(["unreachable", "wrong_chain", "ok", "bad_answer", "ok"]);
    expect(describeSelection(sel)).to.match(/^RPC endpoint rpc3mainnet.qie.digital \(chain 1990, \d+ ms\); 1 fallback; skipped rpc1mainnet unreachable, rpc2mainnet chain 1983, rpc4mainnet bad_answer$/);
    const slow = await resolveEndpoint("mainnet", undefined, { fetchImpl: fetchWhere({ rpc1mainnet: "slow", rpc2mainnet: 1990, rpc3mainnet: 1990, rpc4mainnet: 1990, rpc5mainnet: 1990 }), timeoutMs: 100 });
    expect(slow.url).to.equal("https://rpc2mainnet.qie.digital/");
    expect(slow.probes[0]?.reason).to.equal("timeout");
  });

  it("stops with each endpoint's reason when none answers with chain 1990, and never falls back to a testnet endpoint", async () => {
    const fetchImpl = fetchWhere({ rpc1mainnet: "down", rpc2mainnet: 1983, rpc3mainnet: "500", rpc4mainnet: 1, rpc5mainnet: "down" });
    const err = await rejection(resolveEndpoint("mainnet", undefined, { fetchImpl, timeoutMs: 100 }));
    expect(err).to.be.instanceOf(NoHealthyEndpoint);
    expect(err.message).to.match(/none of 5 RPC endpoints answered with chain 1990/);
    expect(err.message).to.not.contain("testnet.qie.digital");
    const seen: string[] = [];
    await resolveEndpoint("mainnet", undefined, { fetchImpl: ((url: string) => (seen.push(url), Promise.resolve(chainReply(1990)))) as unknown as typeof fetch });
    expect(seen.every((u) => u.includes("mainnet.qie.digital"))).to.equal(true);
  });

  it("uses an endpoint named by SLUICE_RPC_URL as given, with no probe and no fallback, and the scripts choose through the same helper", async () => {
    const seen: string[] = [];
    const named = await resolveEndpoint("mainnet", "http://127.0.0.1:9999", { fetchImpl: (async (u: string) => (seen.push(u), chainReply(1990))) as unknown as typeof fetch });
    expect(named).to.deep.equal({ url: "http://127.0.0.1:9999", fallbacks: [], probes: [], overridden: true });
    expect(seen).to.deep.equal([]);
    const lines: string[] = [];
    const chosen = await chooseRpc("mainnet", undefined, (l) => lines.push(l), { fetchImpl: fetchWhere({ rpc1mainnet: "down", rpc2mainnet: 1990, rpc3mainnet: 1990, rpc4mainnet: 1990, rpc5mainnet: 1990 }), timeoutMs: 100 });
    expect(chosen).to.deep.include({ url: "https://rpc2mainnet.qie.digital/", network: "mainnet", chainId: 1990 });
    expect(lines[0]).to.contain("rpc2mainnet.qie.digital");
  });

  it("no longer has the wallet MCP read from rpc1 alone", () => {
    const source = readFileSync(join(ROOT, "packages", "wallet-mcp", "src", "cli.ts"), "utf8");
    expect(source).to.not.contain("rpc1mainnet");
    expect(source).to.contain("resolveEndpoint");
    expect(source).to.contain("requireNodeChain");
  });
});

// ------------------------------------------------------------------------------------------------------- the recorder's mainnet table

describe("Mainnet: the recorder's table and links", () => {
  const row = (network: "mainnet" | "testnet" | "fork", claim = "deposit") => ({
    network, date: "2026-11-22T10:00:00Z", event: "Deposited", hash: `0x${"cd".repeat(32)}`, block: "12090001", contract: A(5), amount: "0.300000", who: A(6), claim, recheck: "pnpm evidence:check --hash 0x…",
  });

  it("links a mainnet transaction to https://mainnet.qie.digital, a deployment's verification to the contract's page, and leaves testnet and fork hashes bare", () => {
    expect(hashCell(row("mainnet"))).to.equal(`[0x${"cd".repeat(32)}](https://mainnet.qie.digital/tx/0x${"cd".repeat(32)})`);
    expect(hashCell({ ...row("mainnet", "verify-link"), contract: A(5) })).to.equal(`[0x${"cd".repeat(32)}](https://mainnet.qie.digital/address/${A(5)}?tab=contract)`);
    expect(hashCell(row("testnet"))).to.equal(`0x${"cd".repeat(32)}`);
    expect(hashCell(row("fork"))).to.equal(`0x${"cd".repeat(32)}`);
    expect(renderRow(row("mainnet"))).to.contain("| mainnet | deposit |");
  });

  it("writes a mainnet row under the Mainnet table and a fork row under its own heading, which the proof strip never reads", () => {
    const text = readFileSync(join(ROOT, "docs", "EVIDENCE.md"), "utf8").replace(/\r\n/g, "\n");
    expect(text).to.contain("## Mainnet (chain 1990)");
    const withMainnet = appendRows(text, [row("mainnet") as never]);
    const mainnetSection = withMainnet.split("## Mainnet (chain 1990)")[1]?.split("\n## ")[0] ?? "";
    expect(mainnetSection).to.contain(`https://mainnet.qie.digital/tx/0x${"cd".repeat(32)}`);
    const withFork = appendRows(text, [row("fork") as never]);
    expect(withFork).to.contain("## Fork (a local copy of QIE mainnet; never counted)");
    expect(withFork.split("## Mainnet (chain 1990)")[1]?.split("\n## ")[0] ?? "").to.not.contain(`0x${"cd".repeat(32)}`);
  });
});

// ------------------------------------------------------------------------------------------------------- exits by signature, and fork evidence

describe("Taking money out by signature, and checking a fork run's evidence", function () {
  this.timeout(240_000);
  let s: Stack;
  let dir: string;
  const ownerEnv = (key: string, extra: Record<string, string> = {}) => ({
    SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "owner-setup", SLUICE_KEY: key, SLUICE_ROUTER: s.routerAddress, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, ...extra,
  });
  const run = async (argv: string[], env: Record<string, string>) => {
    const lines: string[] = [];
    const code = await ownerMain(argv, env, { log: (l) => lines.push(l) });
    return { code, text: lines.join("\n") };
  };

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    dir = mkdtempSync(join(tmpdir(), "sluice-exit-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("signs a withdrawal that recovers to the signer, a refund that does too, and a nonce that makes each usable once", async () => {
    const w = throwawayWallet();
    const args = { account: w.address, to: A(5), amount: 1_000_000n, nonce: hexlify(randomBytes(32)), deadline: 2n ** 40n };
    const sig = await signWithdraw(w, s.routerAddress, args);
    expect(sig).to.match(/^0x[0-9a-f]{130}$/);
    expect(await signWithdraw(w, s.routerAddress, args)).to.equal(sig);
    expect(await signWithdraw(w, s.routerAddress, { ...args, nonce: hexlify(randomBytes(32)) })).to.not.equal(sig);
    expect(await signWithdraw(w, s.routerAddress, { ...args, amount: 1_000_001n })).to.not.equal(sig);
    expect(await signRefund(w, s.routerAddress, args)).to.not.equal(sig);
  });

  it("lets a builder with no QIE withdraw its earnings through the facilitator, and refuses more than it has", async () => {
    const builder = throwawayWallet();
    await stackEarn(s, builder.address, USDC("2"));
    const earned = (await s.router.earnings(builder.address)) as bigint;
    expect(earned).to.equal(USDC("1.98"));
    expect(await s.provider.getBalance(builder.address)).to.equal(0n);
    const tooMuch = await run(["withdraw", "--amount", "5"], ownerEnv(builder.privateKey));
    expect(tooMuch.code).to.equal(1);
    expect(tooMuch.text).to.contain("earnings in the router is 1.980000 QUSDC, less than the 5.000000 asked for");
    const ok = await run(["withdraw", "--amount", "1.5"], ownerEnv(builder.privateKey));
    expect(ok.code, ok.text).to.equal(0);
    expect(ok.text).to.contain("signed a withdrawal of 1.500000 QUSDC");
    expect(ok.text).to.match(/withdrawn: 0x[0-9a-f]{64}/);
    expect(ok.text).to.contain("record it: pnpm evidence:record --claim withdraw --tx 0x");
    expect(await s.token.balanceOf(builder.address)).to.equal(USDC("1.5"));
    expect(await s.router.earnings(builder.address)).to.equal(USDC("0.48"));
    expect(await s.provider.getBalance(builder.address), "the builder still holds no QIE").to.equal(0n);
    // To another address.
    const to = A(77);
    expect((await run(["withdraw", "--amount", "0.1", "--to", to], ownerEnv(builder.privateKey))).code).to.equal(0);
    expect(await s.token.balanceOf(to)).to.equal(USDC("0.1"));
  });

  it("lets a payer with no QIE take back its unspent balance, and refuses what it has not got", async () => {
    const payer = throwawayWallet();
    await fundWallet(s, payer, USDC("3"), parseEther("1"));
    await depositFor(s, payer, USDC("3"));
    await setQie(payer.address, 0n);
    expect((await run(["refund", "--amount", "9"], ownerEnv(payer.privateKey))).text).to.contain("prepaid balance in the router is 3.000000 QUSDC, less than the 9.000000 asked for");
    const ok = await run(["refund", "--amount", "2"], ownerEnv(payer.privateKey));
    expect(ok.code, ok.text).to.equal(0);
    const hash = /refunded: (0x[0-9a-f]{64})/.exec(ok.text)?.[1] as string;
    expect(hash).to.match(/^0x[0-9a-f]{64}$/);
    expect(ok.text).to.contain(`record it: pnpm evidence:record --claim refund --tx ${hash} --network `);
    expect(ok.text).to.not.contain("--claim withdraw");
    expect(await s.token.balanceOf(payer.address)).to.equal(USDC("2"));
    expect(await s.router.payerBalance(payer.address)).to.equal(USDC("1"));
  });

  it("needs the approval, an amount and a real recipient, and counts only a start against the QUSDC cap", async () => {
    const w = throwawayWallet();
    expect((await run(["withdraw", "--amount", "1"], ownerEnv(w.privateKey, { SLUICE_APPROVE: "smoke" }))).text).to.match(/refusing to run owner-setup/);
    expect((await run(["withdraw"], ownerEnv(w.privateKey))).text).to.contain("withdraw needs --amount");
    expect((await run(["refund"], ownerEnv(w.privateKey))).text).to.contain("refund needs --amount");
    expect((await run(["withdraw", "--amount", "1", "--to", "0x12"], ownerEnv(w.privateKey))).text).to.contain("--to is not an address");
    expect((await run(["bogus"], ownerEnv(w.privateKey))).text).to.contain("the command is start, authorize, revoke, withdraw or refund");
    // A withdrawal above the QUSDC cap is not stopped by it: nothing leaves the owner's wallet.
    const builder = throwawayWallet();
    await stackEarn(s, builder.address, USDC("30"));
    expect((await run(["withdraw", "--amount", "20"], ownerEnv(builder.privateKey, { SLUICE_MAX_QUSDC: "1" }))).code).to.equal(0);
  });

  it("records a fork run's rows in a copy of the evidence file, and checks and counts them with the commands used on mainnet", async () => {
    const copy = join(dir, "EVIDENCE.copy.md");
    copyFileSync(join(ROOT, "docs", "EVIDENCE.md"), copy);
    const real = readFileSync(join(ROOT, "docs", "EVIDENCE.md"), "utf8");
    const w = throwawayWallet();
    await fundWallet(s, w, USDC("1"), parseEther("1"));
    const connected = w.connect(s.provider);
    const token = s.token.connect(connected) as unknown as Contract;
    await (await token.getFunction("approve")(s.routerAddress, USDC("1"))).wait();
    const tx = await (s.router.connect(connected) as unknown as Contract).getFunction("deposit")(USDC("1"));
    await tx.wait();

    const lines: string[] = [];
    const recorded = await recordMain(["--claim", "deposit", "--tx", tx.hash, "--network", "fork", "--router", s.routerAddress, "--rpc", s.rpcUrl, "--file", copy], {}, { log: (l) => lines.push(l) });
    expect(recorded, lines.join("\n")).to.equal(0);
    expect(readFileSync(join(ROOT, "docs", "EVIDENCE.md"), "utf8"), "docs/EVIDENCE.md was not touched").to.equal(real);
    expect(readFileSync(copy, "utf8")).to.contain("## Fork (a local copy of QIE mainnet; never counted)");

    const check: string[] = [];
    expect(await checkMain(["--file", copy, "--fork"], { EVIDENCE_RPC_URL: s.rpcUrl }, (l) => check.push(l))).to.equal(0);
    expect(check.join("\n")).to.contain("PASS    fork Deposited");
    expect(check.join("\n")).to.contain("evidence:check 1 row(s): 1 passed, 0 failed, 0 skipped");

    const summary: string[] = [];
    expect(await summaryMain({ SLUICE_ROUTER: s.routerAddress, SLUICE_FROM_BLOCK: "0", SLUICE_NETWORK: "mainnet", EVIDENCE_RPC_URL: s.rpcUrl }, (l) => summary.push(l), undefined, undefined, undefined, ["--file", copy, "--fork"])).to.equal(0);
    expect(summary.join("\n")).to.contain("recorded fork rows");
    expect(summary.join("\n")).to.contain("none of this is evidence of anything on mainnet");
    expect(summary.join("\n")).to.match(/deposit\s+rows 1, distinct addresses 1/);

    // A row that is not on the chain fails, and the check says so.
    writeFileSync(copy, readFileSync(copy, "utf8").replace(/\| 0\.0*1?\d*\.?\d* \|/, (m) => m).replace(tx.hash, `0x${"ee".repeat(32)}`));
    const bad: string[] = [];
    expect(await checkMain(["--file", copy, "--fork"], { EVIDENCE_RPC_URL: s.rpcUrl }, (l) => bad.push(l))).to.equal(1);
  });

  it("refuses fork rows without a copy, over docs/EVIDENCE.md, or against a node that is not on this machine", async () => {
    const copy = join(dir, "EVIDENCE.copy.md");
    copyFileSync(join(ROOT, "docs", "EVIDENCE.md"), copy);
    const out = async (argv: string[], env: Record<string, string>) => {
      const lines: string[] = [];
      const code = await checkMain(argv, env, (l) => lines.push(l));
      return { code, text: lines.join("\n") };
    };
    expect((await out(["--fork"], { EVIDENCE_RPC_URL: s.rpcUrl })).text).to.contain("--fork needs --file");
    expect((await out(["--fork", "--file", join(ROOT, "docs", "EVIDENCE.md")], { EVIDENCE_RPC_URL: s.rpcUrl })).text).to.contain("never written to docs/EVIDENCE.md: give a copy");
    expect((await out(["--fork", "--file", copy], {})).text).to.contain("only against a node on this machine");
    expect((await out(["--fork", "--file", copy], { EVIDENCE_RPC_URL: "https://rpc1mainnet.qie.digital/" })).text).to.contain("only against a node on this machine");
    expect((await out(["--file"], {})).text).to.contain("--file needs the path");
    const summary = async (argv: string[], env: Record<string, string>) => {
      const lines: string[] = [];
      const code = await summaryMain(env, (l) => lines.push(l), undefined, undefined, undefined, argv);
      return { code, text: lines.join("\n") };
    };
    expect((await summary(["--fork"], { EVIDENCE_RPC_URL: s.rpcUrl })).text).to.contain("--fork needs --file");
    expect((await summary(["--fork", "--file", copy], { EVIDENCE_RPC_URL: "https://rpc1mainnet.qie.digital/" })).text).to.contain("only on a node on this machine");
    expect((await summary(["--file"], {})).text).to.contain("--file needs the path");
    // With no fork rows in the copy, the check says there are none.
    expect((await out(["--fork", "--file", copy], { EVIDENCE_RPC_URL: s.rpcUrl })).text).to.contain("0 row(s)");
  });
});

/** A builder earns `amount` from a payer's signed intent: deposit, sign, settle. The builder holds no QIE. */
async function stackEarn(s: Stack, builder: string, amount: bigint): Promise<void> {
  await s.mint(s.payer.address, amount);
  await s.token.connect(s.payer).approve(s.routerAddress, amount);
  await s.router.connect(s.payer).deposit(amount);
  const { intent, signature } = await signedIntent(s, s.payer, s.payer.address, builder, amount);
  await s.router.connect(s.stranger).settle(intent, signature);
}
