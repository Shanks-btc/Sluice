// What docs/RISKS.md says about QUSDC, read again from the chain with read-only calls: who holds its roles, whether the vault role can burn,
// the supply, and whether the token can be upgraded. It sends nothing and holds no key. Every call is made at one block, so the answers
// are about one moment, and the block is reported.
//
// "Can burn" is shown by asking the node to run `burn(victim, 1)` as the vault role's holder (an eth_call: the node runs the call on its
// copy of the state and throws the result away), and to run the same call as an address with no role, which must be refused. The second
// call is the control: without it, a call that succeeds for everyone would read as "the vault can burn".
import { AbiCoder, Interface, getAddress, toQuantity } from "ethers";
import { QIEDEX } from "../examples/paid-tools/src/dexQuote";
import { RpcRefused } from "./readrpc";
import type { Rpc } from "./evidence";
import { QUSDC_ADDRESS } from "./guard";
import { formatQusdc } from "./units";

/** The facts as docs/RISKS.md states them. A test holds these to that document. */
export const RISKS_FACTS = {
  token: getAddress(QUSDC_ADDRESS),
  vaultRoleHolder: getAddress("0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45"),
  adminHolder: getAddress("0xe1acec6312eb701D4A14De700CCec8DeE17a8D28"),
} as const;

/** The EIP-1967 slots a proxy keeps its implementation, admin and beacon in. All empty means the token is not a proxy. */
export const EIP1967_SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;

/** Every method this module may call. */
export const FACTS_READ_ONLY_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getStorageAt"]);

const token = new Interface([
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
const factory = new Interface(["function getPair(address,address) view returns (address)"]);
const coder = AbiCoder.defaultAbiCoder();

/** A call that may be refused. `ok` is false when the node ran it and it reverted; a transport failure is thrown. */
type Answer = { ok: true; data: string } | { ok: false };

export type Capability = "yes" | "no" | "unknown";

export type QusdcFacts = {
  /** The block every call below was made at. */
  block: number;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** True if any EIP-1967 slot holds something. */
  upgradeable: boolean;
  vaultRoleHolderHasVaultRole: boolean;
  vaultRoleHolderIsContract: boolean;
  adminHolderHasAdminRole: boolean;
  /** The admin account holds VAULT_ROLE itself (RISKS.md says it can grant it, not that it holds it). */
  adminHolderHasVaultRole: boolean;
  /** Members of each role, when the token lists them (AccessControlEnumerable); undefined when it does not. */
  vaultRoleMembers?: string[];
  adminRoleMembers?: string[];
  /** Does a call to burn made as the vault role's holder succeed, and one made as an address with no role. */
  vaultCanBurn: Capability;
  strangerCanBurn: Capability;
  vaultCanMint: Capability;
  strangerCanMint: Capability;
  /** The account the burn was tried on: a holder with a balance, so a refusal can only be about the role. */
  burnVictim?: string;
};

async function ask(rpc: Rpc, call: { to: string; data: string; from?: string }, block: string): Promise<Answer> {
  try {
    const out = await rpc("eth_call", [call, block]);
    return typeof out === "string" ? { ok: true, data: out } : { ok: false };
  } catch (err) {
    if (err instanceof RpcRefused) return { ok: false };
    throw err;
  }
}

async function view<T>(rpc: Rpc, fn: string, args: unknown[], block: string): Promise<T | undefined> {
  const out = await ask(rpc, { to: RISKS_FACTS.token, data: token.encodeFunctionData(fn, args) }, block);
  if (!out.ok || out.data === "0x") return undefined;
  return token.decodeFunctionResult(fn, out.data)[0] as T;
}

/** Reads the facts at the latest block. Throws only when the chain cannot be read at all; a call the node refuses is recorded as such. */
export async function readQusdcFacts(rpc: Rpc): Promise<QusdcFacts> {
  const block = Number(BigInt(String(await rpc("eth_blockNumber", []))));
  const at = toQuantity(block);
  const text = async (fn: string): Promise<string> => (await view<string>(rpc, fn, [], at)) ?? "";
  const decimals = Number((await view<bigint>(rpc, "decimals", [], at)) ?? -1n);
  const totalSupply = (await view<bigint>(rpc, "totalSupply", [], at)) ?? 0n;
  const vaultRole = await view<string>(rpc, "VAULT_ROLE", [], at);
  const adminRole = await view<string>(rpc, "DEFAULT_ADMIN_ROLE", [], at);
  const has = async (role: string | undefined, who: string): Promise<boolean> => (role ? ((await view<boolean>(rpc, "hasRole", [role, who], at)) ?? false) : false);

  const slots = await Promise.all(Object.values(EIP1967_SLOTS).map(async (slot) => String(await rpc("eth_getStorageAt", [RISKS_FACTS.token, slot, at]))));
  const upgradeable = slots.some((s) => !/^0x0*$/.test(s));
  const vaultCode = String(await rpc("eth_getCode", [RISKS_FACTS.vaultRoleHolder, at]));

  const members = async (role: string | undefined): Promise<string[] | undefined> => {
    if (!role) return undefined;
    const count = await view<bigint>(rpc, "getRoleMemberCount", [role], at);
    if (count === undefined || count > 20n) return undefined;
    const out: string[] = [];
    for (let i = 0n; i < count; i++) {
      const m = await view<string>(rpc, "getRoleMember", [role, i], at);
      if (m) out.push(getAddress(m));
    }
    return out;
  };

  // A holder to burn from: the QUSDC / WQIE pool, which holds a large balance. Its balance must cover the amount tried, so that a refusal
  // can only be about the role.
  let victim: string | undefined;
  const pairOut = await ask(rpc, { to: QIEDEX.factory, data: factory.encodeFunctionData("getPair", [QIEDEX.qusdc, QIEDEX.wqie]) }, at);
  if (pairOut.ok && pairOut.data !== "0x") {
    const pair = getAddress(String(coder.decode(["address"], pairOut.data)[0]));
    const held = await view<bigint>(rpc, "balanceOf", [pair], at);
    if (!/^0x0{40}$/.test(pair) && held !== undefined && held >= 1n) victim = pair;
  }
  const stranger = getAddress("0x0000000000000000000000000000000000000001");
  const tryAs = async (from: string, fn: "burn" | "mint", to: string | undefined): Promise<Capability> => {
    if (!to) return "unknown";
    const out = await ask(rpc, { from, to: RISKS_FACTS.token, data: token.encodeFunctionData(fn, [to, 1n]) }, at);
    return out.ok ? "yes" : "no";
  };

  const vaultMembers = await members(vaultRole);
  const adminMembers = await members(adminRole);
  return {
    block,
    name: await text("name"),
    symbol: await text("symbol"),
    decimals,
    totalSupply,
    upgradeable,
    vaultRoleHolderHasVaultRole: await has(vaultRole, RISKS_FACTS.vaultRoleHolder),
    vaultRoleHolderIsContract: vaultCode !== "0x",
    adminHolderHasAdminRole: await has(adminRole, RISKS_FACTS.adminHolder),
    adminHolderHasVaultRole: await has(vaultRole, RISKS_FACTS.adminHolder),
    ...(vaultMembers ? { vaultRoleMembers: vaultMembers } : {}),
    ...(adminMembers ? { adminRoleMembers: adminMembers } : {}),
    vaultCanBurn: await tryAs(RISKS_FACTS.vaultRoleHolder, "burn", victim),
    strangerCanBurn: await tryAs(stranger, "burn", victim),
    vaultCanMint: await tryAs(RISKS_FACTS.vaultRoleHolder, "mint", RISKS_FACTS.adminHolder),
    strangerCanMint: await tryAs(stranger, "mint", RISKS_FACTS.adminHolder),
    ...(victim ? { burnVictim: victim } : {}),
  };
}

export type Comparison = { matches: boolean; differences: string[] };

/** What differs from docs/RISKS.md. A fact that is better than the document says is still a difference: the document must be corrected. */
export function compareWithRisks(f: QusdcFacts): Comparison {
  const d: string[] = [];
  if (f.name !== "QUSDC" || f.symbol !== "QUSDC") d.push(`the token is named ${JSON.stringify(f.name)} and ${JSON.stringify(f.symbol)}, not QUSDC`);
  if (f.decimals !== 6) d.push(`it has ${f.decimals} decimals, not 6`);
  if (f.upgradeable) d.push("an EIP-1967 slot is no longer empty, so the token may now be upgradeable (RISKS.md says it is not)");
  if (!f.vaultRoleHolderHasVaultRole) d.push(`${RISKS_FACTS.vaultRoleHolder} no longer holds VAULT_ROLE`);
  if (!f.vaultRoleHolderIsContract) d.push(`${RISKS_FACTS.vaultRoleHolder} is no longer a contract (RISKS.md says it is)`);
  if (!f.adminHolderHasAdminRole) d.push(`${RISKS_FACTS.adminHolder} no longer holds DEFAULT_ADMIN_ROLE`);
  if (f.vaultRoleMembers && f.vaultRoleMembers.length !== 1) d.push(`VAULT_ROLE has ${f.vaultRoleMembers.length} holders: ${f.vaultRoleMembers.join(", ")}`);
  if (f.adminRoleMembers && f.adminRoleMembers.length !== 1) d.push(`DEFAULT_ADMIN_ROLE has ${f.adminRoleMembers.length} holders: ${f.adminRoleMembers.join(", ")}`);
  if (f.vaultCanBurn === "no") d.push("the vault role's holder can no longer burn (RISKS.md says VAULT_ROLE allows burn)");
  if (f.strangerCanBurn === "yes") d.push("an address with no role can burn: the control call was not refused, so the burn result above cannot be read as a role check");
  return { matches: d.length === 0, differences: d };
}

const word = (c: Capability): string => (c === "yes" ? "yes, the node ran it" : c === "no" ? "no, the node refused it" : "not tried (no holder to burn from)");

/** The lines to print: a table of what was read, then whether it matches docs/RISKS.md. */
export function formatFacts(f: QusdcFacts, c: Comparison): string[] {
  const lines = [
    `QUSDC ${RISKS_FACTS.token}, read at block ${f.block} with read-only calls`,
    `| Fact | Value |`,
    `| --- | --- |`,
    `| Name, symbol, decimals | ${f.name}, ${f.symbol}, ${f.decimals} |`,
    `| Total supply | ${formatQusdc(f.totalSupply)} QUSDC (${f.totalSupply} units) |`,
    `| Upgradeable (an EIP-1967 slot is set) | ${f.upgradeable ? "yes" : "no: all three slots are empty"} |`,
    `| VAULT_ROLE held by ${RISKS_FACTS.vaultRoleHolder} | ${f.vaultRoleHolderHasVaultRole ? "yes" : "no"}; that address is ${f.vaultRoleHolderIsContract ? "a contract" : "not a contract"} |`,
    `| DEFAULT_ADMIN_ROLE held by ${RISKS_FACTS.adminHolder} | ${f.adminHolderHasAdminRole ? "yes" : "no"} |`,
    `| That admin account also holds VAULT_ROLE | ${f.adminHolderHasVaultRole ? "yes" : "no"} |`,
    `| VAULT_ROLE holders listed by the token | ${f.vaultRoleMembers ? f.vaultRoleMembers.join(", ") || "none" : "not listed by this token"} |`,
    `| DEFAULT_ADMIN_ROLE holders listed by the token | ${f.adminRoleMembers ? f.adminRoleMembers.join(", ") || "none" : "not listed by this token"} |`,
    `| burn(holder, 1) run as the vault role's holder | ${word(f.vaultCanBurn)}${f.burnVictim ? ` (on ${f.burnVictim}, the QUSDC/WQIE pool)` : ""} |`,
    `| The same call run as an address with no role (the control) | ${word(f.strangerCanBurn)} |`,
    `| mint(address, 1) run as the vault role's holder | ${word(f.vaultCanMint)} |`,
    `| The same call run as an address with no role (the control) | ${word(f.strangerCanMint)} |`,
    "",
  ];
  lines.push(c.matches ? "These match what docs/RISKS.md says." : `These differ from docs/RISKS.md: ${c.differences.join("; ")}`);
  return lines;
}
