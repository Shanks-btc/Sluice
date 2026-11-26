// The vault check (pnpm live:vaultcheck): is the code at the router's vault the compiled AgentVault? The vault is created by the router's
// constructor, and its code can be checked without any explorer. These tests deploy a real router and vault on the local chain (whose
// chain id is mainnet's), read them back through the same functions the command uses, and then change the vault's code in each kind of
// place to see that each change is found and named. The end of the file holds what may be said about the vault on the explorer to the
// explorer's saved answer. Nothing here touches a network.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { TypedDataEncoder, getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes, zeroPadValue } from "ethers";
import { network } from "hardhat";
import { vaultVerifiedClaims } from "../../src/claims";
import { NetworkError, parseEvidenceStrict } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import { VAULT_RECORD_PATH, explorerShowsVault } from "../../src/vault-record";
import { RpcRefused } from "../../src/readrpc";
import { copyable, safeReaddir } from "../../src/secret-paths";
import { EXPECTED, VerifyError } from "../../src/verify-contracts";
import {
  VAULTCHECK_READ_ONLY_METHODS,
  VAULT_DOMAIN_NAME,
  VAULT_DOMAIN_VERSION,
  checkVault,
  embeddedSolc,
  expectedCode,
  formatLines,
  readCompiled,
  readVaultFacts,
  reproductionLines,
  slotValues,
} from "../../src/vaultcheck";
import type { Compiled, VaultFacts } from "../../src/vaultcheck";
import { main } from "../../scripts/live/vaultcheck";
import { deploy, vaultDomain } from "../helpers";
import type { World } from "../helpers";

const ROOT = join(__dirname, "..", "..");
const CHAIN = 1990;
/** An empty folder to run the command in: it looks for deployment.json in the folder it is run from, and the repository's own may hold the founder's. */
const EMPTY = mkdtempSync(join(tmpdir(), "sluice-vaultcheck-"));
const OTHER = getAddress(`0x${"ab".repeat(20)}`);

/** A reader of the local chain that records every method it is asked, and answers a method it has an override for. */
function reader(overrides: (method: string, params: unknown[]) => unknown | undefined = () => undefined): { rpc: Rpc; methods: string[] } {
  const methods: string[] = [];
  const rpc: Rpc = async (method, params) => {
    methods.push(method);
    const over = overrides(method, params);
    if (over !== undefined) {
      if (over instanceof Error) throw over;
      return over;
    }
    return network.provider.send(method, params);
  };
  return { rpc, methods };
}

/** `code` with the bytes at `offset` replaced. */
function patch(code: string, offset: number, replacement: string): string {
  const hex = code.slice(2);
  const bytes = replacement.replace(/^0x/, "");
  return `0x${hex.slice(0, offset * 2)}${bytes}${hex.slice(offset * 2 + bytes.length)}`;
}

after(() => rmSync(EMPTY, { recursive: true, force: true }));

describe("Vault check: what the repository compiled for AgentVault", () => {
  const compiled = readCompiled(ROOT);

  it("has the documented settings, and names the six immutables in seven places", () => {
    expect(compiled.compilerVersion).to.equal(`v${EXPECTED.longVersion}`);
    expect(compiled.evmVersion).to.equal("shanghai");
    expect(compiled.optimizerRuns).to.equal(200);
    expect(compiled.slots).to.have.length(7);
    expect([...new Set(compiled.slots.map((s) => s.name))].sort()).to.deep.equal(["_cachedChainId", "_cachedSeparator", "_cachedThis", "_nameHash", "_versionHash", "router"]);
    expect(compiled.slots.every((s) => s.length === 32)).to.equal(true);
    expect(compiled.slots.filter((s) => s.name === "router")).to.have.length(2); // the code reads the router in two places
    // The slots are in the compiled code, in order, and each is zero there: the compiler leaves a hole and the constructor fills it.
    const starts = compiled.slots.map((s) => s.start);
    expect(starts).to.deep.equal([...starts].sort((a, b) => a - b));
    for (const s of compiled.slots) expect(compiled.runtime.slice(2 + s.start * 2, 2 + (s.start + 32) * 2)).to.equal("00".repeat(32));
  });

  it("agrees with the compiler's own record of where its immutables are", () => {
    const dir = join(ROOT, "artifacts", "build-info");
    const info = JSON.parse(readFileSync(join(dir, safeReaddir(dir).filter((f) => f.endsWith(".json"))[0] as string), "utf8")) as {
      output: { contracts: Record<string, Record<string, { evm: { deployedBytecode: { immutableReferences: Record<string, Array<{ start: number; length: number }>> } } }>> };
    };
    const refs = Object.values(info.output.contracts["contracts/AgentVault.sol"]?.AgentVault?.evm.deployedBytecode.immutableReferences ?? {}).flat();
    expect(compiled.slots.map((s) => [s.start, s.length])).to.deep.equal(refs.map((r) => [r.start, r.length]).sort((a, b) => (a[0] as number) - (b[0] as number)));
  });

  it("works out each slot's value from the router, the vault's address and the chain id, as the constructor does", () => {
    const vault = getAddress(`0x${"cd".repeat(20)}`);
    const values = slotValues({ router: OTHER, vault, chainId: CHAIN });
    expect(values.router).to.equal(zeroPadValue(OTHER, 32));
    expect(values._cachedThis).to.equal(zeroPadValue(vault, 32));
    expect(values._cachedChainId).to.equal(zeroPadValue("0x07c6", 32)); // 1990
    expect(values._nameHash).to.equal(keccak256(toUtf8Bytes("SluiceAgentVault")));
    expect(values._versionHash).to.equal(keccak256(toUtf8Bytes("1")));
    // The domain separator is the one a wallet signs against (the same domain the tests use for the vault's signatures).
    expect(values._cachedSeparator).to.equal(TypedDataEncoder.hashDomain(vaultDomain(vault, CHAIN)));
    expect([VAULT_DOMAIN_NAME, VAULT_DOMAIN_VERSION]).to.deep.equal(["SluiceAgentVault", "1"]);
    // Another chain or another address gives another separator.
    expect(slotValues({ router: OTHER, vault, chainId: 1983 })._cachedSeparator).to.not.equal(values._cachedSeparator);
    expect(slotValues({ router: OTHER, vault: OTHER, chainId: CHAIN })._cachedSeparator).to.not.equal(values._cachedSeparator);
  });

  it("builds the code of a vault the router really created, byte for byte", async () => {
    const w = await deploy();
    const onChain = (await network.provider.send("eth_getCode", [w.vaultAddress, "latest"])) as string;
    const built = expectedCode(compiled, { router: w.routerAddress, vault: w.vaultAddress, chainId: CHAIN });
    expect(built.unknown).to.deep.equal([]);
    expect(built.code).to.equal(onChain.toLowerCase());
    // The compiled code alone, with every slot zero, is not what is on chain: the slots are what the constructor writes.
    expect(keccak256(compiled.runtime)).to.not.equal(keccak256(onChain));
    expect(embeddedSolc(onChain)).to.equal("0.8.24");
  });

  it("reads the solc version out of the end of a contract's code, and says so when it is not there", () => {
    expect(embeddedSolc(`0x6080${"00".repeat(40)}a264697066735822${"11".repeat(34)}64736f6c63430008180033`)).to.equal("0.8.24");
    expect(embeddedSolc("0x6080")).to.equal(undefined);
    expect(embeddedSolc("0x")).to.equal(undefined);
    expect(embeddedSolc(`0x${"00".repeat(60)}0033`)).to.equal(undefined);
  });
});

describe("Vault check: a router and vault on the local chain", function () {
  this.timeout(120_000);
  const compiled = readCompiled(ROOT);
  let w: World;
  let facts: VaultFacts;

  beforeEach(async () => {
    w = await deploy();
    facts = await readVaultFacts(reader().rpc, w.routerAddress);
  });

  const fails = (lines: Array<{ level: string; text: string }>): string[] => lines.filter((l) => l.level === "FAIL").map((l) => l.text);

  it("passes every line, and the two hashes are the same one", () => {
    const report = checkVault(facts, compiled, CHAIN);
    expect(fails(report.lines)).to.deep.equal([]);
    expect(report.chainHash).to.equal(report.expectedHash);
    expect(report.chainHash).to.equal(keccak256((facts.vaultCode as string)));
    expect(report.codeBytes).to.equal(((facts.vaultCode as string).length - 2) / 2);
    const text = formatLines(report.lines).join("\n");
    expect(text).to.contain(`PASS  the router's vault() is ${w.vaultAddress}`);
    expect(text).to.contain("PASS  the vault's router() is this router");
    expect(text).to.contain("PASS  the compiler's own metadata at the end of the vault's code names solc 0.8.24");
    expect(text).to.contain("the compiled AgentVault has 6 immutables, in 7 places in its code (router, _cachedThis, _cachedChainId, _cachedSeparator, _nameHash, _versionHash)");
    expect(text).to.contain(`PASS  the code at the vault is the compiled AgentVault: both hash to ${report.chainHash}`);
  });

  it("reads the vault from the router, at one block, with four read-only methods and nothing else", async () => {
    const r = reader();
    const read = await readVaultFacts(r.rpc, w.routerAddress);
    expect(read.vault).to.equal(w.vaultAddress);
    expect(read.vaultRouter).to.equal(w.routerAddress);
    expect(read.routerHasCode).to.equal(true);
    expect(r.methods.length).to.be.greaterThan(4);
    for (const method of r.methods) expect(VAULTCHECK_READ_ONLY_METHODS.has(method), method).to.equal(true);
    expect([...VAULTCHECK_READ_ONLY_METHODS].sort()).to.deep.equal(["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode"]);
  });

  it("finds a change anywhere in the code outside the immutable slots, and says so", () => {
    const code = facts.vaultCode as string;
    const changed = patch(code, 100, "ff"); // a byte of the program itself
    expect(changed).to.not.equal(code);
    const report = checkVault({ ...facts, vaultCode: changed }, compiled, CHAIN);
    const text = fails(report.lines).join("\n");
    expect(text).to.match(/the code at the vault is not the compiled AgentVault: the chain's hashes to 0x[0-9a-f]{64} and the compiled one to 0x[0-9a-f]{64}/);
    expect(text).to.contain("the code outside the immutable slots differs from the compiled AgentVault");
    expect(report.chainHash).to.not.equal(report.expectedHash);
  });

  it("finds a wrong value in each immutable slot, and names the slot", () => {
    const code = facts.vaultCode as string;
    const wrong: Record<string, string> = {
      router: zeroPadValue(OTHER, 32),
      _cachedThis: zeroPadValue(OTHER, 32),
      _cachedChainId: zeroPadValue("0x07c7", 32),
      _cachedSeparator: hexlify(randomBytes(32)),
      _nameHash: keccak256(toUtf8Bytes("SomethingElse")),
      _versionHash: keccak256(toUtf8Bytes("2")),
    };
    for (const slot of compiled.slots) {
      const report = checkVault({ ...facts, vaultCode: patch(code, slot.start, wrong[slot.name] as string) }, compiled, CHAIN);
      const text = fails(report.lines).join("\n");
      expect(text, `${slot.name} at ${slot.start}`).to.contain(`the immutable ${slot.name} at byte ${slot.start} is 0x${wrong[slot.name]?.slice(2)} on chain`);
      expect(text, slot.name).to.not.contain("the code outside the immutable slots differs");
    }
  });

  it("finds code of another length, a vault deployed on another chain, and a vault that belongs to another router", async () => {
    const code = facts.vaultCode as string;
    expect(fails(checkVault({ ...facts, vaultCode: `${code}00` }, compiled, CHAIN).lines).join("\n")).to.match(/the code on chain is 6175 bytes, and the compiled code is 6174 bytes/);
    // Code that was built for chain 1 reads as a chain id and a separator that are not this chain's.
    const elsewhere = patch(patch(code, compiled.slots.find((s) => s.name === "_cachedChainId")!.start, zeroPadValue("0x01", 32)), compiled.slots.find((s) => s.name === "_cachedSeparator")!.start, hexlify(randomBytes(32)));
    const text = fails(checkVault({ ...facts, vaultCode: elsewhere }, compiled, CHAIN).lines).join("\n");
    expect(text).to.contain("the immutable _cachedChainId");
    expect(text).to.contain("the immutable _cachedSeparator");
    // A vault whose router() names another router.
    const other = fails(checkVault({ ...facts, vaultRouter: OTHER }, compiled, CHAIN).lines).join("\n");
    expect(other).to.contain(`the vault's router() is ${OTHER}, not this router`);
  });

  it("fails, and stops, when the chain is not the one asked for, the router has no code, the router names no vault, or the vault has no code", () => {
    expect(fails(checkVault(facts, compiled, 1983).lines)).to.deep.equal([`the RPC is on chain ${CHAIN}, not 1983`]);
    const none = checkVault({ ...facts, routerHasCode: false, vault: undefined, vaultCode: undefined }, compiled, CHAIN);
    expect(fails(none.lines)).to.deep.equal([`there is no contract at the router address ${facts.router} on this chain`]);
    expect(fails(checkVault({ ...facts, vault: undefined, vaultCode: undefined, vaultRouter: undefined }, compiled, CHAIN).lines).join()).to.match(/does not answer vault\(\) with an address/);
    expect(fails(checkVault({ ...facts, vault: `0x${"0".repeat(40)}` }, compiled, CHAIN).lines).join()).to.match(/vault\(\) is the zero address/);
    expect(fails(checkVault({ ...facts, vaultCode: "0x" }, compiled, CHAIN).lines).join()).to.match(/there is no code at the vault address/);
    expect(fails(checkVault({ ...facts, vaultCode: undefined }, compiled, CHAIN).lines).join()).to.match(/there is no code at the vault address/);
  });

  it("fails a vault whose code names another compiler", () => {
    const code = facts.vaultCode as string;
    // Inside the metadata at the end of the code, change the three bytes that name the compiler: 0.8.24 becomes 0.8.23.
    const solcAt = code.toLowerCase().lastIndexOf("64736f6c6343");
    expect(solcAt).to.be.greaterThan(0);
    const other = `${code.slice(0, solcAt + 12)}000817${code.slice(solcAt + 18)}`;
    const text = fails(checkVault({ ...facts, vaultCode: other }, compiled, CHAIN).lines).join("\n");
    expect(text).to.contain("names solc 0.8.23, not 0.8.24");
  });

  it("compares with what deployment.json recorded, when it is the record of this router, and fails a vault or a hash that differs", () => {
    const hash = keccak256(facts.vaultCode as string);
    const ok = checkVault(facts, compiled, CHAIN, { vault: w.vaultAddress, vaultCodeHash: hash });
    expect(fails(ok.lines)).to.deep.equal([]);
    expect(formatLines(ok.lines).join("\n")).to.contain("PASS  that is the vault in deployment.json");
    expect(formatLines(ok.lines).join("\n")).to.contain("PASS  that is also the code hash deployment.json recorded when the router was deployed");
    expect(fails(checkVault(facts, compiled, CHAIN, { vault: OTHER }).lines).join()).to.contain(`deployment.json names another vault: ${OTHER}`);
    expect(fails(checkVault(facts, compiled, CHAIN, { vaultCodeHash: `0x${"11".repeat(32)}` }).lines).join()).to.contain("deployment.json recorded another code hash for the vault");
  });

  it("says which slot a check does not know a value for, instead of passing a vault it cannot fully check", () => {
    const stranger: Compiled = { ...compiled, slots: [...compiled.slots, { name: "_surprise", start: 1, length: 32 }] };
    const report = checkVault(facts, stranger, CHAIN);
    expect(fails(report.lines).join("\n")).to.contain("an immutable this check does not know a value for: _surprise");
    expect(report.chainHash).to.equal(undefined);
  });

  it("prints what a reader needs to build it again: the settings, the constructor argument, each slot and both hashes", () => {
    const report = checkVault(facts, compiled, CHAIN);
    const text = reproductionLines(compiled, report, { router: facts.router, vault: facts.vault as string, chainId: CHAIN }).join("\n");
    expect(text).to.contain("compiler        solc v0.8.24+commit.e11b9ed9");
    expect(text).to.contain("optimizer       enabled, 200 runs");
    expect(text).to.contain("EVM version     shanghai");
    expect(text).to.contain("contract        contracts/AgentVault.sol:AgentVault (licence MIT)");
    expect(text).to.contain(`constructor     one argument, the router's address: ${zeroPadValue(w.routerAddress, 32)}`);
    for (const s of compiled.slots) expect(text).to.match(new RegExp(`\\b${s.start}  ${s.name}\\b`));
    expect(text).to.contain(`the hash of the compiled code with those slots filled in: ${report.expectedHash}`);
    expect(text).to.contain(`the hash of the code at the vault, from eth_getCode:      ${report.chainHash}`);
  });
});

describe("Vault check: the command", function () {
  this.timeout(120_000);
  let w: World;
  const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ SLUICE_NETWORK: "mainnet", ...extra });
  const run = async (argv: string[], environment = env(), io: { rpc?: Rpc; cwd?: string; root?: string } = {}) => {
    const lines: string[] = [];
    const code = await main(argv, environment, { log: (l) => lines.push(l), cwd: EMPTY, rpc: io.rpc ?? reader().rpc, ...io });
    return { code, out: lines.join("\n") };
  };

  beforeEach(async () => {
    w = await deploy();
  });

  it("prints PASS for every line and exits 0 for a vault that is the compiled one, with the reproduction and what the check is without an explorer", async () => {
    const r = await run(["--router", w.routerAddress]);
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/^Vault check on mainnet \(chain 1990\), read at block \d+, .* Read-only: eth_chainId, eth_getBlockByNumber, eth_call and eth_getCode\.$/m);
    expect(r.out).to.contain(`router ${w.routerAddress} (--router)`);
    expect(r.out).to.match(/^vaultcheck: \d+ passed, 0 failed$/m);
    expect(r.out).to.not.match(/^FAIL/m);
    expect(r.out).to.contain("To build it again without trusting this program:");
    expect(r.out).to.contain("solc v0.8.24+commit.e11b9ed9");
    expect(r.out).to.contain("a comparison of the code on the chain with this repository's build, with the values the constructor wrote into it, read over RPC with no explorer");
    expect(r.out).to.contain("What an explorer shows for the vault's page is a separate matter: see docs/EXPLORER-VAULT-INVESTIGATION.md.");
    // A check made on a local chain claims nothing of any explorer: no line of it says the vault is verified, even with the explorer named.
    for (const line of r.out.split("\n")) expect(vaultVerifiedClaims(line), line).to.deep.equal([]);
  });

  it("exits 1 and prints FAIL for a vault whose code is not the compiled one", async () => {
    const code = (await network.provider.send("eth_getCode", [w.vaultAddress, "latest"])) as string;
    await network.provider.send("hardhat_setCode", [w.vaultAddress, patch(code, 100, "ff")]);
    const r = await run(["--router", w.routerAddress]);
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/^FAIL {2}the code at the vault is not the compiled AgentVault/m);
    expect(r.out).to.match(/^vaultcheck: \d+ passed, [1-9]\d* failed$/m);
  });

  it("takes the router from --router, then SLUICE_ROUTER, then deployment.json in the folder it is run from, and compares with that record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-vaultcheck-deploy-"));
    try {
      const code = (await network.provider.send("eth_getCode", [w.vaultAddress, "latest"])) as string;
      writeFileSync(join(dir, "deployment.json"), JSON.stringify({ router: w.routerAddress, vault: w.vaultAddress, vaultCodeHash: keccak256(code) }));
      const fromFile = await run([], env(), { cwd: dir });
      expect(fromFile.code, fromFile.out).to.equal(0);
      expect(fromFile.out).to.contain(`router ${w.routerAddress} (deployment.json)`);
      expect(fromFile.out).to.contain("PASS  that is the vault in deployment.json");
      expect(fromFile.out).to.contain("PASS  that is also the code hash deployment.json recorded when the router was deployed");
      const fromEnv = await run([], env({ SLUICE_ROUTER: w.routerAddress }), { cwd: dir });
      expect(fromEnv.out).to.contain(`router ${w.routerAddress} (SLUICE_ROUTER)`);
      // The record is used only for the router it describes: another router gets no comparison with it.
      const other = await run(["--router", OTHER], env(), { cwd: dir });
      expect(other.out).to.not.contain("deployment.json");
      // A record whose hash is wrong fails the check even though the code is the compiled one.
      writeFileSync(join(dir, "deployment.json"), JSON.stringify({ router: w.routerAddress, vault: w.vaultAddress, vaultCodeHash: `0x${"22".repeat(32)}` }));
      const stale = await run([], env(), { cwd: dir });
      expect(stale.code).to.equal(1);
      expect(stale.out).to.contain("FAIL  deployment.json recorded another code hash for the vault");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, with a reason, a router that is not there, and a vault the explorer-free reader finds without code or with another router", async () => {
    const none = await run(["--router", OTHER]);
    expect(none.code).to.equal(1);
    expect(none.out).to.contain(`FAIL  there is no contract at the router address ${OTHER} on this chain`);
    const noCode = await run(["--router", w.routerAddress], env(), { rpc: reader((m, p) => (m === "eth_getCode" && String(p[0]).toLowerCase() === w.vaultAddress.toLowerCase() ? "0x" : undefined)).rpc });
    expect(noCode.code).to.equal(1);
    expect(noCode.out).to.contain("FAIL  there is no code at the vault address");
    const routerAnswer = zeroPadValue(OTHER, 32);
    const another = await run(["--router", w.routerAddress], env(), { rpc: reader((m, p) => (m === "eth_call" && String((p[0] as { to: string }).to).toLowerCase() === w.vaultAddress.toLowerCase() ? routerAnswer : undefined)).rpc });
    expect(another.code).to.equal(1);
    expect(another.out).to.contain(`FAIL  the vault's router() is ${OTHER}, not this router`);
    const noVault = await run(["--router", w.routerAddress], env(), { rpc: reader((m, p) => (m === "eth_call" && String((p[0] as { to: string }).to).toLowerCase() === w.routerAddress.toLowerCase() ? new RpcRefused("no") : undefined)).rpc });
    expect(noVault.out).to.contain("FAIL  the router does not answer vault() with an address");
  });

  it("checks against the chain it is told: a testnet check of this chain fails on the chain id", async () => {
    const r = await run(["--router", w.routerAddress], env({ SLUICE_NETWORK: "testnet" }));
    expect(r.code).to.equal(1);
    expect(r.out).to.contain("FAIL  the RPC is on chain 1990, not 1983");
  });

  it("refuses a wrong command, a missing router and uncompiled contracts with exit 2 before it asks the chain, and says when the chain cannot be read", async () => {
    const quiet = reader();
    const cases: Array<[string[], Record<string, string | undefined>, RegExp, { root?: string }?]> = [
      [["--router", w.routerAddress], {}, /set SLUICE_NETWORK to mainnet or testnet/],
      [["--router", w.routerAddress], { SLUICE_NETWORK: "local" }, /set SLUICE_NETWORK to mainnet or testnet/],
      [["--bogus", "x"], env(), /unknown option --bogus/],
      [["--router"], env(), /--router needs a value/],
      [["--router", "0x12"], env(), /--router is not an address/],
      [["--router", w.routerAddress, "--router", w.routerAddress], env(), /--router was given twice/],
      [[], env(), /no router: give --router, set SLUICE_ROUTER, or run this where deployment.json is/],
      [[], env({ SLUICE_ROUTER: "nope" }), /SLUICE_ROUTER is not an address/],
      [["--router", w.routerAddress], env(), /run pnpm compile/, { root: EMPTY }],
    ];
    for (const [argv, environment, message, extra] of cases) {
      const r = await run(argv, environment, { rpc: quiet.rpc, ...extra });
      expect(r.code, argv.join(" ")).to.equal(2);
      expect(r.out).to.match(message);
    }
    expect(quiet.methods, "nothing was asked of the chain").to.deep.equal([]);
    const down = await run(["--router", w.routerAddress], env(), { rpc: async () => { throw new NetworkError("no RPC endpoint could be reached"); } });
    expect(down.code).to.equal(2);
    expect(down.out).to.contain("the chain could not be read, so nothing was checked. A result is never guessed.");
  });

  it("asks only the four read-only methods, holds no key, and has no way to send", async () => {
    const r = reader();
    const result = await run(["--router", w.routerAddress], env({ SLUICE_KEY: `0x${"5d".repeat(32)}`, SLUICE_RELAYER_KEY: `0x${"5d".repeat(32)}` }), { rpc: r.rpc });
    expect(result.code).to.equal(0);
    for (const method of r.methods) expect(VAULTCHECK_READ_ONLY_METHODS.has(method), method).to.equal(true);
    expect(result.out).to.not.contain("5d5d5d5d");
    for (const file of ["src/vaultcheck.ts", "scripts/live/vaultcheck.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).to.not.match(/child_process|sendTransaction|sendRawTransaction|signTransaction|signMessage|new Wallet\(|SLUICE_KEY|SLUICE_RELAYER_KEY|SLUICE_APPROVE|method:\s*"POST"/);
    }
  });
});

describe("Vault check: what may be said about the vault on the explorer", () => {
  const recordText = readFileSync(join(ROOT, VAULT_RECORD_PATH), "utf8");
  const shown = explorerShowsVault(recordText);

  /** Every TypeScript file the programs, the scripts and the web app are made of, comments included. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of safeReaddir(dir)) {
      if (["node_modules", "dist", ".next", "artifacts", "cache", "generated"].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }
  const programFiles = (): string[] => ["src", "scripts", "packages", "examples", "apps/web/src"].flatMap((dir) => sources(join(ROOT, dir)));

  it("says it is verified only with the explorer named and its answer on file, in the sources and comments of the scripts, the libraries and the web app", () => {
    const flagged: string[] = [];
    for (const file of programFiles()) {
      if (file === join(ROOT, "src", "claims.ts")) continue; // the rule itself, whose comments quote the claims it refuses
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        for (const hit of vaultVerifiedClaims(line, shown !== null)) flagged.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${hit}`);
      });
    }
    expect(flagged).to.deep.equal([]);
  });

  /** The ways the pages used to say that the explorer would not take the vault. While the record shows otherwise, each is out of date. */
  const OUT_OF_DATE = /does not list (its|the vault's|an|that) address|not list(ed)? (its address|it) as a contract|vault[^.\n]{0,80}\b(is not|isn't) verified|not verified there|cannot verify the vault|cannot be verified on its page|vault has none to check/i;

  it("leaves no current page or program saying the explorer will not take the vault, while the record shows that it did", () => {
    expect(shown, "the record in the repository").to.not.equal(null);
    // DECISIONS.md is a history: it says what was true when each decision was made.
    const docs = ["README.md", ...safeReaddir(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)].map((f) => join(ROOT, f));
    const stale: string[] = [];
    for (const file of [...docs, ...programFiles()]) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (OUT_OF_DATE.test(line)) stale.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    expect(stale).to.deep.equal([]);
    for (const old of ["The explorer does not list its address as a contract.", "The vault is not verified there.", "The vault has none to check"]) expect(OUT_OF_DATE.test(old), old).to.equal(true);
  });

  it("with the explorer's answer on file, still refuses a sentence that does not name the explorer", () => {
    for (const text of ["The vault is verified.", "Both contracts are verified.", "Verified source for the router and the vault."]) {
      expect(vaultVerifiedClaims(text, true), text).to.not.deep.equal([]);
      expect(vaultVerifiedClaims(text), text).to.not.deep.equal([]);
    }
    for (const text of ["QIE's explorer showed verified source for the vault on 2026-11-26.", "The explorer shows the vault as verified."]) {
      expect(vaultVerifiedClaims(text, true), text).to.deep.equal([]);
      expect(vaultVerifiedClaims(text), `${text} without a record`).to.not.deep.equal([]);
    }
    // Naming the explorer in one sentence does not excuse the next.
    expect(vaultVerifiedClaims("Ask the explorer. The vault is verified.", true)).to.not.deep.equal([]);
  });

  it("reads the record as showing the vault only when every part of it says so", () => {
    expect(shown).to.deep.equal({ vault: "0xC8bfECBF9Dc5d18943b38873705DeeE9D13d751B", readAt: "2026-11-26T06:11:51Z" });
    expect(explorerShowsVault(undefined)).to.equal(null);
    for (const text of ["", "not json", "[]", "null", "{}"]) expect(explorerShowsVault(text), JSON.stringify(text)).to.equal(null);
    type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const changed = (change: (r: Json) => void): unknown => {
      const r = JSON.parse(recordText) as Json;
      change(r);
      return explorerShowsVault(JSON.stringify(r));
    };
    const address = "GET /api/v2/addresses/{vault}";
    const source = "GET /api/v2/smart-contracts/{vault}";
    const breaks: Array<[string, (r: Json) => void]> = [
      ["another explorer", (r) => (r.explorer = "https://example.test")],
      ["another chain", (r) => (r.chainId = 1983)],
      ["no vault", (r) => delete r.vault],
      ["no date", (r) => delete r.readAt],
      ["an answer about another address", (r) => (r[address].hash = OTHER)],
      ["not a contract", (r) => (r[address].is_contract = false)],
      ["address not verified", (r) => (r[address].is_verified = false)],
      ["another name", (r) => (r[address].name = "PaymentRouter")],
      ["source not verified", (r) => (r[source].is_verified = false)],
      ["source under another name", (r) => (r[source].name = "X")],
      ["no address answer", (r) => delete r[address]],
      ["no source answer", (r) => delete r[source]],
    ];
    expect(changed(() => undefined)).to.not.equal(null);
    for (const [name, change] of breaks) expect(changed(change), name).to.equal(null);
  });

  it("holds a record whose code hash is the one the vault check computed, and whose answers agree with the documents", () => {
    const record = JSON.parse(recordText) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const preflight = readFileSync(join(ROOT, "docs", "MAINNET-PREFLIGHT.md"), "utf8");
    const hash = record["GET /api/v2/smart-contracts/{vault}"].deployed_bytecode_keccak256 as string;
    expect(preflight).to.contain(`the hash of the code at the vault, from eth_getCode:      ${hash}`);
    const deployed = parseEvidenceStrict(readFileSync(join(ROOT, "docs", "EVIDENCE.md"), "utf8")).find((r) => r.network === "mainnet" && r.event === "Deployed");
    expect(record.router).to.equal(deployed?.contract);
    const report = readFileSync(join(ROOT, "docs", "EXPLORER-VAULT-INVESTIGATION.md"), "utf8");
    for (const value of [record.vault as string, record.router as string, hash, "v7.0.2", "block 8,819,845", "unsupported_chain"]) expect(report, value).to.contain(value);
    // What the record does not show is said beside it.
    expect(record["GET /api/v2/addresses/{vault}"].creation_transaction_hash).to.equal(null);
    expect(report).to.contain("holds no creator and no creation transaction for the vault");
    expect(report).to.contain("It is not a row of [EVIDENCE.md](EVIDENCE.md)");
  });

  it("holds the two chain registry entries it prepared, for chain 1990 and QIE's five endpoints, and says they were not submitted", () => {
    const json = (path: string): any => JSON.parse(readFileSync(join(ROOT, "docs", "chain-registry", path), "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any
    const rpcs = [1, 2, 3, 4, 5].map((n) => `https://rpc${n}mainnet.qie.digital`);
    const chain = json("ethereum-lists/_data/chains/eip155-1990.json");
    expect(chain).to.deep.include({ chainId: 1990, networkId: 1990, chain: "QIE", shortName: "qie-mainnet", name: "QIE Mainnet" });
    expect(chain.rpc).to.deep.equal(rpcs);
    expect(chain.nativeCurrency).to.deep.equal({ name: "QIE", symbol: "QIE", decimals: 18 });
    expect(chain.explorers).to.deep.equal([{ name: "QIE Explorer", url: "https://mainnet.qie.digital", standard: "EIP3091" }]);
    expect(chain.faucets).to.deep.equal([]);
    const sourcify = json("sourcify-chains/chain-overrides.entry.json");
    expect(Object.keys(sourcify)).to.deep.equal(["1990"]);
    expect(sourcify["1990"].rpc.map((r: { url: string }) => r.url)).to.deep.equal(rpcs);
    for (const r of sourcify["1990"].rpc) expect(r).to.deep.include({ type: "BaseRPC", traceSupport: "debug_traceTransaction" });
    expect(sourcify["1990"].fetchContractCreationTxUsing).to.deep.equal({ blockscoutApi: { url: "https://mainnet.qie.digital/" } });
    const report = readFileSync(join(ROOT, "docs", "EXPLORER-VAULT-INVESTIGATION.md"), "utf8");
    expect(report).to.contain("**have not been submitted**");
    expect(report).to.contain("Nothing has been sent. One issue, ready to paste:");
  });

  it("flags a sentence that says it, however it is put, and leaves a sentence that denies it", () => {
    const bad = [
      "The vault is verified on the explorer.",
      "AgentVault's source is verified.",
      "Verified source for the vault.",
      "Both contracts are verified on the explorer.",
      "The explorer shows verified source for PaymentRouter and AgentVault.",
      "The router and the vault are verified.",
      "Verify the router's and the vault's source on the explorer.",
      "After the explorer verifies the vault, record it.",
      "Verification of both contracts is done.",
    ];
    for (const text of bad) expect(vaultVerifiedClaims(text), text).to.not.deep.equal([]);
    const fine = [
      "The vault is not verified on the explorer.",
      "The explorer does not verify the vault, which the router's constructor creates.",
      "Nothing is submitted for the vault.",
      "The explorer shows verified source for the router. The vault is checked by its code hash.",
      "The explorer refused to verify the vault.",
      "The vault's code hash matches the compiled artifact.",
      "pnpm live:vaultcheck compares the vault's code with the compiled AgentVault.",
    ];
    for (const text of fine) expect(vaultVerifiedClaims(text), text).to.deep.equal([]);
  });
});

describe("Vault check: a build that cannot be read is refused, not guessed at", function () {
  this.timeout(120_000);

  /** A copy of the artifacts of the contracts the check reads, which a test then damages. */
  function copyArtifacts(): string {
    const dir = mkdtempSync(join(tmpdir(), "sluice-vaultcheck-art-"));
    mkdirSync(join(dir, "artifacts", "contracts", "AgentVault.sol"), { recursive: true });
    cpSync(join(ROOT, "artifacts", "contracts", "AgentVault.sol", "AgentVault.json"), join(dir, "artifacts", "contracts", "AgentVault.sol", "AgentVault.json"), { filter: copyable });
    cpSync(join(ROOT, "artifacts", "build-info"), join(dir, "artifacts", "build-info"), { recursive: true, filter: copyable });
    return dir;
  }
  const buildInfoFile = (dir: string): string => join(dir, "artifacts", "build-info", safeReaddir(join(dir, "artifacts", "build-info")).filter((f) => f.endsWith(".json"))[0] as string);

  it("reads a copy of the real artifacts the same way", () => {
    const dir = copyArtifacts();
    try {
      expect(readCompiled(dir).slots).to.deep.equal(readCompiled(ROOT).slots);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an immutable it cannot name, an artifact that disagrees with the build info, and a missing artifact or build info", () => {
    const noTree = copyArtifacts();
    try {
      const info = JSON.parse(readFileSync(buildInfoFile(noTree), "utf8")) as { output: { sources: Record<string, { ast?: unknown }> } };
      for (const source of Object.values(info.output.sources)) delete source.ast;
      writeFileSync(buildInfoFile(noTree), JSON.stringify(info));
      expect(() => readCompiled(noTree)).to.throw(VerifyError, /could not be named from the build info/);
    } finally {
      rmSync(noTree, { recursive: true, force: true });
    }

    const edited = copyArtifacts();
    try {
      const file = join(edited, "artifacts", "contracts", "AgentVault.sol", "AgentVault.json");
      const artifact = JSON.parse(readFileSync(file, "utf8")) as { deployedBytecode: string };
      artifact.deployedBytecode = patch(artifact.deployedBytecode, 100, "ff");
      writeFileSync(file, JSON.stringify(artifact));
      expect(() => readCompiled(edited)).to.throw(VerifyError, /artifact and the build info disagree/);
      rmSync(file);
      expect(existsSync(file)).to.equal(false);
      expect(() => readCompiled(edited)).to.throw(VerifyError, /run pnpm compile first/);
    } finally {
      rmSync(edited, { recursive: true, force: true });
    }
    expect(() => readCompiled(join(tmpdir(), "sluice-vaultcheck-none"))).to.throw(VerifyError, /pnpm compile/);
  });

  it("refuses a build made with other compiler settings, as live:verify does", () => {
    const dir = copyArtifacts();
    try {
      const info = JSON.parse(readFileSync(buildInfoFile(dir), "utf8")) as { input: { settings: { optimizer: { runs: number } } } };
      info.input.settings.optimizer.runs = 1000;
      writeFileSync(buildInfoFile(dir), JSON.stringify(info));
      expect(() => readCompiled(dir)).to.throw(VerifyError, /optimizer settings are not the documented ones/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
