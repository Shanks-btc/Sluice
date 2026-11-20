// token_risk_check: what the admin of an ERC-20 on QIE can do to its holders, read from the chain.
//
// From read-only RPC it learns: whether the token is a proxy (so its code can be replaced), who owns it, which roles it
// has and who holds them, which burn, mint, pause, blacklist and fee functions its code contains, and WHO CAN CALL them
// right now, by simulating each call from each holder. The role holders' list comes from the explorer's log index and
// every entry is confirmed on-chain with hasRole before it is reported.
//
// This is how the QUSDC finding in docs/RISKS.md can be reproduced: its VAULT_ROLE holder can burn any holder's balance,
// and the account that administers that role can grant it to itself.
//
// It is a set of read-only checks, not a security review, and it says what it cannot see.
import { AbiCoder, Interface, ZeroHash, getAddress, id } from "ethers";
import { codeHash, detectProxy, pushedSelectors, selectorOf } from "./bytecode";
import type { ProxyInfo } from "./bytecode";
import { tryCall } from "./rpc";
import type { ExplorerGet, Rpc } from "./rpc";

const coder = AbiCoder.defaultAbiCoder();
const accessControl = new Interface([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
]);

const ROLE_GRANTED = id("RoleGranted(bytes32,address,address)");
const ROLE_REVOKED = id("RoleRevoked(bytes32,address,address)");

/** Role getters the check will call when the code contains their selector. */
const ROLE_GETTERS = [
  "DEFAULT_ADMIN_ROLE",
  "VAULT_ROLE",
  "MINTER_ROLE",
  "BURNER_ROLE",
  "PAUSER_ROLE",
  "ADMIN_ROLE",
  "OPERATOR_ROLE",
  "UPGRADER_ROLE",
  "BLACKLISTER_ROLE",
  "MANAGER_ROLE",
  "GOVERNANCE_ROLE",
] as const;

const CATALOG = {
  burnFromAnyHolder: ["burn(address,uint256)", "burnFrom(address,uint256)"],
  burnOwn: ["burn(uint256)"],
  mint: ["mint(address,uint256)"],
  pause: ["pause()", "unpause()"],
  blacklist: ["blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "blockAccount(address)"],
  fees: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxFee(uint256)", "excludeFromFee(address)"],
  upgrade: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"],
  ownership: ["owner()", "transferOwnership(address)", "renounceOwnership()"],
  accessControl: ["hasRole(bytes32,address)", "grantRole(bytes32,address)", "revokeRole(bytes32,address)", "getRoleAdmin(bytes32)"],
} as const;

/** An address nobody controls, used to check that a call fails for a caller with no authority. */
const CONTROL_CALLER = "0x000000000000000000000000000000000000c0DE";
const FALLBACK_VICTIM = "0x0000000000000000000000000000000000000001";

export type Severity = "high" | "medium" | "info";
export type Flag = { severity: Severity; code: string; text: string };
export type Holder = { address: string; kind: "EOA" | "contract" };
export type RoleInfo = { id: string; name?: string; adminRole?: string; adminRoleName?: string; holders: Holder[] };

export type TokenRisk = {
  address: string;
  isContract: boolean;
  codeSizeBytes: number;
  codeHash?: string;
  token?: { name?: string; symbol?: string; decimals?: number; totalSupplyUnits?: string };
  proxy?: ProxyInfo;
  analyzedCode?: string;
  functionsFound: Record<string, string[]>;
  owner?: { address: string; kind: "EOA" | "contract" | "renounced" };
  accessControl: { present: boolean; roles: RoleInfo[]; holdersSource: "explorer-logs" | "unavailable" | "not-applicable"; note?: string };
  burn: { simulation?: { victim: string; amount: string }; canBurnNow: Array<{ address: string; kind: string; roles: string[]; via: string }>; viaRoleAdmin: Array<{ role: string; adminRole: string; adminHolders: Holder[] }>; anyoneCanCall?: string[] };
  mint: { canMintNow: Array<{ address: string; kind: string; roles: string[]; via: string }>; viaRoleAdmin: Array<{ role: string; adminRole: string; adminHolders: Holder[] }>; anyoneCanCall?: boolean };
  flags: Flag[];
  limits: string[];
  disclaimer: string;
};

export type TokenRiskDeps = { rpc: Rpc; explorer?: ExplorerGet };

const decodeString = (hex: string | undefined): string | undefined => {
  if (!hex) return undefined;
  try {
    return coder.decode(["string"], hex)[0] as string;
  } catch {
    return undefined;
  }
};
const decodeUint = (hex: string | undefined): bigint | undefined => {
  if (!hex) return undefined;
  try {
    return coder.decode(["uint256"], hex)[0] as bigint;
  } catch {
    return undefined;
  }
};
const decodeAddress = (hex: string | undefined): string | undefined => {
  if (!hex) return undefined;
  try {
    return getAddress(coder.decode(["address"], hex)[0] as string);
  } catch {
    return undefined;
  }
};

async function kindOf(rpc: Rpc, address: string): Promise<"EOA" | "contract"> {
  const code = await rpc.getCode(address);
  return code === "0x" ? "EOA" : "contract";
}

export async function tokenRiskCheck(deps: TokenRiskDeps, rawAddress: string): Promise<TokenRisk> {
  const { rpc, explorer } = deps;
  const address = getAddress(rawAddress);
  const disclaimer =
    "Read-only checks of public chain data. This is not a security review. A check that finds nothing does not show that nothing is there.";
  const empty = {
    functionsFound: {},
    accessControl: { present: false, roles: [], holdersSource: "not-applicable" as const },
    burn: { canBurnNow: [], viaRoleAdmin: [] },
    mint: { canMintNow: [], viaRoleAdmin: [] },
    limits: [],
    disclaimer,
  };
  const code = await rpc.getCode(address);
  if (code === "0x") {
    return {
      address,
      isContract: false,
      codeSizeBytes: 0,
      ...empty,
      flags: [{ severity: "high", code: "not_a_contract", text: "There is no contract code at this address, so it is not a token." }],
    };
  }

  const [name, symbol, decimals, supply] = await Promise.all([
    tryCall(rpc, address, selectorOf("name()")),
    tryCall(rpc, address, selectorOf("symbol()")),
    tryCall(rpc, address, selectorOf("decimals()")),
    tryCall(rpc, address, selectorOf("totalSupply()")),
  ]);
  const token = {
    name: decodeString(name),
    symbol: decodeString(symbol),
    decimals: decodeUint(decimals) === undefined ? undefined : Number(decodeUint(decimals)),
    totalSupplyUnits: decodeUint(supply)?.toString(),
  };

  // Proxy: the code that runs may be somewhere else, and may change.
  const proxy = await detectProxy(rpc, address, code);
  let analyzed = address;
  let analyzedCode = code;
  if (proxy.isProxy) {
    let impl = proxy.implementation;
    if (!impl && proxy.beacon) impl = decodeAddress(await tryCall(rpc, proxy.beacon, selectorOf("implementation()")));
    if (impl) {
      analyzed = impl;
      analyzedCode = await rpc.getCode(impl);
    }
  }
  const selectors = pushedSelectors(analyzedCode);
  const has = (signature: string) => selectors.has(selectorOf(signature));
  const functionsFound: Record<string, string[]> = {};
  for (const [group, signatures] of Object.entries(CATALOG)) {
    const present = signatures.filter(has);
    if (present.length) functionsFound[group] = [...present];
  }

  const flags: Flag[] = [];
  const limits = [
    "Functions are found by the 4-byte selectors in the code, from a fixed list. A function under another name, or one reached some other way, is not seen.",
    "Who can call burn or mint is tested by simulating the call from each known holder. A call that needs more than a role (a delay, a second approval) can fail the simulation while still being possible.",
    "Nothing here covers price, liquidity, how concentrated the holders are, or anything done off-chain.",
  ];

  // Owner
  let owner: TokenRisk["owner"];
  if (functionsFound.ownership?.includes("owner()")) {
    const o = decodeAddress(await tryCall(rpc, address, selectorOf("owner()")));
    if (o) {
      owner = /^0x0{40}$/.test(o) ? { address: o, kind: "renounced" } : { address: o, kind: await kindOf(rpc, o) };
    }
  }

  // Roles
  const ac: TokenRisk["accessControl"] = { present: Boolean(functionsFound.accessControl?.includes("hasRole(bytes32,address)")), roles: [], holdersSource: "not-applicable" };
  const roleNames = new Map<string, string>([[ZeroHash, "DEFAULT_ADMIN_ROLE"]]);
  const holdersByRole = new Map<string, Set<string>>();
  if (ac.present) {
    for (const getter of ROLE_GETTERS) {
      if (!has(`${getter}()`)) continue;
      const out = await tryCall(rpc, address, selectorOf(`${getter}()`));
      if (out && out.length === 66) roleNames.set(out.toLowerCase(), getter);
    }
    if (!explorer) {
      ac.holdersSource = "unavailable";
      ac.note = "No explorer was available, so role holders could not be listed.";
    } else {
      try {
        const events: Array<{ topic: string; granted: boolean }> = [
          { topic: ROLE_GRANTED, granted: true },
          { topic: ROLE_REVOKED, granted: false },
        ];
        const candidates = new Set<string>();
        for (const e of events) {
          const res = await explorer(`/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${address}&topic0=${e.topic}`);
          const body = res.json as { result?: Array<{ topics: string[] }> } | null;
          if (res.status !== 200 || !body || !Array.isArray(body.result)) throw new Error("explorer log query failed");
          if (body.result.length >= 1000) ac.note = "The explorer returned 1,000 role events, its limit: older ones may be missing.";
          for (const log of body.result) {
            const role = log.topics?.[1];
            const account = log.topics?.[2];
            if (role && account) candidates.add(`${role.toLowerCase()}|0x${account.slice(26)}`);
          }
        }
        for (const entry of candidates) {
          const [role, account] = entry.split("|") as [string, string];
          const holds = decodeUint(await tryCall(rpc, address, accessControl.encodeFunctionData("hasRole", [role, account])));
          if (holds === 1n) {
            const set = holdersByRole.get(role) ?? new Set<string>();
            set.add(getAddress(account));
            holdersByRole.set(role, set);
          }
        }
        ac.holdersSource = "explorer-logs";
      } catch {
        ac.holdersSource = "unavailable";
        ac.note = "The explorer's log index could not be read, so role holders could not be listed.";
      }
    }
    for (const [role, holders] of holdersByRole) {
      const adminWord = await tryCall(rpc, address, accessControl.encodeFunctionData("getRoleAdmin", [role]));
      const adminRole = adminWord?.length === 66 ? adminWord.toLowerCase() : undefined;
      ac.roles.push({
        id: role,
        name: roleNames.get(role),
        adminRole,
        adminRoleName: adminRole ? roleNames.get(adminRole) ?? (adminRole === ZeroHash ? "DEFAULT_ADMIN_ROLE" : undefined) : undefined,
        holders: await Promise.all([...holders].map(async (a) => ({ address: a, kind: await kindOf(rpc, a) }))),
      });
    }
  }
  const rolesHeldBy = (who: string) => ac.roles.filter((r) => r.holders.some((h) => h.address === who)).map((r) => r.name ?? r.id);

  // Who can burn or mint right now, by simulation.
  const callers = new Map<string, { kind: string; via: string }>();
  for (const r of ac.roles) for (const h of r.holders) callers.set(h.address, { kind: h.kind, via: `holds ${r.name ?? r.id}` });
  if (owner && owner.kind !== "renounced") callers.set(owner.address, { kind: owner.kind, via: "is the owner" });

  let victim = FALLBACK_VICTIM;
  let simAmount = 0n;
  if (explorer) {
    try {
      const res = await explorer(`/api/v2/tokens/${address}/holders`);
      const first = (res.json as { items?: Array<{ address?: { hash?: string }; value?: string }> } | null)?.items?.find((i) => i.address?.hash && BigInt(i.value ?? "0") > 0n);
      if (res.status === 200 && first?.address?.hash) {
        victim = getAddress(first.address.hash);
        simAmount = 1n;
      }
    } catch {
      // keep the fallback: simulate with an amount of zero
    }
  }

  const simulate = async (signature: string): Promise<{ any?: boolean; by: Array<{ address: string; kind: string; roles: string[]; via: string }> }> => {
    const data = Interface.from([`function ${signature}`]).encodeFunctionData(signature.split("(")[0] as string, [victim, simAmount]);
    // A void function returns no data on success, so success means "did not revert", not "returned something".
    if (await controlSucceeds(rpc, address, data, CONTROL_CALLER)) return { any: true, by: [] };
    const by: Array<{ address: string; kind: string; roles: string[]; via: string }> = [];
    for (const [who, info] of callers) {
      if (await controlSucceeds(rpc, address, data, who)) by.push({ address: who, kind: info.kind, roles: rolesHeldBy(who), via: info.via });
    }
    return { by };
  };
  const escalation = (by: Array<{ address: string }>) => {
    const out: Array<{ role: string; adminRole: string; adminHolders: Holder[] }> = [];
    const direct = new Set(by.map((b) => b.address));
    for (const r of ac.roles) {
      if (!r.holders.some((h) => direct.has(h.address)) || !r.adminRole) continue;
      const admin = ac.roles.find((x) => x.id === r.adminRole);
      const adminHolders = (admin?.holders ?? []).filter((h) => !direct.has(h.address));
      if (adminHolders.length) out.push({ role: r.name ?? r.id, adminRole: r.adminRoleName ?? r.adminRole, adminHolders });
    }
    return out;
  };

  const burn: TokenRisk["burn"] = { canBurnNow: [], viaRoleAdmin: [] };
  const burnFns = functionsFound.burnFromAnyHolder ?? [];
  if (burnFns.length) {
    burn.simulation = { victim, amount: simAmount.toString() };
    const anyone: string[] = [];
    for (const fn of burnFns) {
      const r = await simulate(fn);
      if (r.any) anyone.push(fn);
      for (const b of r.by) if (!burn.canBurnNow.some((x) => x.address === b.address)) burn.canBurnNow.push(b);
    }
    if (anyone.length) burn.anyoneCanCall = anyone;
    burn.viaRoleAdmin = escalation(burn.canBurnNow);
  }
  const mint: TokenRisk["mint"] = { canMintNow: [], viaRoleAdmin: [] };
  if (functionsFound.mint?.length) {
    const r = await simulate("mint(address,uint256)");
    if (r.any) mint.anyoneCanCall = true;
    mint.canMintNow = r.by;
    mint.viaRoleAdmin = escalation(mint.canMintNow);
  }

  // Flags
  if (proxy.isProxy) {
    flags.push({
      severity: "high",
      code: "upgradeable_proxy",
      text: `This is a ${proxy.kind} proxy. Whoever controls ${proxy.admin ? `its admin (${proxy.admin})` : "the upgrade path"} can replace the token's code, so nothing below is permanent.`,
    });
  }
  if (burn.canBurnNow.length) {
    flags.push({
      severity: "high",
      code: "admin_can_burn_holders",
      text: `${burn.canBurnNow.map((b) => `${b.address} (${b.kind}, ${b.via})`).join("; ")} can burn another holder's balance.`,
    });
  }
  for (const v of burn.viaRoleAdmin) {
    flags.push({
      severity: "high",
      code: "role_admin_can_grant_burn",
      text: `${v.adminHolders.map((h) => `${h.address} (${h.kind})`).join(", ")} administers ${v.role} (through ${v.adminRole}) and can grant that burn power to itself.`,
    });
  }
  if (burn.anyoneCanCall?.length) {
    flags.push({ severity: "info", code: "burn_open_call", text: `A simulated ${burn.anyoneCanCall.join(", ")} succeeded from an address with no role. Either anyone can burn or the call is a no-op at this amount.` });
  }
  if (mint.canMintNow.length || mint.anyoneCanCall) {
    flags.push({ severity: "high", code: "supply_can_grow", text: mint.anyoneCanCall ? "A simulated mint succeeded from an address with no role." : `${mint.canMintNow.map((m) => `${m.address} (${m.kind}, ${m.via})`).join("; ")} can mint new tokens.` });
  } else if (functionsFound.mint?.length) {
    flags.push({ severity: "medium", code: "mint_function", text: "The code has a mint function. Nobody known could call it in simulation, but holders of roles not found here might." });
  }
  if (owner && owner.kind === "EOA") flags.push({ severity: "medium", code: "owner_is_eoa", text: `The owner (${owner.address}) is an ordinary key-controlled account, not a contract.` });
  if (functionsFound.pause) flags.push({ severity: "medium", code: "pausable", text: "The code has pause functions: transfers may be stoppable." });
  if (functionsFound.blacklist) flags.push({ severity: "medium", code: "blacklist", text: "The code has a blacklist function: specific accounts may be blockable." });
  if (functionsFound.fees) flags.push({ severity: "medium", code: "adjustable_fees", text: "The code has fee setters: transfer fees may be changeable." });
  if (ac.present && ac.holdersSource === "unavailable") flags.push({ severity: "medium", code: "roles_not_listed", text: ac.note ?? "Role holders could not be listed." });
  if (flags.length === 0) {
    flags.push({ severity: "info", code: "nothing_found", text: "No function from the checked list was found. This is not a clean bill of health: see limits." });
  }

  return {
    address,
    isContract: true,
    codeSizeBytes: (code.length - 2) / 2,
    codeHash: codeHash(code),
    token,
    proxy,
    analyzedCode: analyzed,
    functionsFound,
    ...(owner ? { owner } : {}),
    accessControl: ac,
    burn,
    mint,
    flags,
    limits,
    disclaimer,
  };
}

/** True when an eth_call from `from` does not revert. */
async function controlSucceeds(rpc: Rpc, to: string, data: string, from: string = CONTROL_CALLER): Promise<boolean> {
  try {
    await rpc.call(to, data, from);
    return true;
  } catch {
    return false;
  }
}
