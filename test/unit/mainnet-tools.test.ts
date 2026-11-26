// The mainnet-readiness tools that read the chain or write settings, with a pretend chain so every case runs in milliseconds: QUSDC's facts
// (read again and compared with docs/RISKS.md), the funding calculator (the pool's maths, the plan, what it prints, the command) and the
// wiring of deployment.json into the three settings files. Nothing here touches a network.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { AbiCoder, Interface, getAddress, toQuantity } from "ethers";
import { amountOut } from "../../examples/paid-tools/src/dexQuote";
import { createToolServer, readToolServerEnv, ToolServerEnvError } from "../../examples/paid-tools/src";
import { startFacilitator, readEnv, EnvError } from "../../packages/facilitator/src";
import { NetworkError } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import { DEFAULT_MARGIN, DEFAULT_RUN_QUSDC, FUNDING_READ_ONLY_METHODS, PRICED_SIZES, amountIn, ceilQie, formatFunding, planFunding, purchase, readFundingInputs } from "../../src/funding";
import type { FundingReads, Reserves } from "../../src/funding";
import { MEASURED_GAS, SMOKE_GAS_TOTAL, costWei } from "../../src/gas-figures";
import { QUSDC_ADDRESS } from "../../src/guard";
import { qusdcRolesCheck } from "../../src/preflight";
import { FACTS_READ_ONLY_METHODS, RISKS_FACTS, compareWithRisks, formatFacts, readQusdcFacts } from "../../src/qusdc-facts";
import type { QusdcFacts } from "../../src/qusdc-facts";
import { RecordError, appendRows, parseForkRows } from "../../src/recorder";
import { RpcRefused } from "../../src/readrpc";
import { NOT_WRITTEN, WireError, describeWiring, parseDeployment, parseEnvFile, renderEnvFile, wire } from "../../src/wire";
import { main as factsMain } from "../../scripts/live/facts";
import { main as fundingMain } from "../../scripts/live/funding";
import { main as wireMain } from "../../scripts/live/wire";
import { liveMissing, readConfig } from "../../apps/web/src/lib/config";
import { explorerTxUrl, networkFor } from "../../apps/web/src/lib/networks";
import { evidenceTemplate } from "../helpers/evidence-template";

// ------------------------------------------------------------------------------------------------------- a pretend QUSDC and QIEDEX

const ROOT_FILE = (...parts: string[]): string => join(__dirname, "..", "..", ...parts);

const QUSDC = getAddress(QUSDC_ADDRESS);
const FACTORY = getAddress("0x8E23128a5511223bE6c0d64106e2D4508C08398C");
const DEX_ROUTER = getAddress("0x08cd2e72e156D8563B4351eb4065C262A9f553Ef");
const WQIE = getAddress("0x0087904D95BEe9E5F24dc8852804b547981A9139");
const PAIR = getAddress("0x73a3cCF7da7e473ed2e9994aE764f0E30f4e4DFe");
const ADMIN_ROLE = `0x${"00".repeat(32)}`;
const VAULT_ROLE = `0x${"ab".repeat(32)}`;
const coder = AbiCoder.defaultAbiCoder();

const tokenIface = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function VAULT_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function getRoleMember(bytes32,uint256) view returns (address)",
  "function mint(address,uint256)",
  "function burn(address,uint256)",
]);
const pairIface = new Interface(["function token0() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"]);
const dexIface = new Interface(["function getAmountsIn(uint256,address[]) view returns (uint256[])"]);

type World = {
  chainId?: number;
  block?: number;
  gasPrice?: bigint;
  /** QUSDC the pool holds and WQIE it holds. Undefined: there is no pool. */
  reserves?: { qusdc: bigint; wqie: bigint } | undefined;
  /** What the pool's router answers for getAmountsIn; defaults to the formula. */
  routerIn?: (out: bigint) => bigint;
  balances?: Record<string, { qie: bigint; qusdc: bigint }>;
  // QUSDC's roles
  vaultHolderHasRole?: boolean;
  adminHolderHasRole?: boolean;
  vaultHolderIsContract?: boolean;
  upgradeable?: boolean;
  strangerCanBurn?: boolean;
  vaultCanBurn?: boolean;
  enumerable?: { vault: string[]; admin: string[] };
  decimals?: number;
  name?: string;
  supply?: bigint;
};

/** Every call it was asked, as [method, block tag it was asked at]. */
type Log = Array<{ method: string; tag: string | undefined }>;

function world(w: World = {}): { rpc: Rpc; log: Log } {
  const log: Log = [];
  const reserves = "reserves" in w ? w.reserves : { qusdc: 4_631_441_385n, wqie: 28_247_084_085_000_000_000_000n };
  const block = w.block ?? 12_085_038;
  const rpc: Rpc = async (method, params) => {
    const p = params as unknown[];
    log.push({ method, tag: method === "eth_call" ? (p[1] as string) : method === "eth_getStorageAt" || method === "eth_getCode" ? (p[p.length - 1] as string) : undefined });
    switch (method) {
      case "eth_chainId":
        return toQuantity(w.chainId ?? 1990);
      case "eth_blockNumber":
        return toQuantity(block);
      case "eth_gasPrice":
        return toQuantity(w.gasPrice ?? 1_125_000_000n);
      case "eth_getBlockByNumber":
        return { number: toQuantity(block), timestamp: toQuantity(1_795_000_000) };
      case "eth_getBalance":
        return toQuantity(w.balances?.[getAddress(String(p[0]))]?.qie ?? 0n);
      case "eth_getStorageAt":
        return w.upgradeable && p[1] === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" ? `0x${"00".repeat(12)}${"11".repeat(20)}` : `0x${"00".repeat(32)}`;
      case "eth_getCode":
        return getAddress(String(p[0])) === RISKS_FACTS.vaultRoleHolder && w.vaultHolderIsContract === false ? "0x" : "0x6080";
      case "eth_call": {
        const call = p[0] as { to: string; data: string; from?: string };
        const to = getAddress(call.to);
        if (to === FACTORY) {
          return coder.encode(["address"], [reserves ? PAIR : `0x${"00".repeat(20)}`]);
        }
        if (to === PAIR) {
          const name = pairIface.parseTransaction({ data: call.data })?.name;
          if (name === "token0") return coder.encode(["address"], [QUSDC]);
          return coder.encode(["uint112", "uint112", "uint32"], [reserves?.qusdc ?? 0n, reserves?.wqie ?? 0n, 1]);
        }
        if (to === DEX_ROUTER) {
          const [out] = dexIface.decodeFunctionData("getAmountsIn", call.data) as unknown as [bigint];
          const r = reserves as { qusdc: bigint; wqie: bigint };
          const need = w.routerIn ? w.routerIn(out) : (amountIn(out, r.wqie, r.qusdc) as bigint);
          return coder.encode(["uint256[]"], [[need, out]]);
        }
        if (to !== QUSDC) throw new RpcRefused("no such contract");
        const parsed = tokenIface.parseTransaction({ data: call.data });
        if (!parsed) throw new RpcRefused("no such function");
        const from = call.from ? getAddress(call.from) : undefined;
        switch (parsed.name) {
          case "name":
            return tokenIface.encodeFunctionResult("name", [w.name ?? "QUSDC"]);
          case "symbol":
            return tokenIface.encodeFunctionResult("symbol", ["QUSDC"]);
          case "decimals":
            return tokenIface.encodeFunctionResult("decimals", [w.decimals ?? 6]);
          case "totalSupply":
            return tokenIface.encodeFunctionResult("totalSupply", [w.supply ?? 8_929_088_928n]);
          case "VAULT_ROLE":
            return tokenIface.encodeFunctionResult("VAULT_ROLE", [VAULT_ROLE]);
          case "DEFAULT_ADMIN_ROLE":
            return tokenIface.encodeFunctionResult("DEFAULT_ADMIN_ROLE", [ADMIN_ROLE]);
          case "hasRole": {
            const [role, who] = parsed.args as unknown as [string, string];
            const holder = getAddress(who);
            const yes = role === VAULT_ROLE ? holder === RISKS_FACTS.vaultRoleHolder && w.vaultHolderHasRole !== false : holder === RISKS_FACTS.adminHolder && w.adminHolderHasRole !== false;
            return tokenIface.encodeFunctionResult("hasRole", [yes]);
          }
          case "getRoleMemberCount":
            if (!w.enumerable) throw new RpcRefused("not enumerable");
            return tokenIface.encodeFunctionResult("getRoleMemberCount", [BigInt(((parsed.args[0] as string) === VAULT_ROLE ? w.enumerable.vault : w.enumerable.admin).length)]);
          case "getRoleMember": {
            const list = (parsed.args[0] as string) === VAULT_ROLE ? w.enumerable?.vault : w.enumerable?.admin;
            return tokenIface.encodeFunctionResult("getRoleMember", [list?.[Number(parsed.args[1])] ?? `0x${"00".repeat(20)}`]);
          }
          case "balanceOf":
            return tokenIface.encodeFunctionResult("balanceOf", [getAddress(String(parsed.args[0])) === PAIR ? 4_631_441_385n : (w.balances?.[getAddress(String(parsed.args[0]))]?.qusdc ?? 0n)]);
          case "burn":
          case "mint": {
            const isVault = from === RISKS_FACTS.vaultRoleHolder;
            const allowed = isVault ? parsed.name === "mint" || w.vaultCanBurn !== false : parsed.name === "burn" && w.strangerCanBurn === true;
            if (!allowed) throw new RpcRefused("AccessControl: missing role");
            return "0x";
          }
          default:
            throw new RpcRefused("unknown");
        }
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
  return { rpc, log };
}

/** A fetch that answers JSON-RPC from a pretend world, for the commands that build their own client. */
function fetchFor(rpc: Rpc): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    try {
      const result = await rpc(body.method, body.params);
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result }) };
    } catch (err) {
      return err instanceof RpcRefused ? { status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "refused" } }) } : { status: 500, json: async () => ({}) };
    }
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------------------------------------------- QUSDC's facts

describe("QUSDC's facts, read again and compared with docs/RISKS.md", () => {
  it("states the same addresses as docs/RISKS.md does", () => {
    const risks = readFileSync(ROOT_FILE("docs", "RISKS.md"), "utf8");
    expect(risks).to.contain(RISKS_FACTS.token);
    expect(risks).to.contain(RISKS_FACTS.vaultRoleHolder);
    expect(risks).to.contain(RISKS_FACTS.adminHolder);
  });

  it("reads every fact at one block and says which, and matches the document when nothing has changed", async () => {
    const { rpc, log } = world({ block: 12_085_038 });
    const facts = await readQusdcFacts(rpc);
    expect(facts.block).to.equal(12_085_038);
    expect(facts).to.deep.include({ name: "QUSDC", symbol: "QUSDC", decimals: 6, upgradeable: false, vaultRoleHolderHasVaultRole: true, vaultRoleHolderIsContract: true, adminHolderHasAdminRole: true, adminHolderHasVaultRole: false });
    expect(facts.totalSupply).to.equal(8_929_088_928n);
    expect(facts).to.deep.include({ vaultCanBurn: "yes", strangerCanBurn: "no", vaultCanMint: "yes", strangerCanMint: "no", burnVictim: PAIR });
    expect(compareWithRisks(facts)).to.deep.equal({ matches: true, differences: [] });
    // Every read is pinned to that block, so the answers are about one moment.
    const tags = log.filter((l) => l.tag !== undefined).map((l) => l.tag);
    expect(tags.length).to.be.greaterThan(10);
    for (const tag of tags) expect(tag).to.equal(toQuantity(12_085_038));
    // And only read-only methods were asked.
    for (const l of log) expect(FACTS_READ_ONLY_METHODS.has(l.method), l.method).to.equal(true);
  });

  it("says each way the facts can differ from the document, by name", async () => {
    const cases: Array<[World, RegExp]> = [
      [{ vaultHolderHasRole: false }, /no longer holds VAULT_ROLE/],
      [{ adminHolderHasRole: false }, /no longer holds DEFAULT_ADMIN_ROLE/],
      [{ vaultHolderIsContract: false }, /no longer a contract/],
      [{ upgradeable: true }, /EIP-1967 slot is no longer empty/],
      [{ decimals: 18 }, /18 decimals, not 6/],
      [{ name: "USDQ" }, /not QUSDC/],
      [{ vaultCanBurn: false }, /can no longer burn/],
      [{ strangerCanBurn: true }, /an address with no role can burn/],
      [{ enumerable: { vault: [RISKS_FACTS.vaultRoleHolder, getAddress(`0x${"99".repeat(20)}`)], admin: [RISKS_FACTS.adminHolder] } }, /VAULT_ROLE has 2 holders/],
      [{ enumerable: { vault: [RISKS_FACTS.vaultRoleHolder], admin: [RISKS_FACTS.adminHolder, getAddress(`0x${"98".repeat(20)}`)] } }, /DEFAULT_ADMIN_ROLE has 2 holders/],
    ];
    for (const [change, pattern] of cases) {
      const cmp = compareWithRisks(await readQusdcFacts(world(change).rpc));
      expect(cmp.matches, JSON.stringify(change)).to.equal(false);
      expect(cmp.differences.join(" | "), JSON.stringify(change)).to.match(pattern);
    }
  });

  it("does not take a call that succeeds for everyone as proof that the vault role can burn, and does not guess when there is no pool", async () => {
    const everyone = await readQusdcFacts(world({ strangerCanBurn: true }).rpc);
    expect(everyone).to.deep.include({ vaultCanBurn: "yes", strangerCanBurn: "yes" });
    const noPool = await readQusdcFacts(world({ reserves: undefined }).rpc);
    expect(noPool).to.deep.include({ vaultCanBurn: "unknown", strangerCanBurn: "unknown" });
    expect(noPool.burnVictim).to.equal(undefined);
    expect(compareWithRisks(noPool).matches).to.equal(true); // unknown is not a difference, and it is printed as not tried
    expect(formatFacts(noPool, compareWithRisks(noPool)).join("\n")).to.contain("not tried (no holder to burn from)");
  });

  it("prints a table with the block, the supply and the verdict, and the command exits 0, 1 or 2 accordingly", async () => {
    const facts = await readQusdcFacts(world().rpc);
    const text = formatFacts(facts, compareWithRisks(facts)).join("\n");
    expect(text).to.contain("read at block 12085038");
    expect(text).to.contain("8929.088928 QUSDC");
    expect(text).to.contain("These match what docs/RISKS.md says.");
    const run = async (w: World, env: Record<string, string> = { SLUICE_RPC_URL: "http://127.0.0.1:1" }, argv: string[] = []) => {
      const lines: string[] = [];
      const code = await factsMain(argv, env, { log: (l) => lines.push(l), fetchImpl: fetchFor(world(w).rpc) });
      return { code, text: lines.join("\n") };
    };
    expect((await run({})).code).to.equal(0);
    const changed = await run({ vaultHolderHasRole: false });
    expect(changed.code).to.equal(1);
    expect(changed.text).to.contain("These differ from docs/RISKS.md");
    const wrongChain = await run({ chainId: 1983 });
    expect(wrongChain.code).to.equal(1);
    expect(wrongChain.text).to.match(/on chain 1983/);
    expect((await run({}, {}, ["--bogus"])).code).to.equal(1);
    expect((await run({}, { SLUICE_RPC_URL: "http://rpc.example.com" })).text).to.contain("must be https");
    const dead = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    expect(await factsMain([], { SLUICE_RPC_URL: "http://127.0.0.1:1" }, { log: (l) => lines.push(l), fetchImpl: dead })).to.equal(2);
  });

  it("is a warning in the pre-flight check, never a failure: a changed role says so, and an unreadable chain says so", async () => {
    const ok = await qusdcRolesCheck(world().rpc);
    expect(ok.status).to.equal("PASS");
    expect(ok.detail).to.contain("as docs/RISKS.md says");
    const changed = await qusdcRolesCheck(world({ vaultHolderHasRole: false }).rpc);
    expect(changed.status).to.equal("WARN");
    expect(changed.detail).to.match(/differs from docs\/RISKS.md at block 12085038/);
    const unreadable = await qusdcRolesCheck((async () => {
      throw new NetworkError("no RPC endpoint could be reached");
    }) as Rpc);
    expect(unreadable.status).to.equal("WARN");
    expect(unreadable.detail).to.contain("could not be read");
  });

  it("builds facts by hand the way the table prints them", () => {
    const f: QusdcFacts = {
      block: 7, name: "QUSDC", symbol: "QUSDC", decimals: 6, totalSupply: 5n, upgradeable: false, vaultRoleHolderHasVaultRole: true, vaultRoleHolderIsContract: true,
      adminHolderHasAdminRole: true, adminHolderHasVaultRole: true, vaultCanBurn: "yes", strangerCanBurn: "no", vaultCanMint: "yes", strangerCanMint: "no",
    };
    const text = formatFacts(f, compareWithRisks(f)).join("\n");
    expect(text).to.contain("That admin account also holds VAULT_ROLE | yes");
    expect(text).to.contain("not listed by this token");
  });
});

// ------------------------------------------------------------------------------------------------------- the funding calculator

describe("The funding calculator", () => {
  const reserves: Reserves = { pair: PAIR, qusdc: 4_631_441_385n, wqie: 28_247_084_085_000_000_000_000n };

  it("prices QUSDC from the pool with Uniswap V2's rule, and the answer is the least QIE that buys it", () => {
    // By hand: 1000 x 10 x 1000 / ((500 - 10) x 997) = 20.47, floored to 20, plus 1 = 21.
    expect(amountIn(10n, 1000n, 500n)).to.equal(21n);
    expect(amountOut(21n, 1000n, 500n)).to.be.at.least(10n);
    expect(amountOut(20n, 1000n, 500n)).to.be.lessThan(10n);
    for (const [out, rIn, rOut] of [[10_000_000n, reserves.wqie, reserves.qusdc], [1n, 7_000n, 3_000n], [999n, 10n ** 12n, 10n ** 9n], [25_000_000n, reserves.wqie, reserves.qusdc]] as const) {
      const need = amountIn(out, rIn, rOut) as bigint;
      expect(amountOut(need, rIn, rOut), `out ${out}`).to.be.at.least(out);
      expect(amountOut(need - 1n, rIn, rOut), `out ${out}, one wei less`).to.be.lessThan(out);
    }
  });

  it("says when the pool cannot supply an amount, and prices nothing for a bad input", () => {
    expect(amountIn(500n, 1000n, 500n)).to.equal(undefined);
    expect(amountIn(501n, 1000n, 500n)).to.equal(undefined);
    expect(amountIn(0n, 1000n, 500n)).to.equal(undefined);
    expect(amountIn(10n, 0n, 500n)).to.equal(undefined);
    expect(amountIn(10n, 1000n, 0n)).to.equal(undefined);
    expect(purchase(10n ** 12n, reserves)).to.deep.equal({ qusdc: 10n ** 12n });
  });

  it("makes a larger purchase dearer per QUSDC, and reports how much of the pool it takes", () => {
    const [a, b, c] = PRICED_SIZES.map((size) => purchase(size, reserves));
    expect(a?.costVsSpotBps).to.be.greaterThan(30n); // the 0.3% fee alone
    expect(b!.costVsSpotBps!).to.be.greaterThan(a!.costVsSpotBps!);
    expect(c!.costVsSpotBps!).to.be.greaterThan(b!.costVsSpotBps!);
    expect(a?.poolShareBps).to.equal(21n); // 10 of 4,631.441385 QUSDC: 0.21%
    expect(c?.poolShareBps).to.equal(215n);
  });

  it("budgets the gas from the figures measured in docs/GAS.md, at the price read, with the margin", () => {
    const price = 1_125_000_000n;
    const plan = planFunding({ gasPrice: price, runQusdc: DEFAULT_RUN_QUSDC, margin: DEFAULT_MARGIN, dailyBudgetWei: 5n * 10n ** 17n });
    expect(plan.deployerGas).to.equal(MEASURED_GAS.deployRouter + SMOKE_GAS_TOTAL);
    expect(plan.deployerGas).to.equal(3_794_673n);
    expect(plan.deployerQieWei).to.equal(3_794_673n * price * 3n);
    expect(plan.relayerGas).to.equal(21_000n + 134_066n + 695_167n + 101_687n + 101_639n);
    expect(plan.relayerSteps.map(([, gas]) => gas)).to.deep.equal([MEASURED_GAS.topUpTransfer, MEASURED_GAS.authorizeBySig, MEASURED_GAS.batch10Worst, MEASURED_GAS.withdrawBySig, MEASURED_GAS.refundBySig]);
    // The top-up the owner is sent covers the two transactions they sign (190,000 gas) at a tenth above the price.
    expect(plan.relayerTopUpWei).to.equal(costWei(190_000n, price, 10n));
    expect(plan.relayerRunQieWei).to.equal(plan.relayerGas * price * 3n + plan.relayerTopUpWei * 3n);
    expect(plan.relayerFloorWei).to.equal(costWei(MEASURED_GAS.batch50Worst * 5n, price));
    // The relayer should hold the largest of its run's need, the pre-flight floor and a day's budget (here the budget).
    expect(plan.relayerHoldWei).to.equal(5n * 10n ** 17n);
    expect(plan.deployerQusdc).to.equal(300_000n);
    expect(plan.totalQusdc).to.equal(10_300_000n);
  });

  it("scales with the margin and the gas price, and a bigger run or budget changes only what it should", () => {
    const base = { gasPrice: 1_000_000_000n, runQusdc: 10_000_000n, margin: 1n, dailyBudgetWei: 1n };
    const one = planFunding(base);
    const three = planFunding({ ...base, margin: 3n });
    expect(three.deployerQieWei).to.equal(one.deployerQieWei * 3n);
    expect(three.relayerRunQieWei).to.equal(one.relayerRunQieWei * 3n);
    expect(planFunding({ ...base, gasPrice: 2_000_000_000n }).deployerQieWei).to.equal(one.deployerQieWei * 2n);
    const bigger = planFunding({ ...base, runQusdc: 25_000_000n });
    expect(bigger.ownerQusdc).to.equal(25_000_000n);
    expect(bigger.totalQusdc).to.equal(25_300_000n);
    expect(bigger.deployerQieWei).to.equal(one.deployerQieWei);
    // With a tiny budget the pre-flight floor (five of the largest batches) is what the relayer must hold.
    expect(one.relayerHoldWei).to.equal(one.relayerFloorWei > one.relayerRunQieWei ? one.relayerFloorWei : one.relayerRunQieWei);
    expect(planFunding({ ...base, dailyBudgetWei: 10n ** 19n }).relayerHoldWei).to.equal(10n ** 19n);
  });

  it("rounds a need up to six places, never down", () => {
    expect(ceilQie(1n)).to.equal("0.000001");
    expect(ceilQie(1_000_000_000_000n)).to.equal("0.000001");
    expect(ceilQie(1_000_000_000_001n)).to.equal("0.000002");
    expect(ceilQie(10n ** 18n)).to.equal("1.000000");
    expect(ceilQie(12_345_678_901_234_567_890n)).to.equal("12.345679");
  });

  it("reads the block, its time, the gas price, the pool and the balances at one block, and asks the pool's own router too", async () => {
    const w = world({ balances: { [getAddress(`0x${"11".repeat(20)}`)]: { qie: 5n * 10n ** 18n, qusdc: 2_000_000n } } });
    const reads = await readFundingInputs(w.rpc, [{ label: "deployer", address: `0x${"11".repeat(20)}` }]);
    expect(reads).to.deep.include({ chainId: 1990, block: 12_085_038, timestamp: 1_795_000_000, gasPrice: 1_125_000_000n });
    expect(reads.reserves).to.deep.equal({ pair: PAIR, qusdc: 4_631_441_385n, wqie: 28_247_084_085_000_000_000_000n });
    expect([...(reads.routerIn?.keys() ?? [])]).to.deep.equal([...PRICED_SIZES]);
    expect(reads.balances).to.deep.equal([{ label: "deployer", address: getAddress(`0x${"11".repeat(20)}`), qieWei: 5n * 10n ** 18n, qusdc: 2_000_000n }]);
    for (const l of w.log) expect(FUNDING_READ_ONLY_METHODS.has(l.method), l.method).to.equal(true);
    for (const l of w.log.filter((x) => x.tag !== undefined)) expect(l.tag).to.equal(toQuantity(12_085_038));
    const noPool = await readFundingInputs(world({ reserves: undefined }).rpc);
    expect(noPool.reserves).to.equal(undefined);
  });

  const fixed: FundingReads = {
    chainId: 1990, block: 12_085_038, timestamp: 1_795_000_000, gasPrice: 1_125_000_000n, reserves,
    balances: [{ label: "deployer", address: getAddress(`0x${"11".repeat(20)}`), qieWei: 10n ** 16n, qusdc: 100_000n }, { label: "relayer", address: getAddress(`0x${"22".repeat(20)}`), qieWei: 0n, qusdc: 0n }],
  };

  it("prints the block and its time, each address's need and what it still lacks, the pool's prices with the formula, and one total, from the numbers it read", () => {
    const text = formatFunding(fixed, { runQusdc: 10_000_000n, margin: 3n, dailyBudgetWei: 5n * 10n ** 17n }).join("\n");
    expect(text).to.contain(`read from QIE at block 12085038, ${new Date(1_795_000_000 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")} UTC`);
    expect(text).to.contain("Gas price 1.125 gwei");
    expect(text).to.contain("needs 0.012808 QIE");
    expect(text).to.contain("holds 0.010000 QIE and 0.100000 QUSDC: send at least 0.002808 more");
    expect(text).to.contain("send at least 0.200000 QUSDC more");
    expect(text).to.contain("holds 0.000000 QIE: send at least 0.500000 more");
    for (const size of ["10.000000", "25.000000", "100.000000", "10.300000"]) expect(text).to.contain(`${size} QUSDC:`);
    expect(text).to.contain("Formula: QIE in = floor(reserveQIE x out x 1000 / ((reserveQUSDC - out) x 997)) + 1");
    expect(text).to.match(/TOTAL: 0\.012808 QIE to the deployer \+ 0\.500000 QIE to the relayer \+ 63\.1\d+ QIE to buy 10\.300000 QUSDC from the pool = 63\.\d+ QIE/);
    expect(text).to.contain("No dollar price is read or used, so none is given");
    expect(text).to.not.contain("$");
  });

  it("says a figure from the pool's own router that differs from the formula, and prefers the router's for the total", () => {
    const router = new Map<bigint, bigint>([[10_300_000n, 70n * 10n ** 18n]]);
    const text = formatFunding({ ...fixed, routerIn: router }, { runQusdc: 10_000_000n, margin: 3n, dailyBudgetWei: 5n * 10n ** 17n }).join("\n");
    expect(text).to.contain("the pool's own router gives 70.000000 QIE, which differs from this formula: trust the router");
    expect(text).to.contain("= 70.512808 QIE");
  });

  it("prices nothing when the pool could not be read, and says so instead of guessing", () => {
    const text = formatFunding({ ...fixed, reserves: undefined }, { runQusdc: 10_000_000n, margin: 3n, dailyBudgetWei: 5n * 10n ** 17n }).join("\n");
    expect(text).to.contain("could not be read at this block, so nothing is priced and nothing is guessed");
    expect(text).to.contain("TOTAL QIE for gas: 0.512808 QIE");
    expect(text).to.contain("which is not priced because the pool was not read");
    expect(text).to.not.match(/QIE in;/);
  });

  it("says a size the pool cannot supply, and enough already when an address holds enough", () => {
    const thin: Reserves = { pair: PAIR, qusdc: 50_000_000n, wqie: 10n ** 21n };
    const text = formatFunding({ ...fixed, reserves: thin, balances: [{ label: "deployer", address: getAddress(`0x${"11".repeat(20)}`), qieWei: 10n ** 18n, qusdc: 5_000_000n }] }, { runQusdc: 10_000_000n, margin: 3n, dailyBudgetWei: 5n * 10n ** 17n }).join("\n");
    expect(text).to.contain("100.000000 QUSDC: the pool cannot supply that much");
    expect(text).to.contain("enough already");
  });

  describe("the command", () => {
    const run = async (argv: string[], w: World = {}, env: Record<string, string> = {}) => {
      const lines: string[] = [];
      const code = await fundingMain(argv, { SLUICE_RPC_URL: "http://127.0.0.1:1", ...env }, { log: (l) => lines.push(l), fetchImpl: fetchFor(world(w).rpc) });
      return { code, text: lines.join("\n") };
    };

    it("prints the plan for the two addresses it is given, with what each holds", async () => {
      const r = await run(["--deployer", `0x${"11".repeat(20)}`, "--relayer", `0x${"22".repeat(20)}`], { balances: { [getAddress(`0x${"11".repeat(20)}`)]: { qie: 10n ** 16n, qusdc: 0n } } });
      expect(r.code).to.equal(0);
      expect(r.text).to.contain(`Deployer ${getAddress(`0x${"11".repeat(20)}`)}`);
      expect(r.text).to.contain(`Relayer ${getAddress(`0x${"22".repeat(20)}`)}`);
      expect(r.text).to.contain("holds 0.010000 QIE and 0.000000 QUSDC: send at least 0.002808 more");
      expect(r.text).to.contain("TOTAL:");
    });

    it("takes the run's size and the margin, and refuses a size above the live scripts' ceiling and a margin out of range", async () => {
      const big = await run(["--qusdc", "25", "--margin", "4"]);
      expect(big.code).to.equal(0);
      expect(big.text).to.contain("margin of 4x");
      expect(big.text).to.contain("25.300000 QUSDC:");
      for (const bad of [["--qusdc", "100.000001"], ["--qusdc", "0"], ["--qusdc", "abc"], ["--margin", "0"], ["--margin", "11"], ["--margin", "2.5"]]) {
        const r = await run(bad);
        expect(r.code, bad.join(" ")).to.equal(1);
        expect(r.text).to.contain("refused");
      }
      expect((await run(["--qusdc", "100"])).code).to.equal(0);
    });

    it("refuses a wrong command, the same address twice, a bad address, and an RPC that is not https", async () => {
      expect((await run(["--bogus", "1"])).text).to.contain("unknown option --bogus");
      expect((await run(["--deployer"])).text).to.contain("--deployer needs a value");
      expect((await run(["--deployer", "0x123"])).text).to.contain("--deployer is not an address");
      const same = `0x${"11".repeat(20)}`;
      expect((await run(["--deployer", same, "--relayer", same])).text).to.contain("the same address");
      expect((await run([], {}, { SLUICE_RPC_URL: "http://rpc.example.com" })).text).to.contain("must be https");
    });

    it("exits 1 on a chain that is not mainnet, and 2 when the chain cannot be read, and never prints a number it did not read", async () => {
      const wrong = await run([], { chainId: 1983 });
      expect(wrong.code).to.equal(1);
      expect(wrong.text).to.match(/on chain 1983, but this calculator is for mainnet/);
      expect(wrong.text).to.not.contain("TOTAL");
      const dead = (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch;
      const lines: string[] = [];
      const code = await fundingMain([], { SLUICE_RPC_URL: "http://127.0.0.1:1" }, { log: (l) => lines.push(l), fetchImpl: dead });
      expect(code).to.equal(2);
      expect(lines.join("\n")).to.contain("the chain could not be read, so nothing was calculated");
    });

    it("uses SLUICE_MAX_QIE as the relayer's day budget", async () => {
      const r = await run([], {}, { SLUICE_MAX_QIE: "2" });
      expect(r.text).to.contain("to hold: 2.000000 QIE");
    });
  });
});

// ------------------------------------------------------------------------------------------------------- wiring deployment.json

describe("Wiring deployment.json into the three settings files", () => {
  const ROUTER = getAddress(`0x${"aa".repeat(20)}`);
  const VAULT = getAddress(`0x${"bb".repeat(20)}`);
  const record = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ network: "mainnet", chainId: 1990, router: ROUTER, vault: VAULT, hash: `0x${"cd".repeat(32)}`, block: 12_090_001, token: QUSDC, owner: ROUTER, feeRecipient: VAULT, feeBps: 100, routerCodeHash: `0x${"ef".repeat(32)}`, vaultCodeHash: `0x${"12".repeat(32)}`, ...over });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sluice-wire-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a deployment file for another network, another chain, another token, a bad address or no block", () => {
    expect(parseDeployment(record(), "mainnet")).to.deep.equal({ network: "mainnet", chainId: 1990, router: ROUTER, vault: VAULT, block: 12_090_001, token: QUSDC });
    expect(() => parseDeployment(record(), "testnet")).to.throw(WireError, /is for "mainnet", not testnet/);
    expect(() => parseDeployment(record({ network: "testnet" }), "mainnet")).to.throw(WireError, /is for "testnet", not mainnet/);
    expect(() => parseDeployment(record({ chainId: 1983 }), "mainnet")).to.throw(WireError, /names chain 1983, but mainnet is chain 1990/);
    expect(() => parseDeployment(record({ token: ROUTER }), "mainnet")).to.throw(WireError, /token is not QUSDC/);
    expect(() => parseDeployment(record({ router: "0x12" }), "mainnet")).to.throw(WireError, /router is not an address/);
    expect(() => parseDeployment(record({ vault: undefined }), "mainnet")).to.throw(WireError, /vault is not an address/);
    expect(() => parseDeployment(record({ block: "12" }), "mainnet")).to.throw(WireError, /block is not a block number/);
    expect(() => parseDeployment(record({ block: -1 }), "mainnet")).to.throw(WireError, /block is not a block number/);
    expect(() => parseDeployment("not json", "mainnet")).to.throw(WireError, /not JSON/);
    // A testnet router may hold another token.
    expect(parseDeployment(record({ network: "testnet", chainId: 1983, token: ROUTER }), "testnet").token).to.equal(ROUTER);
  });

  it("fills in the router, the vault, the token, the chain and the block, and leaves what only you can know empty", () => {
    const files = wire(parseDeployment(record(), "mainnet"));
    expect(files.map((f) => f.file)).to.deep.equal([".env.mainnet.facilitator", ".env.mainnet.tool-server", ".env.mainnet.web"]);
    const [facilitator, tools, web] = files.map((f) => parseEnvFile(renderEnvFile(f)));
    expect(facilitator).to.deep.include({ SLUICE_NETWORK: "mainnet", SLUICE_ROUTER: ROUTER, SLUICE_TOKEN: QUSDC, SLUICE_MAX_QIE: "0.5", SLUICE_FACILITATOR_STATE: "", SLUICE_FACILITATOR_URL: "", SLUICE_FACILITATOR_CORS_ORIGINS: "", SLUICE_FACILITATOR_METRICS_TOKEN: "" });
    expect(tools).to.deep.include({ SLUICE_NETWORK: "mainnet", SLUICE_ROUTER: ROUTER, SLUICE_TOKEN: QUSDC, SLUICE_PAYEE: "", SLUICE_FACILITATOR_URL: "", SLUICE_TOOLS_CORS_ORIGINS: "", SLUICE_TOOLS_METRICS_TOKEN: "" });
    expect(web).to.deep.include({
      NEXT_PUBLIC_CHAIN_ID: "1990", NEXT_PUBLIC_ROUTER_ADDRESS: ROUTER, NEXT_PUBLIC_VAULT_ADDRESS: VAULT, NEXT_PUBLIC_FROM_BLOCK: "12090001", SLUICE_FROM_BLOCK: "12090001",
      NEXT_PUBLIC_SESSION_CAP_QUSDC: "1", NEXT_PUBLIC_FACILITATOR_URL: "", NEXT_PUBLIC_TOOLS_URL: "", NEXT_PUBLIC_SITE_URL: "",
    });
  });

  it("writes no key, no hash and no approval, and says what it left out", () => {
    for (const f of wire(parseDeployment(record(), "mainnet"))) {
      const text = renderEnvFile(f);
      expect(text, f.file).to.not.match(/0x[0-9a-fA-F]{64}/);
      // A comment may name what is not written; no line may set it.
      expect(text, f.file).to.not.match(/^SLUICE_RELAYER_KEY=/m);
      expect(text, f.file).to.not.match(/^SLUICE_APPROVE=/m);
      expect(text, f.file).to.not.match(/^SLUICE_KEY=/m);
      expect(f.file.startsWith(".env."), "git-ignored by the .env.* rule").to.equal(true);
    }
    expect(NOT_WRITTEN.map(([name]) => name)).to.deep.equal(["SLUICE_APPROVE=facilitator", "SLUICE_RELAYER_KEY"]);
    // A value that looks like a key is refused when a file is rendered.
    expect(() => renderEnvFile({ file: ".env.x", title: "t", entries: [{ name: "SLUICE_X", value: `0x${"ab".repeat(32)}`, kind: "public", note: "n" }] })).to.throw(WireError, /looks like a key or a hash/);
    expect(() => renderEnvFile({ file: ".env.x", title: "t", entries: [{ name: "SLUICE_X", value: "ab".repeat(32), kind: "public", note: "n" }] })).to.throw(WireError, /looks like a key or a hash/);
    renderEnvFile({ file: ".env.x", title: "t", entries: [{ name: "SLUICE_X", value: ROUTER, kind: "public", note: "an address is not a key" }] });
  });

  it("prints a table of what is public, what is a secret you make and what you fill in, and shows a value only when it is public", () => {
    const table = describeWiring(wire(parseDeployment(record(), "mainnet"))).join("\n");
    expect(table).to.contain(`| SLUICE_ROUTER | .env.mainnet.facilitator | public | ${ROUTER} |`);
    expect(table).to.contain("| SLUICE_FACILITATOR_METRICS_TOKEN | .env.mainnet.facilitator | secret (you make it; never commit it) | (not written) |");
    expect(table).to.contain("| SLUICE_PAYEE | .env.mainnet.tool-server | yours to fill in | (empty: fill in) |");
    expect(table).to.contain("| SLUICE_RELAYER_KEY | (not in any file) | secret or deliberate |");
    expect(table).to.contain("| SLUICE_APPROVE=facilitator | (not in any file)");
  });

  it("makes the facilitator and the tool server refuse to start from the files as written, and start once you have filled them in", () => {
    const [facilitatorFile, toolsFile] = wire(parseDeployment(record(), "mainnet")).map((f) => parseEnvFile(renderEnvFile(f)));
    const secrets = { SLUICE_APPROVE: "facilitator", SLUICE_RELAYER_KEY: `0x${"07".repeat(32)}` };
    // As written, the queue's path is empty, so the facilitator refuses (a queue kept only in memory is lost when the process stops).
    expect(() => readEnv({ ...facilitatorFile, ...secrets })).to.throw(EnvError, /SLUICE_FACILITATOR_STATE/);
    const filled = readEnv({ ...facilitatorFile, ...secrets, SLUICE_FACILITATOR_STATE: "/data/queue.jsonl" });
    expect(filled).to.deep.include({ network: "mainnet", chainId: 1990, router: ROUTER });
    // Without the approval, even a finished file does not start it.
    expect(() => readEnv({ ...facilitatorFile, SLUICE_FACILITATOR_STATE: "/data/queue.jsonl", SLUICE_RELAYER_KEY: secrets.SLUICE_RELAYER_KEY })).to.throw(EnvError, /SLUICE_APPROVE/);
    // The tool server: no payee, no facilitator, and it refuses.
    expect(() => readToolServerEnv({ ...toolsFile })).to.throw(ToolServerEnvError, /SLUICE_PAYEE/);
    expect(() => readToolServerEnv({ ...toolsFile, SLUICE_PAYEE: VAULT })).to.throw(ToolServerEnvError, /SLUICE_FACILITATOR_URL/);
    const ready = readToolServerEnv({ ...toolsFile, SLUICE_PAYEE: VAULT, SLUICE_FACILITATOR_URL: "https://facilitator.example", SLUICE_TOOLS_CORS_ORIGINS: "https://sluice.example" });
    expect(ready).to.deep.include({ network: "mainnet", chainId: 1990, router: ROUTER, payee: VAULT });
    expect(ready.explorerUrl).to.equal("https://mainnet.qie.digital");
  });

  it("makes the web app say mainnet, link the explorer, and say what is missing until the three addresses are filled in", () => {
    const web = parseEnvFile(renderEnvFile(wire(parseDeployment(record(), "mainnet"))[2] as never));
    const asWritten = readConfig(web);
    expect(asWritten.network.id).to.equal("mainnet");
    expect(asWritten.network.realFunds).to.equal(true);
    expect(asWritten).to.deep.include({ chainId: 1990, router: ROUTER, vault: VAULT, contractsConfigured: true, fromBlock: 12_090_001, sessionCapUnits: 1_000_000 });
    expect(asWritten.problems).to.deep.equal([]);
    expect(liveMissing(asWritten)).to.deep.equal(["a facilitator (NEXT_PUBLIC_FACILITATOR_URL)", "a hosted tool server (NEXT_PUBLIC_TOOLS_URL)"]);
    const finished = readConfig({ ...web, NEXT_PUBLIC_FACILITATOR_URL: "https://facilitator.example", NEXT_PUBLIC_TOOLS_URL: "https://tools.example" });
    expect(liveMissing(finished)).to.deep.equal([]);
    expect(finished.network.explorerUrl).to.equal("https://mainnet.qie.digital");
    expect(explorerTxUrl(`0x${"cd".repeat(32)}`, finished.network)).to.equal(`https://mainnet.qie.digital/tx/0x${"cd".repeat(32)}`);
    expect(networkFor(1990).label).to.equal("QIE mainnet");
  });

  describe("the command", () => {
    const run = (argv: string[], cwd = dir) => {
      const lines: string[] = [];
      const code = wireMain(argv, { log: (l) => lines.push(l), cwd });
      return { code, text: lines.join("\n") };
    };

    it("writes the three files next to deployment.json, prints the table, and shows no secret", () => {
      writeFileSync(join(dir, "deployment.json"), record());
      const r = run(["--network", "mainnet"]);
      expect(r.code).to.equal(0);
      for (const f of [".env.mainnet.facilitator", ".env.mainnet.tool-server", ".env.mainnet.web"]) expect(existsSync(join(dir, f)), f).to.equal(true);
      expect(r.text).to.contain("They hold no key, and they are git-ignored");
      expect(r.text).to.contain(`| SLUICE_ROUTER | .env.mainnet.facilitator | public | ${ROUTER} |`);
      expect(r.text).to.not.match(/0x[0-9a-fA-F]{64}/);
      expect(readFileSync(join(dir, ".env.mainnet.web"), "utf8")).to.contain(`NEXT_PUBLIC_ROUTER_ADDRESS=${ROUTER}`);
    });

    it("refuses without --network, for the other network, with no deployment file, and over files that are there unless --force", () => {
      writeFileSync(join(dir, "deployment.json"), record());
      expect(run([]).text).to.contain("give --network mainnet or --network testnet");
      expect(run(["--network", "mainnet2"]).code).to.equal(1);
      expect(run(["--network", "testnet"]).text).to.contain("is for \"mainnet\", not testnet");
      expect(run(["--network", "mainnet", "--deployment", "nope.json"]).text).to.contain("nope.json does not exist");
      expect(run(["--network", "mainnet", "--bogus"]).text).to.contain("unknown option --bogus");
      expect(run(["--network"]).text).to.contain("--network needs a value");
      expect(run(["--network", "mainnet"]).code).to.equal(0);
      writeFileSync(join(dir, ".env.mainnet.web"), "NEXT_PUBLIC_TOOLS_URL=https://tools.example\n");
      const again = run(["--network", "mainnet"]);
      expect(again.code).to.equal(1);
      expect(again.text).to.contain("already exist");
      expect(readFileSync(join(dir, ".env.mainnet.web"), "utf8")).to.equal("NEXT_PUBLIC_TOOLS_URL=https://tools.example\n");
      expect(run(["--network", "mainnet", "--force"]).code).to.equal(0);
      expect(readFileSync(join(dir, ".env.mainnet.web"), "utf8")).to.contain("NEXT_PUBLIC_CHAIN_ID=1990");
    });

    it("refuses a deployment file for the wrong network or the wrong token before it writes anything", () => {
      writeFileSync(join(dir, "deployment.json"), record({ token: ROUTER }));
      const r = run(["--network", "mainnet"]);
      expect(r.code).to.equal(1);
      expect(r.text).to.contain("token is not QUSDC");
      expect(existsSync(join(dir, ".env.mainnet.web"))).to.equal(false);
    });

    it("can write to another folder", () => {
      writeFileSync(join(dir, "deployment.json"), record());
      expect(run(["--network", "mainnet", "--out", "settings"]).code).to.equal(0);
      expect(existsSync(join(dir, "settings", ".env.mainnet.facilitator"))).to.equal(true);
    });
  });
});

// ------------------------------------------------------------------------------------------------------- fail closed

describe("Mainnet with no router: every program says so and stops", () => {
  it("the facilitator and the tool server refuse to start without SLUICE_ROUTER, and the web app says the contracts are not configured", () => {
    const facilitator = { SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "facilitator", SLUICE_MAX_QIE: "0.5", SLUICE_RELAYER_KEY: `0x${"07".repeat(32)}`, SLUICE_FACILITATOR_STATE: "/data/q.jsonl" };
    expect(() => readEnv(facilitator)).to.throw(EnvError, /SLUICE_ROUTER must be the router's address/);
    expect(() => readEnv({ ...facilitator, SLUICE_ROUTER: "0x12" })).to.throw(EnvError, /SLUICE_ROUTER must be the router's address/);
    const tools = { SLUICE_NETWORK: "mainnet", SLUICE_PAYEE: getAddress(`0x${"bb".repeat(20)}`), SLUICE_FACILITATOR_URL: "https://facilitator.example" };
    expect(() => readToolServerEnv(tools)).to.throw(ToolServerEnvError, /refusing to start on mainnet: SLUICE_ROUTER must be the router's address/);
    const web = readConfig({ NEXT_PUBLIC_CHAIN_ID: "1990" });
    expect(web.network.id).to.equal("mainnet");
    expect(web.contractsConfigured).to.equal(false);
    expect(web.router).to.equal(null);
    expect(liveMissing(web)[0]).to.contain("the router and vault addresses");
  });

  it("refuses to start against a node that is on another chain, whichever RPC was named", async () => {
    // A tiny node that says it is chain 1983, for the two services that are told they are on mainnet.
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const parse = JSON.parse(body) as { id: number; method: string } | Array<{ id: number; method: string }>;
        const one = (m: { id: number; method: string }) => (m.method === "eth_chainId" ? { jsonrpc: "2.0", id: m.id, result: "0x7bf" } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no" } });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(parse) ? parse.map(one) : one(parse)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "sluice-chain-"));
    try {
      const env = readEnv({ SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "facilitator", SLUICE_MAX_QIE: "0.5", SLUICE_ROUTER: getAddress(`0x${"aa".repeat(20)}`), SLUICE_RELAYER_KEY: `0x${"07".repeat(32)}`, SLUICE_FACILITATOR_STATE: join(dir, "q.jsonl"), SLUICE_RPC_URL: url, SLUICE_FACILITATOR_PORT: "0" });
      let error: unknown;
      try {
        await startFacilitator(env);
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(EnvError);
      expect((error as Error).message).to.equal("refusing to start: the RPC is on chain 1983, but mainnet is chain 1990");
      expect(existsSync(join(dir, "q.jsonl")), "nothing was opened or written").to.equal(false);

      const toolEnv = readToolServerEnv({ SLUICE_NETWORK: "mainnet", SLUICE_ROUTER: getAddress(`0x${"aa".repeat(20)}`), SLUICE_PAYEE: getAddress(`0x${"bb".repeat(20)}`), SLUICE_FACILITATOR_URL: "http://127.0.0.1:1", SLUICE_RPC_URL: url, SLUICE_TOOLS_PORT: "0" });
      let toolError: unknown;
      try {
        await createToolServer({ env: toolEnv });
      } catch (err) {
        toolError = err;
      }
      expect(toolError).to.be.instanceOf(ToolServerEnvError);
      expect((toolError as Error).message).to.equal("refusing to start: the RPC is on chain 1983, but mainnet is chain 1990");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------------- a fork run's rows

describe("The rows a fork run records in a copy of the evidence file", () => {
  // The evidence file as it was before any row was recorded, so a row recorded in it since does not change what these tests are about.
  const evidence = (): string => evidenceTemplate(readFileSync(ROOT_FILE("docs", "EVIDENCE.md"), "utf8")).replace(/\r\n/g, "\n");
  const row = (extra: Record<string, string> = {}) => ({
    network: "fork" as const, date: "2026-11-22T10:00:00Z", event: "Deposited", hash: `0x${"cd".repeat(32)}`, block: "12090001", contract: getAddress(`0x${"aa".repeat(20)}`), amount: "0.300000",
    who: getAddress(`0x${"bb".repeat(20)}`), claim: "deposit", recheck: "pnpm evidence:check --hash 0x…", ...extra,
  });

  it("reads back what the recorder wrote under the Fork heading, and nothing from the real tables", () => {
    const text = appendRows(evidence(), [row() as never, row({ event: "Withdrawn", claim: "withdraw" }) as never]);
    const rows = parseForkRows(text);
    expect(rows.map((r) => [r.network, r.event, r.claim, r.amount])).to.deep.equal([["fork", "Deposited", "deposit", "0.300000"], ["fork", "Withdrawn", "withdraw", "0.300000"]]);
    expect(rows[0]).to.deep.include({ hash: `0x${"cd".repeat(32)}`, block: "12090001" });
    expect(parseForkRows(evidence())).to.deep.equal([]);
  });

  it("refuses a row in the Fork table that says it is from another network, a table with other columns, and a short row", () => {
    const text = appendRows(evidence(), [row() as never]);
    expect(() => parseForkRows(text.replace(/\| fork \| deposit \|/, "| mainnet | deposit |"))).to.throw(RecordError, /a row labelled "mainnet" is in the Fork table/);
    // The first table with these columns is the Mainnet one, so the change is made inside the Fork section.
    const at = text.indexOf("## Fork");
    const otherColumns = text.slice(0, at) + text.slice(at).replace("| Date (UTC) | Event |", "| Date | Event |");
    expect(() => parseForkRows(otherColumns)).to.throw(RecordError, /does not have the columns the recorder writes/);
    expect(() => parseForkRows(text.replace(/(\| deposit \| `[^`]*` \|)/, "$1 extra |"))).to.throw(RecordError, /malformed fork row/);
  });
});
