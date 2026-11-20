// The spend guard and the two live scripts that sit behind it.
//
// Nothing here talks to a network or holds a real key. The scripts' main() functions are called in-process
// with injected environments; every one of those either lacks something the guard needs, or is refused by the
// guard before any connection is opened, so none of them can reach a node or send anything.
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import { expect } from "chai";
import { main as deployMain } from "../../scripts/live/deploy";
import { main as smokeMain } from "../../scripts/live/smoke";
import {
  CEILING_QIE_WEI,
  CEILING_QUSDC,
  DEFAULT_MAX_QIE_WEI,
  DEFAULT_MAX_QUSDC,
  formatQie,
  GuardError,
  MAX_GAS_PRICE_WEI,
  parseAmount,
  QUSDC_ADDRESS,
  readCaps,
  redact,
  requireApproval,
  SpendMeter,
} from "../../src/guard";
import type { Plan } from "../../src/guard";
import { deployPlan, SMOKE_TX_COUNT, smokePlan } from "../../src/live";

/** Not a real key: a syntactically valid string used only to check that it is never printed. */
const KEY = `0x${"ab".repeat(32)}`;
const base = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: KEY };
const small: Plan = { qusdc: 1_000_000n, qieWei: 10n ** 17n, summary: "test" };

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).to.be.instanceOf(GuardError);
    return (error as Error).message;
  }
  throw new Error("expected the guard to refuse");
}
async function refusalAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).to.be.instanceOf(GuardError);
    return (error as Error).message;
  }
  throw new Error("expected the guard to refuse");
}

describe("Guard: amounts and caps", () => {
  it("parses plain positive decimals to base units", () => {
    expect(parseAmount("10", 6, "x")).to.equal(10_000_000n);
    expect(parseAmount("0.5", 6, "x")).to.equal(500_000n);
    expect(parseAmount("0.000001", 6, "x")).to.equal(1n);
    expect(parseAmount("5", 18, "x")).to.equal(5n * 10n ** 18n);
    expect(parseAmount(" 2.25 ", 18, "x")).to.equal(2_250_000_000_000_000_000n);
  });

  it("refuses zero, negatives, signs, hex, exponents, commas, too many places and words", () => {
    for (const bad of ["0", "0.0", "-1", "+1", "0x10", "1e3", "1,5", "1.0000001", "ten", "", ".5", "1."]) {
      expect(() => parseAmount(bad, 6, "SLUICE_MAX_QUSDC"), JSON.stringify(bad)).to.throw(GuardError);
    }
  });

  it("defaults to 10 QUSDC and 5 QIE per script", () => {
    expect(DEFAULT_MAX_QUSDC).to.equal(10_000_000n);
    expect(DEFAULT_MAX_QIE_WEI).to.equal(5n * 10n ** 18n);
    expect(readCaps({})).to.deep.equal({ maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n });
    expect(readCaps({ SLUICE_MAX_QUSDC: "", SLUICE_MAX_QIE: "  " })).to.deep.equal(readCaps({}));
  });

  it("takes lower or equal caps from the environment", () => {
    expect(readCaps({ SLUICE_MAX_QUSDC: "1.5", SLUICE_MAX_QIE: "0.25" })).to.deep.equal({
      maxQusdc: 1_500_000n,
      maxQieWei: 250_000_000_000_000_000n,
    });
  });

  it("refuses a cap above the hard ceiling of 100 QUSDC or 50 QIE, and accepts the ceiling itself", () => {
    expect(readCaps({ SLUICE_MAX_QUSDC: "100", SLUICE_MAX_QIE: "50" })).to.deep.equal({
      maxQusdc: CEILING_QUSDC,
      maxQieWei: CEILING_QIE_WEI,
    });
    expect(refusal(() => readCaps({ SLUICE_MAX_QUSDC: "100.000001" }))).to.match(/above the hard ceiling of 100\.000000 QUSDC/);
    expect(refusal(() => readCaps({ SLUICE_MAX_QIE: "50.000000000000000001" }))).to.match(/above the hard ceiling of 50 QIE/);
    expect(refusal(() => readCaps({ SLUICE_MAX_QUSDC: "1000000" }))).to.match(/ceiling/);
  });

  it("formats QIE without trailing zeros", () => {
    expect(formatQie(5n * 10n ** 18n)).to.equal("5");
    expect(formatQie(1_125_000_000n)).to.equal("0.000000001125");
    expect(formatQie(0n)).to.equal("0");
  });
});

describe("Guard: requireApproval", () => {
  it("approves a script only when every condition holds, and returns what it needs", () => {
    const approval = requireApproval("deploy", base, small);
    expect(approval.script).to.equal("deploy");
    expect(approval.network).to.equal("mainnet");
    expect(approval.chainId).to.equal(1990);
    expect(approval.rpcUrl).to.equal("https://rpc1mainnet.qie.digital/");
    expect(approval.caps).to.deep.equal({ maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n });
    expect(approval.privateKey()).to.equal(KEY);
    expect(requireApproval("deploy", { ...base, SLUICE_NETWORK: "testnet" }, small).chainId).to.equal(1983);
    expect(requireApproval("deploy", { ...base, SLUICE_NETWORK: "testnet" }, small).rpcUrl).to.equal("https://rpc1testnet.qie.digital/");
  });

  it("refuses when the network is not chosen, or is anything but mainnet or testnet", () => {
    for (const network of [undefined, "", "Mainnet", "main", "local", "hardhat", "1990"]) {
      const message = refusal(() => requireApproval("deploy", { ...base, SLUICE_NETWORK: network }, small));
      expect(message).to.contain("SLUICE_NETWORK");
    }
  });

  it("refuses without the approval variable", () => {
    expect(refusal(() => requireApproval("deploy", { ...base, SLUICE_APPROVE: undefined }, small))).to.contain("SLUICE_APPROVE=deploy");
    expect(refusal(() => requireApproval("deploy", { ...base, SLUICE_APPROVE: "" }, small))).to.contain("SLUICE_APPROVE=deploy");
  });

  it("refuses an approval meant for another script, a partial name, a different case, or yes/1/true", () => {
    for (const approved of ["smoke", "dep", "deploy2", "Deploy", "yes", "1", "true", "all"]) {
      const message = refusal(() => requireApproval("deploy", { ...base, SLUICE_APPROVE: approved }, small));
      expect(message, approved).to.contain(`approves "${approved}", not "deploy"`);
    }
    // A value that does not look like a script name is refused without being repeated back.
    for (const approved of ["*", "deploy,smoke", "deploy smoke", "x".repeat(25), KEY]) {
      const message = refusal(() => requireApproval("deploy", { ...base, SLUICE_APPROVE: approved }, small));
      expect(message, approved).to.contain('does not approve "deploy"');
      expect(message).to.not.contain(approved);
    }
    expect(requireApproval("smoke", { ...base, SLUICE_APPROVE: "smoke" }, small).script).to.equal("smoke");
  });

  it("refuses a plan that could move more QUSDC than the cap, by even one unit", () => {
    const cap = { ...base, SLUICE_MAX_QUSDC: "2" };
    expect(requireApproval("deploy", cap, { ...small, qusdc: 2_000_000n }).caps.maxQusdc).to.equal(2_000_000n);
    expect(refusal(() => requireApproval("deploy", cap, { ...small, qusdc: 2_000_001n }))).to.match(
      /may move 2\.000001 QUSDC, above the cap of 2\.000000/,
    );
  });

  it("refuses a plan that could spend more QIE on gas than the cap", () => {
    const cap = { ...base, SLUICE_MAX_QIE: "0.1" };
    expect(requireApproval("deploy", cap, { ...small, qieWei: 10n ** 17n }).caps.maxQieWei).to.equal(10n ** 17n);
    expect(refusal(() => requireApproval("deploy", cap, { ...small, qieWei: 10n ** 17n + 1n }))).to.match(/above the cap of 0\.1/);
  });

  it("uses the default caps when none are set, so a plan above 10 QUSDC or 5 QIE is refused", () => {
    expect(refusal(() => requireApproval("deploy", base, { ...small, qusdc: 10_000_001n }))).to.match(/above the cap of 10\.000000/);
    expect(refusal(() => requireApproval("deploy", base, { ...small, qieWei: 5n * 10n ** 18n + 1n }))).to.match(/above the cap of 5/);
  });

  it("refuses a missing or malformed key without saying what was wrong with it", () => {
    for (const key of [undefined, "", "abc", "0x1234", `0x${"zz".repeat(32)}`, `0x${"ab".repeat(33)}`, "ab".repeat(32)]) {
      const message = refusal(() => requireApproval("deploy", { ...base, SLUICE_KEY: key }, small));
      expect(message).to.contain("SLUICE_KEY");
      if (key) expect(message).to.not.contain(key);
    }
  });

  it("refuses an RPC that is not https, except on this machine", () => {
    expect(refusal(() => requireApproval("deploy", { ...base, SLUICE_RPC_URL: "http://rpc.example.org" }, small))).to.contain("https");
    expect(refusal(() => requireApproval("deploy", { ...base, SLUICE_RPC_URL: "ws://rpc.example.org" }, small))).to.contain("https");
    expect(refusal(() => requireApproval("deploy", { ...base, SLUICE_RPC_URL: "http://127.0.0.1.evil.example" }, small))).to.contain("https");
    expect(requireApproval("deploy", { ...base, SLUICE_RPC_URL: "https://rpc.example.org" }, small).rpcUrl).to.equal("https://rpc.example.org");
    expect(requireApproval("deploy", { ...base, SLUICE_RPC_URL: "http://127.0.0.1:8545" }, small).rpcUrl).to.equal("http://127.0.0.1:8545");
  });

  it("never puts the key in a refusal, whichever check fails", () => {
    const cases: Array<Record<string, string | undefined>> = [
      { ...base, SLUICE_NETWORK: "x" },
      { ...base, SLUICE_APPROVE: undefined },
      { ...base, SLUICE_APPROVE: KEY },
      { ...base, SLUICE_MAX_QUSDC: "1000" },
      { ...base, SLUICE_RPC_URL: "http://example.org" },
    ];
    for (const env of cases) {
      const message = refusal(() => requireApproval("deploy", env, { ...small, qusdc: 0n }));
      expect(message).to.not.contain(KEY);
      expect(message).to.not.contain(KEY.slice(2));
    }
  });

  it("hides the key from JSON, console output and string conversion of the approval", () => {
    const approval = requireApproval("deploy", base, small);
    const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    for (const shown of [json(approval), inspect(approval, { depth: 5, showHidden: false }), String(approval), json({ approval })]) {
      expect(shown).to.not.contain(KEY.slice(2));
    }
    expect(json(approval)).to.contain('"script":"deploy"'); // it does print the rest
    expect(Object.keys(approval)).to.not.include("privateKey");
  });

  it("redacts the key, with or without 0x, from any text", () => {
    const env = { SLUICE_KEY: KEY };
    expect(redact(`failed with ${KEY} here`, env)).to.equal("failed with [redacted] here");
    expect(redact(`bare ${KEY.slice(2)} form`, env)).to.equal("bare [redacted] form");
    expect(redact(`${KEY}${KEY}`, env)).to.equal("[redacted][redacted]");
    expect(redact("nothing to hide", env)).to.equal("nothing to hide");
    expect(redact("no key set", {})).to.equal("no key set");
  });
});

describe("Guard: the spend meter", () => {
  const caps = { maxQusdc: 1_000_000n, maxQieWei: 10n ** 17n };

  it("stops QUSDC that would pass the cap, counting what already moved", () => {
    const meter = new SpendMeter(caps);
    meter.beforeQusdc(600_000n);
    meter.beforeQusdc(400_000n);
    expect(meter.movedQusdc).to.equal(1_000_000n);
    expect(refusal(() => meter.beforeQusdc(1n))).to.match(/would pass the cap/);
    expect(meter.movedQusdc, "a refused amount is not counted").to.equal(1_000_000n);
    expect(refusal(() => new SpendMeter(caps).beforeQusdc(0n))).to.match(/above zero/);
  });

  it("reserves worst-case gas before each send and refuses one that could pass the QIE cap", () => {
    const meter = new SpendMeter(caps);
    const price = 1_125_000_000n;
    meter.beforeSend(40_000_000n, price); // 0.045 QIE reserved
    meter.beforeSend(40_000_000n, price); // 0.09 QIE reserved
    expect(refusal(() => meter.beforeSend(10_000_000n, price))).to.match(/could pass the cap of 0\.1 QIE/);
  });

  it("replaces a reservation with the real cost once mined, and the real cost counts against the cap", () => {
    const meter = new SpendMeter(caps);
    const price = 1_125_000_000n;
    meter.beforeSend(40_000_000n, price);
    meter.afterSend(40_000_000n, price, 100_000n, price);
    expect(meter.spentQie).to.equal(100_000n * price);
    meter.beforeSend(80_000_000n, price); // 0.09 + 0.0001125 spent: fits
    expect(refusal(() => meter.beforeSend(10_000_000n, price))).to.match(/could pass the cap/);
  });

  it("keeps the reservation when a send fails, because the transaction may still have been broadcast", () => {
    const meter = new SpendMeter(caps);
    const price = 1_125_000_000n;
    meter.beforeSend(80_000_000n, price); // 0.09 QIE reserved, then the send "fails": no afterSend
    expect(refusal(() => meter.beforeSend(20_000_000n, price))).to.match(/could pass the cap/);
  });

  it("refuses to send at all when the gas price is above 50 gwei", () => {
    expect(MAX_GAS_PRICE_WEI).to.equal(50_000_000_000n);
    const meter = new SpendMeter({ maxQusdc: 1n, maxQieWei: 10n ** 21n });
    meter.beforeSend(1n, MAX_GAS_PRICE_WEI);
    expect(refusal(() => meter.beforeSend(1n, MAX_GAS_PRICE_WEI + 1n))).to.match(/gas price is above 50 gwei/);
  });
});

describe("Guard: what each live script may spend at worst", () => {
  it("fits the deploy plan inside the default caps with room to spare, and moves no QUSDC", () => {
    const plan = deployPlan();
    expect(plan.qusdc).to.equal(0n);
    expect(plan.qieWei).to.equal(4_000_000n * MAX_GAS_PRICE_WEI);
    expect(plan.qieWei).to.be.lessThan(DEFAULT_MAX_QIE_WEI);
  });

  it("fits the smoke plan inside the default caps, and moves at most 0.3 QUSDC", () => {
    const plan = smokePlan();
    expect(plan.qusdc).to.equal(300_000n);
    expect(plan.qieWei).to.equal(SMOKE_TX_COUNT * 1_000_000n * MAX_GAS_PRICE_WEI);
    expect(plan.qusdc).to.be.lessThan(DEFAULT_MAX_QUSDC);
    expect(plan.qieWei).to.be.lessThan(DEFAULT_MAX_QIE_WEI);
  });

  it("refuses inconsistent smoke amounts", () => {
    const ok = { deposit: 300_000n, call: 100_000n, agentCall: 50_000n, agentBudget: 100_000n, agentCap: 50_000n };
    expect(smokePlan(ok).qusdc).to.equal(300_000n);
    expect(() => smokePlan({ ...ok, agentCall: 60_000n })).to.throw(GuardError); // above the agent's cap
    expect(() => smokePlan({ ...ok, agentCap: 200_000n })).to.throw(GuardError); // cap above budget
    expect(() => smokePlan({ ...ok, deposit: 100_000n })).to.throw(GuardError); // deposit cannot cover the calls
    expect(() => smokePlan({ ...ok, call: 0n })).to.throw(GuardError);
  });
});

describe("Guard: the live scripts refuse before they do anything", () => {
  const scripts: Array<[string, typeof deployMain]> = [
    ["deploy", deployMain],
    ["smoke", smokeMain],
  ];
  for (const [name, main] of scripts) {
    it(`${name}: refuses with an empty environment`, async () => {
      expect(await refusalAsync(() => main({}, () => undefined))).to.contain("SLUICE_NETWORK");
    });

    it(`${name}: refuses with a network chosen but no approval`, async () => {
      expect(await refusalAsync(() => main({ SLUICE_NETWORK: "mainnet" }, () => undefined))).to.contain(`SLUICE_APPROVE=${name}`);
    });

    it(`${name}: refuses the other script's approval`, async () => {
      const other = name === "deploy" ? "smoke" : "deploy";
      const message = await refusalAsync(() => main({ SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: other }, () => undefined));
      expect(message).to.contain(`approves "${other}", not "${name}"`);
    });

    it(`${name}: refuses when approved but there is no key, so it cannot sign anything`, async () => {
      const message = await refusalAsync(() => main({ SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: name }, () => undefined));
      expect(message).to.contain("SLUICE_KEY");
    });

    it(`${name}: refuses when its own worst case is above a cap the founder set`, async () => {
      const env = { SLUICE_NETWORK: "testnet", SLUICE_APPROVE: name, SLUICE_KEY: KEY };
      expect(await refusalAsync(() => main({ ...env, SLUICE_MAX_QIE: "0.05" }, () => undefined))).to.match(/on gas, above the cap of 0\.05/);
    });

    it(`${name}: prints nothing before the guard has passed`, async () => {
      const lines: string[] = [];
      await refusalAsync(() => main({ SLUICE_NETWORK: "mainnet" }, (line) => lines.push(line)));
      expect(lines).to.deep.equal([]);
    });
  }

  it("smoke refuses when its deposit is above a QUSDC cap the founder set", async () => {
    const env = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "smoke", SLUICE_KEY: KEY, SLUICE_MAX_QUSDC: "0.2" };
    expect(await refusalAsync(() => smokeMain(env, () => undefined))).to.match(/may move 0\.300000 QUSDC, above the cap of 0\.200000/);
  });

  it("deploy refuses a QUSDC cap of anything above the 100 ceiling", async () => {
    const env = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", SLUICE_KEY: KEY, SLUICE_MAX_QUSDC: "101" };
    expect(await refusalAsync(() => deployMain(env, () => undefined))).to.match(/hard ceiling/);
  });
});

describe("Guard: how the live scripts are written", () => {
  const root = join(__dirname, "..", "..");
  const files = ["scripts/live/deploy.ts", "scripts/live/smoke.ts"];
  const code = (file: string) =>
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  for (const file of files) {
    it(`${file}: calls requireApproval before it can open a connection, read a key or send`, () => {
      const source = code(file);
      const gate = source.indexOf("requireApproval(");
      expect(gate, "the script calls requireApproval").to.be.greaterThan(-1);
      for (const token of ["new JsonRpcProvider(", "new Wallet(", ".send(", "sendTransaction", "deployRouter(", "runSmoke(", "fetch(", "privateKey()", "getBalance("]) {
        const at = source.indexOf(token);
        if (at !== -1) expect(at, `${token} comes after the gate`).to.be.greaterThan(gate);
      }
    });

    it(`${file}: the gate is the first statement of main`, () => {
      const source = code(file);
      const body = source.slice(source.indexOf("export async function main"));
      const firstStatement = body.split("{").slice(1).join("{").trim().split("\n")[0]!.trim();
      expect(firstStatement).to.match(/^const approval = requireApproval\("(deploy|smoke)", env, (deployPlan|smokePlan)\(\)\);$/);
    });

    it(`${file}: only runs by itself when invoked directly, never when imported`, () => {
      expect(code(file)).to.contain("if (require.main === module)");
    });

    it(`${file}: never reads the key itself, nor prints the environment`, () => {
      const source = code(file);
      expect(source).to.not.match(/SLUICE_KEY/);
      expect(source).to.not.match(/console\.log\(\s*(process\.)?env\b/);
      expect(source).to.not.match(/JSON\.stringify\(\s*(process\.)?env\b/);
      // The key is used in exactly one place: handed to new Wallet(...).
      expect(source.split("privateKey()").length - 1).to.equal(source.split("new Wallet(approval.privateKey()").length - 1);
    });

    it(`${file}: sends its errors through redact before printing`, () => {
      expect(code(file)).to.match(/console\.error\(redact\(/);
    });
  }

  it("the library reads no environment variable named like a key, and never prints a private key", () => {
    const live = code("src/live.ts");
    expect(live).to.not.match(/SLUICE_KEY/);
    expect(live).to.not.match(/privateKey/i);
    // The throwaway agent key is created in memory and never logged.
    expect(live).to.not.match(/log\([^)]*agent\.(privateKey|mnemonic)/);
  });

  it("only the guard reads the private key from the environment", () => {
    for (const file of ["src/live.ts", "src/evidence.ts", "src/events.ts", "src/units.ts", ...files]) {
      expect(code(file), file).to.not.match(/env\.SLUICE_KEY|env\["SLUICE_KEY"\]/);
    }
    expect(code("src/guard.ts")).to.match(/env\.SLUICE_KEY/);
  });

  it("the mainnet token is the QUSDC address from the brief", () => {
    expect(QUSDC_ADDRESS).to.equal("0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5");
  });
});

describe("Guard: the previous project name authorises nothing", () => {
  // The project was renamed on 2026-11-19. Every variable that carried the old prefix must now be inert.
  // The old prefix is assembled from pieces so that no file in the repository spells the old name out.
  const OLD = ["PAY", "METER"].join("");
  const old = (suffix: string) => `${OLD}_${suffix}`;
  const address = "0x1111111111111111111111111111111111111111";
  /** A complete, otherwise valid environment, written entirely with the old variable names. */
  const allOld = (script: string): Record<string, string> => ({
    [old("NETWORK")]: "mainnet",
    [old("APPROVE")]: script,
    [old("KEY")]: KEY,
    [old("MAX_QUSDC")]: "5",
    [old("MAX_QIE")]: "1",
    [old("TOKEN")]: address,
    [old("OWNER")]: address,
    [old("FEE_RECIPIENT")]: address,
    [old("FEE_BPS")]: "100",
    [old("ROUTER")]: address,
    [old("PAYEE")]: address,
  });

  it("a complete environment under the old names is refused at the first check", () => {
    const message = refusal(() => requireApproval("deploy", allOld("deploy"), small));
    expect(message).to.contain("SLUICE_NETWORK");
    expect(message).to.not.contain(OLD);
  });

  it("the new network and key with only the old approval variable still refuse, and ask for the new one", () => {
    for (const script of ["deploy", "smoke"]) {
      const env = { SLUICE_NETWORK: "mainnet", SLUICE_KEY: KEY, [old("APPROVE")]: script };
      const message = refusal(() => requireApproval(script, env, small));
      expect(message).to.contain(`SLUICE_APPROVE=${script}`);
      expect(message).to.not.contain(OLD);
    }
  });

  it("the old key variable does not supply a key", () => {
    const env = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "deploy", [old("KEY")]: KEY };
    expect(refusal(() => requireApproval("deploy", env, small))).to.contain("SLUICE_KEY");
  });

  it("the old cap and RPC variables change nothing: the defaults and the public https endpoint stay", () => {
    expect(readCaps({ [old("MAX_QUSDC")]: "1", [old("MAX_QIE")]: "1" })).to.deep.equal(readCaps({}));
    const approval = requireApproval("deploy", { ...base, [old("RPC_URL")]: "http://example.org", [old("MAX_QUSDC")]: "0.1" }, small);
    expect(approval.rpcUrl).to.equal("https://rpc1mainnet.qie.digital/");
    expect(approval.caps).to.deep.equal({ maxQusdc: 10_000_000n, maxQieWei: 5n * 10n ** 18n });
  });

  it("the old network variable does not choose a network", () => {
    const env = { SLUICE_APPROVE: "deploy", SLUICE_KEY: KEY, [old("NETWORK")]: "mainnet" };
    expect(refusal(() => requireApproval("deploy", env, small))).to.contain("SLUICE_NETWORK");
  });

  for (const [name, main] of [["deploy", deployMain], ["smoke", smokeMain]] as const) {
    it(`${name}: run with the old approval variable set, it refuses before printing or connecting to anything`, async () => {
      const lines: string[] = [];
      const env = { SLUICE_NETWORK: "mainnet", SLUICE_KEY: KEY, [old("APPROVE")]: name };
      const message = await refusalAsync(() => main(env, (line) => lines.push(line)));
      expect(message).to.contain(`SLUICE_APPROVE=${name}`);
      expect(lines).to.deep.equal([]);
    });

    it(`${name}: run with a complete environment under the old names, it refuses at the gate`, async () => {
      const lines: string[] = [];
      const message = await refusalAsync(() => main(allOld(name), (line) => lines.push(line)));
      expect(message).to.contain("SLUICE_NETWORK");
      expect(lines).to.deep.equal([]);
    });
  }
});
