// The go-live plan (pnpm live:golive:plan): the five addresses checked against each other and the chain, and the printed sequence of
// commands checked against the real scripts. Every case runs on a pretend chain that answers the read-only methods and refuses anything
// else, so nothing here touches a network, and nothing here can send.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { AbiCoder, Interface, Wallet, getAddress, hexlify, keccak256, randomBytes, toQuantity, toUtf8Bytes } from "ethers";
import { NetworkError } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import {
  DEFAULT_PAYER_QUSDC,
  GOLIVE_READ_ONLY_METHODS,
  KeyFileError,
  ROLES,
  FLAG,
  addressOfKeyFileText,
  buildSteps,
  checkAddress,
  checkRoles,
  evaluate,
  formatPlan,
} from "../../src/golive-plan";
import type { Facts, Role, Roles } from "../../src/golive-plan";
import { GuardError, QUSDC_ADDRESS, SpendMeter, readCaps, requireApproval } from "../../src/guard";
import { checkDeployRoles, deployPlan, readDeployParams, smokePlan } from "../../src/live";
import { safeReaddir } from "../../src/secret-paths";
import { main } from "../../scripts/live/golive-plan";

const ROOT = join(__dirname, "..", "..");
const coder = AbiCoder.defaultAbiCoder();
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const QIE = 10n ** 18n;

/** A checksummed address made from a name, so each role in a test is its own, and the same one every run. */
const addr = (name: string): string => getAddress(`0x${keccak256(toUtf8Bytes(name)).slice(26)}`);
const D = addr("deployer");
const R = addr("relayer");
const O = addr("owner");
const F = addr("fee recipient");
const P = addr("payer");
const ALL: Roles = { deployer: D, relayer: R, owner: O, feeRecipient: F, payer: P };
const ARGS = ["--owner", O, "--fee-recipient", F, "--payer", P, "--deployer", D, "--relayer", R];
const MAINNET = { SLUICE_NETWORK: "mainnet" };

// ----------------------------------------------------------------------------------------------------------- a pretend chain

type Chain = {
  chainId?: number;
  contracts?: string[];
  qie?: Record<string, bigint>;
  qusdc?: Record<string, bigint>;
  gasPrice?: bigint;
  /** The chain cannot be reached. */
  down?: boolean;
};

/** The funding the founder describes: the deployer holds 0.05 QIE and 0.3 QUSDC, the relayer 0.1 QIE, and the payer has QUSDC and no QIE. */
const FUNDED: Chain = {
  qie: { [D.toLowerCase()]: 5n * 10n ** 16n, [R.toLowerCase()]: 10n ** 17n },
  qusdc: { [D.toLowerCase()]: 300_000n, [P.toLowerCase()]: 300_000n },
};

function fakeChain(chain: Chain = FUNDED): { rpc: Rpc; calls: string[] } {
  const calls: string[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    if (chain.down) throw new NetworkError("no RPC endpoint could be reached");
    switch (method) {
      case "eth_chainId":
        return toQuantity(chain.chainId ?? 1990);
      case "eth_getBlockByNumber":
        return { number: toQuantity(12_100_000), timestamp: toQuantity(1_795_000_000) };
      case "eth_gasPrice":
        return toQuantity(chain.gasPrice ?? 1_125_000_000n);
      case "eth_getBalance":
        return toQuantity(chain.qie?.[String(params[0]).toLowerCase()] ?? 0n);
      case "eth_getCode":
        return chain.contracts?.map((a) => a.toLowerCase()).includes(String(params[0]).toLowerCase()) ? "0x6080604052" : "0x";
      case "eth_call": {
        const call = params[0] as { to: string; data: string };
        expect(getAddress(call.to)).to.equal(getAddress(QUSDC_ADDRESS));
        const [who] = erc20.decodeFunctionData("balanceOf", call.data) as unknown as [string];
        return coder.encode(["uint256"], [chain.qusdc?.[who.toLowerCase()] ?? 0n]);
      }
      default:
        throw new Error(`the plan asked for ${method}, which a read-only plan has no reason to`);
    }
  };
  return { rpc, calls };
}

/**
 * An empty folder to run the command in. The command looks for the key files in the folder it is run from, and the repository's own folder
 * may hold the founder's real ones: a test must never read them, so every run happens somewhere that holds none unless it makes its own.
 */
const EMPTY = mkdtempSync(join(tmpdir(), "sluice-plan-empty-"));

async function run(argv: string[], env: Record<string, string | undefined> = MAINNET, chain: Chain = FUNDED, cwd: string = EMPTY): Promise<{ code: number; out: string; calls: string[] }> {
  const lines: string[] = [];
  const pretend = fakeChain(chain);
  const code = await main(argv, env, { log: (l) => lines.push(l), rpc: pretend.rpc, cwd });
  return { code, out: lines.join("\n"), calls: pretend.calls };
}

const without = (argv: string[], flag: string): string[] => {
  const i = argv.indexOf(flag);
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
};
const replaced = (argv: string[], flag: string, value: string): string[] => argv.map((a, i) => (argv[i - 1] === flag ? value : a));

/** A checksummed address with one letter's case changed, which is what a mistyped character looks like to the checksum. */
function wrongChecksum(address: string): string {
  const body = address.slice(2);
  const i = [...body].findIndex((c) => /[a-fA-F]/.test(c));
  const flipped = body[i] === body[i]?.toUpperCase() ? body[i]?.toLowerCase() : body[i]?.toUpperCase();
  return `0x${body.slice(0, i)}${flipped}${body.slice(i + 1)}`;
}

// ------------------------------------------------------------------------------------------------------------- the addresses

describe("Go-live plan: the addresses", () => {
  it("takes a well-formed, checksummed address and nothing else", () => {
    expect(checkAddress("--owner", O)).to.deep.equal({ address: O });
    expect(checkAddress("--owner", undefined).problem).to.match(/--owner is missing/);
    expect(checkAddress("--owner", "").problem).to.match(/--owner is missing/);
    expect(checkAddress("--owner", "0x1234").problem).to.match(/--owner is not an address/);
    expect(checkAddress("--owner", O.slice(2)).problem).to.match(/--owner is not an address/);
    expect(checkAddress("--owner", `${O}00`).problem).to.match(/--owner is not an address/);
    expect(checkAddress("--owner", `0x${"zz".repeat(20)}`).problem).to.match(/--owner is not an address/);
  });

  it("refuses a wrong mixed-case checksum, and names the option, whichever letter is wrong", () => {
    const body = O.slice(2);
    let tried = 0;
    for (let i = 0; i < body.length; i++) {
      if (!/[a-fA-F]/.test(body[i] as string)) continue;
      const flipped = body[i] === body[i]?.toUpperCase() ? body[i]?.toLowerCase() : body[i]?.toUpperCase();
      const bad = `0x${body.slice(0, i)}${flipped}${body.slice(i + 1)}`;
      const checked = checkAddress("--fee-recipient", bad);
      expect(checked.problem, bad).to.match(/--fee-recipient has a wrong checksum/);
      expect(checked.address).to.equal(undefined);
      tried += 1;
    }
    expect(tried).to.be.greaterThan(5);
  });

  it("refuses an address with no checksum capitals, since a mistyped character would go unnoticed, and does not repeat a corrected form", () => {
    for (const bare of [O.toLowerCase(), `0x${O.slice(2).toUpperCase()}`]) {
      const checked = checkAddress("--owner", bare);
      expect(checked.problem).to.match(/not written with its checksum capitals/);
      expect(checked.problem).to.not.contain(O);
    }
  });

  it("refuses the zero address", () => {
    expect(checkAddress("--payer", `0x${"0".repeat(40)}`).problem).to.match(/--payer is the zero address/);
  });

  it("refuses any two of the five roles being the same address, and names both", () => {
    for (let i = 0; i < ROLES.length; i++) {
      for (let j = i + 1; j < ROLES.length; j++) {
        const a = ROLES[i] as Role;
        const b = ROLES[j] as Role;
        const checked = checkRoles({ ...ALL, [b]: ALL[a] });
        expect(checked.roles, `${a} = ${b}`).to.equal(undefined);
        expect(checked.problems.join("\n"), `${a} = ${b}`).to.contain(`${FLAG[a]} and ${FLAG[b]} are the same address`);
      }
    }
    expect(checkRoles(ALL).problems).to.deep.equal([]);
    expect(checkRoles(ALL).roles).to.deep.equal(ALL);
  });

  it("lists every problem at once, not the nearest one", () => {
    const checked = checkRoles({ deployer: D, relayer: D, owner: "0x12", feeRecipient: undefined, payer: wrongChecksum(P) });
    expect(checked.problems.length).to.equal(4);
    expect(checked.problems.join("\n")).to.match(/--relayer are the same address/);
    expect(checked.problems.join("\n")).to.match(/--owner is not an address/);
    expect(checked.problems.join("\n")).to.match(/--fee-recipient is missing/);
    expect(checked.problems.join("\n")).to.match(/--payer has a wrong checksum/);
  });
});

describe("Go-live plan: the key files are read for an address only", () => {
  it("gives the address a key belongs to, and nothing of the key", () => {
    const wallet = Wallet.createRandom();
    expect(addressOfKeyFileText(`${wallet.privateKey}\r\n`, "deployer-mainnet.key")).to.equal(wallet.address);
  });

  it("describes a file that is not a key by its shape, never by its contents", () => {
    for (const text of ["", "0x1234", `0x${"zz".repeat(32)}`, "my-seed-phrase-words-not-a-key", `${"ab".repeat(32)}`, `0x${"00".repeat(32)}`]) {
      let caught: unknown;
      try {
        addressOfKeyFileText(text, "deployer-mainnet.key");
      } catch (err) {
        caught = err;
      }
      expect(caught, JSON.stringify(text)).to.be.instanceOf(KeyFileError);
      const message = (caught as Error).message;
      expect(message).to.match(/^deployer-mainnet\.key does not hold a (usable )?key/);
      if (text.length > 4) expect(message).to.not.contain(text.trim());
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- the command

describe("Go-live plan: the command", () => {
  after(() => rmSync(EMPTY, { recursive: true, force: true }));

  it("prints the plan for five different plain accounts on chain 1990, from reads alone", async () => {
    const r = await run(ARGS);
    expect(r.code).to.equal(0);
    for (const address of [D, R, O, F, P]) expect(r.out).to.contain(address);
    expect(r.out).to.contain("Go-live plan for mainnet (chain 1990), read from QIE at block 12100000");
    expect(r.out).to.contain("PASS  the RPC is on chain 1990");
    expect(r.out).to.contain("PASS  all five addresses are different, none is the zero address, and none holds a contract");
    expect(r.out).to.contain("Read-only: nothing was sent, signed or run.");
    // Every request it made is a read, and is on the list it may use.
    expect(r.calls.length).to.be.greaterThan(10);
    for (const method of r.calls) expect(GOLIVE_READ_ONLY_METHODS.has(method), method).to.equal(true);
    expect([...GOLIVE_READ_ONLY_METHODS].filter((m) => /send|sign|estimate|submit/i.test(m))).to.deep.equal([]);
  });

  it("states the funded run's warning that the founder expects, and does not turn it into a refusal", async () => {
    const r = await run(ARGS);
    expect(r.out).to.match(/WARN  the relayer holds 0\.1 QIE, below the 0\.5 QIE to hold/);
    expect(r.out).to.contain("lowBalance true");
    expect(r.out).to.match(/WARN  the payer holds 0\.300000 QUSDC|PASS  the payer holds no QIE/);
    expect(r.code).to.equal(0);
  });

  it("requires SLUICE_NETWORK=mainnet, and opens no connection when it is anything else", async () => {
    for (const network of [undefined, "", "testnet", "MAINNET", "local", "mainnet2"]) {
      const r = await run(ARGS, { SLUICE_NETWORK: network });
      expect(r.code, String(network)).to.equal(1);
      expect(r.out).to.match(/refused: set SLUICE_NETWORK to mainnet/);
      expect(r.calls, String(network)).to.deep.equal([]);
      expect(r.out).to.not.contain("pnpm exec ts-node");
    }
  });

  it("refuses a node that is not on chain 1990, and prints no commands", async () => {
    for (const chainId of [1983, 1, 1991]) {
      const r = await run(ARGS, MAINNET, { ...FUNDED, chainId });
      expect(r.code, String(chainId)).to.equal(1);
      expect(r.out).to.contain(`refused: the RPC is on chain ${chainId}, but this plan is for mainnet (chain 1990)`);
      expect(r.out).to.not.contain("pnpm exec ts-node scripts/live/deploy.ts");
      expect(r.out).to.not.contain("$env:SLUICE_APPROVE");
    }
  });

  it("says the chain could not be read, exits 2, and guesses nothing", async () => {
    const r = await run(ARGS, MAINNET, { down: true });
    expect(r.code).to.equal(2);
    expect(r.out).to.contain("the chain could not be read, so no plan was made. A plan is never guessed.");
    expect(r.out).to.not.contain("$env:SLUICE_APPROVE");
  });

  it("refuses duplicate roles before it opens any connection", async () => {
    for (const [flag, copy] of [["--owner", D], ["--fee-recipient", O], ["--payer", O], ["--payer", R], ["--owner", R]] as const) {
      const r = await run(replaced(ARGS, flag, copy));
      expect(r.code, `${flag} = ${copy}`).to.equal(1);
      expect(r.out).to.match(/are the same address/);
      expect(r.calls, `${flag} = ${copy}`).to.deep.equal([]);
    }
  });

  it("refuses a wrong checksum, a short address, a missing role and the zero address before it opens any connection", async () => {
    const cases: Array<[string[], RegExp]> = [
      [replaced(ARGS, "--owner", wrongChecksum(O)), /--owner has a wrong checksum/],
      [replaced(ARGS, "--payer", wrongChecksum(P)), /--payer has a wrong checksum/],
      [replaced(ARGS, "--fee-recipient", F.toLowerCase()), /--fee-recipient is not written with its checksum capitals/],
      [replaced(ARGS, "--owner", "0xabc"), /--owner is not an address/],
      [without(ARGS, "--payer"), /--payer is missing/],
      [replaced(ARGS, "--owner", `0x${"0".repeat(40)}`), /--owner is the zero address/],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).to.equal(1);
      expect(r.out).to.match(message);
      expect(r.calls).to.deep.equal([]);
    }
  });

  it("refuses a contract as the owner, the fee recipient or the payer, names which, and prints no commands", async () => {
    for (const [who, label] of [[O, "the owner"], [F, "the fee recipient"], [P, "the payer"]] as const) {
      const r = await run(ARGS, MAINNET, { ...FUNDED, contracts: [who] });
      expect(r.code, label).to.equal(1);
      expect(r.out).to.contain(`FAIL  ${label} ${who} holds a contract on this chain`);
      expect(r.out).to.contain("NO PLAN");
      expect(r.out).to.not.contain("pnpm exec ts-node scripts/live/deploy.ts");
      expect(r.calls).to.include("eth_getCode");
    }
    // The two key addresses must be accounts too.
    for (const [who, label] of [[D, "the deployer"], [R, "the relayer"]] as const) {
      const r = await run(ARGS, MAINNET, { ...FUNDED, contracts: [who] });
      expect(r.code, label).to.equal(1);
      expect(r.out).to.contain(`FAIL  ${label} ${who} holds a contract on this chain, but it must be an account whose key signs`);
    }
  });

  it("warns, without refusing, when the payer holds QIE, because the start with no QIE would prove nothing", async () => {
    const r = await run(ARGS, MAINNET, { ...FUNDED, qie: { ...FUNDED.qie, [P.toLowerCase()]: QIE / 100n } });
    expect(r.code).to.equal(0);
    expect(r.out).to.match(/WARN  the payer holds 0\.01 QIE\. The zero-QIE start is what this run proves/);
    expect(r.out).to.not.contain("PASS  the payer holds no QIE");
  });

  it("warns when the deployer or the relayer is short, naming the pre-flight check's verdict", async () => {
    const r = await run(ARGS, MAINNET, { qie: { [D.toLowerCase()]: 1000n, [R.toLowerCase()]: 1000n }, qusdc: { [D.toLowerCase()]: 1n } });
    expect(r.code).to.equal(0);
    expect(r.out).to.match(/WARN  the deployer holds 0\.000000000000001 QIE, below the 0\.01\d+ QIE the deploy and the smoke run need at 3x/);
    expect(r.out).to.match(/WARN  the deployer holds 0\.000001 QUSDC, below the 0\.300000 QUSDC the smoke run deposits/);
    expect(r.out).to.match(/WARN  the relayer holds 0\.000000000000001 QIE, below the 0\.0185\d+ QIE floor of the pre-flight check/);
  });

  it("refuses an unknown option, a repeated option, a missing value and a payer amount outside 0 to 100", async () => {
    for (const [argv, message] of [
      [[...ARGS, "--dry-run"], /unknown option --dry-run/],
      [[...ARGS, "--owner", O], /--owner was given twice/],
      [[...ARGS.slice(0, -1)], /--relayer needs a value/],
      [[...ARGS, "--payer-qusdc", "100.000001"], /--payer-qusdc is above 100/],
      [[...ARGS, "--payer-qusdc", "0"], /--payer-qusdc must be above zero/],
      [[...ARGS, "--payer-qusdc", "abc"], /--payer-qusdc must be a plain positive decimal/],
    ] as Array<[string[], RegExp]>) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).to.equal(1);
      expect(r.out).to.match(message);
      expect(r.calls).to.deep.equal([]);
    }
    const ok = await run([...ARGS, "--payer-qusdc", "1"]);
    expect(ok.code).to.equal(0);
    expect(ok.out).to.contain("pnpm client:owner start --amount 1.000000");
  });

  it("reads the deployer's and the relayer's addresses from their key files when they are not given, and never prints a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-plan-"));
    try {
      const deployerKey = Wallet.createRandom();
      const relayerKey = Wallet.createRandom();
      writeFileSync(join(dir, "deployer-mainnet.key"), `${deployerKey.privateKey}\n`);
      writeFileSync(join(dir, "relayer-mainnet.key"), `${relayerKey.privateKey}\n`);
      const sessionKey = hexlify(randomBytes(32));
      const relayerSecret = hexlify(randomBytes(32));
      const env = { ...MAINNET, SLUICE_KEY: sessionKey, SLUICE_RELAYER_KEY: relayerSecret, SLUICE_AGENT_KEY: sessionKey };
      const argv = ["--owner", O, "--fee-recipient", F, "--payer", P];
      const funded: Chain = { qie: { [deployerKey.address.toLowerCase()]: 5n * 10n ** 16n }, qusdc: { [deployerKey.address.toLowerCase()]: 300_000n } };
      const r = await run(argv, env, funded, dir);
      expect(r.code).to.equal(0);
      expect(r.out).to.contain(`pnpm live:preflight --deployer ${deployerKey.address} --relayer ${relayerKey.address}`);
      for (const secret of [deployerKey.privateKey, relayerKey.privateKey, sessionKey, relayerSecret]) {
        expect(r.out).to.not.contain(secret);
        expect(r.out).to.not.contain(secret.slice(2));
      }
      expect(r.out).to.not.match(/0x[0-9a-fA-F]{64}/);
      // A key is only ever read by the lines that name its file, in the commands for the founder to run.
      for (const line of r.out.split("\n").filter((l) => /SLUICE_KEY/.test(l))) {
        if (/\$env:SLUICE_KEY =/.test(line)) expect(line).to.match(/\$env:SLUICE_KEY = \(Get-Content \.\\[a-z-]+-mainnet\.key -Raw\)\.Trim\(\)/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing or a broken key file without printing what is in it, and the options override the files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-plan-"));
    try {
      const garbage = "super-secret-garbage-that-is-not-a-key";
      const argv = ["--owner", O, "--fee-recipient", F, "--payer", P];
      const none = await run(argv, MAINNET, FUNDED, dir);
      expect(none.code).to.equal(1);
      expect(none.out).to.match(/--deployer was not given, and deployer-mainnet\.key could not be read in this folder/);
      expect(none.out).to.match(/--relayer was not given, and relayer-mainnet\.key could not be read in this folder/);
      expect(none.calls).to.deep.equal([]);
      writeFileSync(join(dir, "deployer-mainnet.key"), garbage);
      writeFileSync(join(dir, "relayer-mainnet.key"), `0x${"zz".repeat(32)}`);
      const bad = await run(argv, MAINNET, FUNDED, dir);
      expect(bad.code).to.equal(1);
      expect(bad.out).to.match(/--deployer was not given, and deployer-mainnet\.key does not hold a key/);
      expect(bad.out).to.not.contain(garbage);
      expect(bad.out).to.not.contain("zzzz");
      // A file that does not hold a key is refused even when the address is given, because the file is the one the later steps read.
      const givenBad = await run([...argv, "--deployer", D, "--relayer", R], MAINNET, FUNDED, dir);
      expect(givenBad.code).to.equal(1);
      expect(givenBad.out).to.match(/^refused: deployer-mainnet\.key does not hold a key/m);
      expect(givenBad.out).to.not.contain(garbage);
      rmSync(join(dir, "deployer-mainnet.key"));
      rmSync(join(dir, "relayer-mainnet.key"));
      // With no file at all, the addresses given are used as they are.
      const given = await run([...argv, "--deployer", D, "--relayer", R], MAINNET, FUNDED, dir);
      expect(given.code).to.equal(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks each key file that is there against the address given for it, so the pre-flight check cannot say GO about the wrong account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sluice-plan-"));
    try {
      const deployerKey = Wallet.createRandom();
      const relayerKey = Wallet.createRandom();
      const payerKey = Wallet.createRandom();
      writeFileSync(join(dir, "deployer-mainnet.key"), deployerKey.privateKey);
      writeFileSync(join(dir, "relayer-mainnet.key"), relayerKey.privateKey);
      writeFileSync(join(dir, "payer-mainnet.key"), payerKey.privateKey);
      const base = ["--owner", O, "--fee-recipient", F];
      // Everything matches: the options and the files agree.
      const agree = await run([...base, "--deployer", deployerKey.address, "--relayer", relayerKey.address, "--payer", payerKey.address], MAINNET, FUNDED, dir);
      expect(agree.code).to.equal(0);
      // Each address in turn is the wrong one.
      const cases: Array<[string[], RegExp]> = [
        [[...base, "--deployer", D, "--relayer", relayerKey.address, "--payer", payerKey.address], /deployer-mainnet\.key belongs to a different address than --deployer/],
        [[...base, "--deployer", deployerKey.address, "--relayer", R, "--payer", payerKey.address], /relayer-mainnet\.key belongs to a different address than --relayer/],
        [[...base, "--deployer", deployerKey.address, "--relayer", relayerKey.address, "--payer", P], /payer-mainnet\.key belongs to a different address than --payer/],
      ];
      for (const [argv, message] of cases) {
        const r = await run(argv, MAINNET, FUNDED, dir);
        expect(r.code).to.equal(1);
        expect(r.out).to.match(message);
        expect(r.calls).to.deep.equal([]);
        for (const key of [deployerKey.privateKey, relayerKey.privateKey, payerKey.privateKey]) expect(r.out).to.not.contain(key.slice(2));
      }
      // The payer is never taken from a file: it must be named.
      const noPayer = await run([...base, "--deployer", deployerKey.address, "--relayer", relayerKey.address], MAINNET, FUNDED, dir);
      expect(noPayer.code).to.equal(1);
      expect(noPayer.out).to.match(/--payer is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds no key in any message, whatever it refuses", async () => {
    const secret = hexlify(randomBytes(32));
    const env = { ...MAINNET, SLUICE_KEY: secret, SLUICE_RELAYER_KEY: secret };
    const outputs: string[] = [];
    for (const [argv, chain] of [
      [ARGS, FUNDED],
      [replaced(ARGS, "--owner", D), FUNDED],
      [replaced(ARGS, "--owner", wrongChecksum(O)), FUNDED],
      [ARGS, { ...FUNDED, contracts: [P] }],
      [ARGS, { ...FUNDED, chainId: 1983 }],
      [ARGS, { down: true }],
      [[...ARGS, "--bogus"], FUNDED],
    ] as Array<[string[], Chain]>) {
      outputs.push((await run(argv, env, chain)).out);
    }
    for (const text of outputs) {
      expect(text).to.not.contain(secret);
      expect(text).to.not.contain(secret.slice(2));
      expect(text).to.not.match(/0x[0-9a-fA-F]{64}/);
    }
  });

  it("does not run any command it prints: neither module can start a process", () => {
    for (const file of ["src/golive-plan.ts", "scripts/live/golive-plan.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).to.not.match(/child_process|\bspawn\(|\bexecSync\(|\bexec\(|execFile/);
      expect(source, file).to.not.match(/sendTransaction|sendRawTransaction|signTransaction|signMessage|new Contract\(/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- the sequence

type Script = Record<string, string>;
const packageScripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Script;

/** The text of every source file in the folders the scripts' options and settings are spelled in. */
function sourceText(): string {
  let text = "";
  const walk = (dir: string): void => {
    for (const name of safeReaddir(dir)) {
      if (["node_modules", "dist", ".next", "artifacts", "cache"].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|json)$/.test(name) && !/package-lock|tsconfig/.test(name)) text += `\n${readFileSync(full, "utf8")}`;
    }
  };
  for (const dir of ["src", "scripts", "packages", "examples"]) walk(join(ROOT, dir));
  return text;
}

/** Applies the `$env:NAME = "value"` assignments of a PowerShell line to an environment, reading a key file from the keys given. */
function assign(line: string, env: Record<string, string | undefined>, keys: Record<string, string>): void {
  for (const part of line.split(";")) {
    const plain = /^\s*\$env:(\w+)\s*=\s*"([^"]*)"\s*$/.exec(part);
    if (plain) env[plain[1] as string] = plain[2];
    const file = /^\s*\$env:(\w+)\s*=\s*\(Get-Content \.\\([\w.-]+) -Raw\)\.Trim\(\)\s*$/.exec(part);
    if (file) env[file[1] as string] = keys[file[2] as string];
  }
}

describe("Go-live plan: the sequence of commands", () => {
  const steps = buildSteps(ALL, { gasPrice: 1_125_000_000n, payerQusdc: DEFAULT_PAYER_QUSDC });
  const commands = steps.flatMap((s) => s.commands);

  it("covers the whole real sequence, in an order that cannot send before it has checked", () => {
    const at = (needle: string): number => commands.findIndex((c) => c.includes(needle));
    const order = [
      "pnpm live:facts",
      "pnpm live:preflight --deployer",
      "scripts/live/deploy.ts --dry-run",
      "pnpm exec ts-node scripts/live/deploy.ts",
      "pnpm evidence:record --claim deploy",
      "pnpm live:wire --network mainnet",
      "--deployment deployment.json",
      "pnpm live:verify --prepare-only",
      "pnpm live:verify --check-only",
      "pnpm live:vaultcheck",
      "scripts/live/smoke.ts --dry-run",
      "pnpm exec ts-node scripts/live/smoke.ts",
      "--claim deposit",
      "Invoke-RestMethod \"$env:SLUICE_FACILITATOR_URL/health\"",
      "pnpm client:owner start",
      "--claim relayed-start",
      "pnpm evidence:check",
    ];
    const positions = order.map((needle) => at(needle));
    positions.forEach((p, i) => expect(p, order[i]).to.be.greaterThan(-1));
    // Each is later than the one before it, except the real deploy, which is the first command that is exactly the deploy.
    const realDeploy = commands.indexOf("pnpm exec ts-node scripts/live/deploy.ts");
    const realSmoke = commands.indexOf("pnpm exec ts-node scripts/live/smoke.ts");
    expect(at("pnpm live:preflight --deployer")).to.be.lessThan(at("scripts/live/deploy.ts --dry-run"));
    expect(at("scripts/live/deploy.ts --dry-run")).to.be.lessThan(realDeploy);
    expect(realDeploy).to.be.lessThan(at("pnpm live:wire --network mainnet"));
    expect(at("pnpm live:wire --network mainnet")).to.be.lessThan(at("--deployment deployment.json"));
    // The vault's code is compared with the compiled one after the router is deployed and wired, and before anything is spent on the smoke run.
    expect(at("pnpm live:vaultcheck")).to.be.greaterThan(realDeploy);
    expect(at("pnpm live:vaultcheck")).to.be.greaterThan(at("--deployment deployment.json"));
    expect(at("pnpm live:vaultcheck")).to.be.lessThan(realSmoke);
    expect(at("scripts/live/smoke.ts --dry-run")).to.be.lessThan(realSmoke);
    expect(at("--deployment deployment.json")).to.be.lessThan(realSmoke);
    expect(realSmoke).to.be.lessThan(at("pnpm client:owner start"));
    expect(at("pnpm client:owner start")).to.be.lessThan(at("--claim relayed-start"));
  });

  it("says, in one line each, what every step spends, whether it can be undone and which caps it runs under", () => {
    expect(steps.length).to.be.greaterThan(15);
    steps.forEach((s, i) => {
      expect(s.n).to.equal(i + 1);
      for (const field of ["title", "spends", "reversible", "caps", "expect"] as const) {
        expect(s[field], `step ${s.n} ${field}`).to.be.a("string").and.not.equal("");
        expect(s[field], `step ${s.n} ${field}`).to.not.contain("\n");
      }
    });
    // The steps that send state the caps by name.
    for (const needle of ["scripts/live/deploy.ts", "scripts/live/smoke.ts", "pnpm client:owner start"]) {
      const step = steps.find((s) => s.commands.some((c) => c.includes(needle) && !c.includes("--dry-run") && !c.includes("evidence")));
      expect(step, needle).to.not.equal(undefined);
      expect(step?.caps).to.contain("SLUICE_MAX_QUSDC=").and.contain("SLUICE_MAX_QIE=");
    }
    expect(steps.find((s) => s.title.startsWith("Deploy the router"))?.reversible).to.match(/^no: a deployed router stays on the chain; a redeploy costs the same again \(about 3,158,652 gas\)/);
  });

  it("asks the explorer about the router only, and checks the vault's code another way, in the plan's own words", () => {
    const text = steps.map((s) => `${s.title} ${s.expect} ${s.commands.join(" ")}`).join("\n");
    expect(steps.find((s) => s.title.startsWith("Submit the router's source"))?.expect).to.contain("this command submits nothing for the vault");
    expect(steps.find((s) => s.title.startsWith("Check what the explorer shows for the router"))?.expect).to.contain("the row says nothing about the vault");
    expect(steps.find((s) => s.title.startsWith("Compare the vault's code"))?.commands).to.deep.equal(["pnpm live:vaultcheck"]);
    expect(steps.find((s) => s.title.startsWith("Compare the vault's code"))?.spends).to.contain("read-only");
    expect(text).to.not.match(/both contracts/i);
    expect(text).to.not.contain("and the same for AgentVault");
  });

  it("uses the safe fee, 100 basis points, with the contract's ceiling of 200 stated, and the owner, fee recipient and relayer as given", () => {
    const text = commands.join("\n");
    expect(text).to.contain(`$env:SLUICE_FEE_BPS = "100"`);
    expect(text).to.contain(`$env:SLUICE_OWNER = "${O}"`);
    expect(text).to.contain(`$env:SLUICE_FEE_RECIPIENT = "${F}"`);
    expect(text).to.contain(`$env:SLUICE_RELAYER = "${R}"`);
    expect(steps.find((s) => s.title.startsWith("Set the deploy settings"))?.expect).to.contain("the contract refuses more than 200");
  });

  it("sets caps the scripts accept, that are the smallest they accept, and that stop one transaction costing more than the budget allows", () => {
    const deployerKey = hexlify(randomBytes(32));
    const payerKey = hexlify(randomBytes(32));
    const keys = { "deployer-mainnet.key": deployerKey, "payer-mainnet.key": payerKey };
    const env: Record<string, string | undefined> = {};
    const price = 1_125_000_000n;
    const stepOf = (title: string) => steps.find((s) => s.title.startsWith(title)) as (typeof steps)[number];

    // The deploy: its own approval, its own roles check and its own parameters accept what the plan sets, and one unit less is refused.
    for (const line of [...stepOf("Choose the network").commands, ...stepOf("Set the deploy settings").commands]) assign(line, env, keys);
    expect(env.SLUICE_NETWORK).to.equal("mainnet");
    const params = readDeployParams(env, "mainnet");
    expect(params).to.include({ owner: O, feeRecipient: F, feeBps: 100 });
    expect(() => checkDeployRoles(params, { deployer: D, relayer: env.SLUICE_RELAYER }, "mainnet")).to.not.throw();
    expect(() => requireApproval("deploy", env, deployPlan())).to.not.throw();
    expect(() => requireApproval("deploy", { ...env, SLUICE_MAX_QIE: "0.199999" }, deployPlan())).to.throw(GuardError, /above the cap/);
    const deployMeter = new SpendMeter(readCaps(env));
    deployMeter.beforeSend(3_800_000n, price); // the deploy's real gas limit at today's price
    expect(() => new SpendMeter(readCaps(env)).beforeSend(3_800_000n, 5_000_000_000n)).to.throw(GuardError, /for a single transaction/);

    // The smoke run, the same way: the QUSDC cap is the deposit, and a unit less is refused.
    for (const line of stepOf("Set the smoke run").commands) assign(line, env, keys);
    expect(() => requireApproval("smoke", env, smokePlan())).to.not.throw();
    expect(() => requireApproval("smoke", { ...env, SLUICE_MAX_QUSDC: "0.299999" }, smokePlan())).to.throw(GuardError, /above the cap/);
    expect(() => requireApproval("smoke", { ...env, SLUICE_MAX_QIE: "0.399999" }, smokePlan())).to.throw(GuardError, /above the cap/);
    expect(() => new SpendMeter(readCaps(env)).beforeSend(1_000_000n, price)).to.not.throw();
    expect(() => new SpendMeter(readCaps(env)).beforeSend(1_000_000n, 5_000_000_000n)).to.throw(GuardError, /for a single transaction/);

    // The payer's start: the amount is the QUSDC cap, the payer's own QIE cap is the smallest there is, and the key is the payer's.
    for (const line of stepOf("The payer starts with no QIE").commands) assign(line, env, keys);
    expect(env.SLUICE_KEY).to.equal(payerKey);
    const amount = DEFAULT_PAYER_QUSDC;
    const plan = { qusdc: amount, qieWei: 0n, summary: "start" };
    expect(() => requireApproval("owner-setup", env, plan)).to.not.throw();
    expect(() => requireApproval("owner-setup", env, { ...plan, qusdc: amount + 1n })).to.throw(GuardError, /above the cap/);
    expect(stepOf("The payer starts with no QIE").commands.join("\n")).to.contain("pnpm client:owner start --amount 0.300000");
    // Every cap is far under the scripts' own ceilings.
    expect(() => readCaps({ ...env })).to.not.throw();
  });

  it("names only commands, options and settings that exist in this repository", () => {
    const text = sourceText();
    const known = new Set(Object.keys(packageScripts));
    for (const command of commands) {
      for (const part of command.split(";")) {
        const line = part.trim();
        const pnpm = /^pnpm (?!exec)([\w:.-]+)(.*)$/.exec(line);
        const exec = /^pnpm exec ts-node (scripts\/[\w/.-]+\.ts)(.*)$/.exec(line);
        let file: string | undefined;
        let rest = "";
        if (pnpm) {
          expect(known.has(pnpm[1] as string), `package.json has the script ${pnpm[1]}`).to.equal(true);
          file = /(scripts\/[\w/.-]+\.ts)/.exec(packageScripts[pnpm[1] as string] ?? "")?.[1];
          rest = pnpm[2] ?? "";
        } else if (exec) {
          file = exec[1];
          rest = exec[2] ?? "";
        }
        if (file) {
          const source = readFileSync(join(ROOT, file), "utf8");
          expect(source.length, `${file} exists`).to.be.greaterThan(100);
          for (const flag of rest.match(/--[a-z][a-z-]*/g) ?? []) {
            expect(source.includes(`"${flag}"`) || source.includes(`'${flag}'`) || text.includes(`"${flag}"`) || source.includes(flag), `${file} reads ${flag}`).to.equal(true);
          }
        }
        // Every setting the plan assigns is read somewhere in the code.
        const setting = /^\$env:(SLUICE_\w+) =/.exec(line);
        if (setting) expect(text.includes(setting[1] as string), `${setting[1]} is read by the code`).to.equal(true);
      }
    }
  });

  it("writes PowerShell 5 that can be pasted: no && or ||, one line per command, and no line that prints a key", () => {
    for (const command of commands) {
      expect(command, command).to.not.match(/&&|\|\|/);
      expect(command, command).to.not.contain("\n");
      expect(command, command).to.not.match(/Write-Host|Write-Output|\becho\b|Out-File|Set-Content|Add-Content|Tee-Object/);
    }
    // The only mentions of the key are reading it from its file into the session, and clearing it.
    for (const command of commands.filter((c) => /SLUICE_KEY/.test(c))) {
      expect(command).to.match(/\$env:SLUICE_KEY = \(Get-Content \.\\[a-z-]+-mainnet\.key -Raw\)\.Trim\(\)|Remove-Item Env:SLUICE_KEY/);
    }
    expect(commands.join("\n")).to.not.match(/0x[0-9a-fA-F]{64}/);
  });

  it("changes the commands with the addresses, so none is a fixed example", () => {
    const other = buildSteps({ deployer: addr("d2"), relayer: addr("r2"), owner: addr("o2"), feeRecipient: addr("f2"), payer: addr("p2") }, { gasPrice: 1_125_000_000n, payerQusdc: DEFAULT_PAYER_QUSDC });
    const text = other.flatMap((s) => s.commands).join("\n");
    for (const old of [D, R, O, F, P]) expect(text).to.not.contain(old);
    for (const name of ["d2", "r2", "o2", "f2"]) expect(text).to.contain(addr(name));
  });

  it("scales the cap on one transaction with the gas price, and never above the run's own cap", () => {
    const cheap = buildSteps(ALL, { gasPrice: 1_125_000_000n, payerQusdc: DEFAULT_PAYER_QUSDC });
    const dear = buildSteps(ALL, { gasPrice: 30_000_000_000n, payerQusdc: DEFAULT_PAYER_QUSDC });
    const txCap = (list: typeof cheap): string => /SLUICE_MAX_TX_QIE = "([\d.]+)"/.exec(list.flatMap((s) => s.commands).join("\n"))?.[1] ?? "";
    expect(txCap(cheap)).to.equal("0.013500");
    expect(Number(txCap(dear))).to.be.greaterThan(Number(txCap(cheap)));
    expect(Number(txCap(dear))).to.be.at.most(0.2); // the deploy's QIE cap: SLUICE_MAX_TX_QIE above SLUICE_MAX_QIE would be refused
  });

  it("prints the whole plan as text with a place for every field, and the health check's expected warning", () => {
    const facts: Facts = {
      chainId: 1990, block: 1, timestamp: 1_795_000_000, gasPrice: 1_125_000_000n,
      holdings: Object.fromEntries(ROLES.map((r) => [r, { qieWei: 0n, qusdc: 0n, isContract: false }])) as Facts["holdings"],
    };
    const text = formatPlan(ALL, facts, evaluate(ALL, facts)).join("\n");
    expect(text.match(/^Step \d+ of \d+:/gm)?.length).to.equal(steps.length);
    expect(text.match(/^  spends: /gm)?.length).to.equal(steps.length);
    expect(text.match(/^  reversible: /gm)?.length).to.equal(steps.length);
    expect(text.match(/^  caps: /gm)?.length).to.equal(steps.length);
    expect(text).to.contain("lowBalance true is expected while the relayer holds less than 0.5 QIE");
    expect(text).to.contain("https://mainnet.qie.digital/");
  });
});
