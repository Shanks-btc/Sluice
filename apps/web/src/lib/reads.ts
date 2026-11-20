// Read-only views of the router and the vault for the builder page and the payer page. Nothing here signs or sends anything.
//
// The public RPC refuses eth_getLogs over a long range, so events are found by scanning back from the latest block in windows
// (2,000 blocks, halved if the node refuses). A scan that does not reach the router's first block says so: the pages show "the
// latest N", never "all".
import { Contract, Interface, ZeroAddress, getAddress, id } from "ethers";
import type { Provider } from "ethers";
import { ERC20_ABI, ROUTER_ABI, VAULT_ABI } from "@sluice/sdk/abi";

export type ReaderConfig = { router: string; vault: string };

export type ChainReader = {
  provider: Provider;
  router: Contract;
  vault: Contract;
  token: Contract;
  routerAddress: string;
  vaultAddress: string;
  tokenAddress: string;
};

export class ConfigMismatch extends Error {}

/** Opens the contracts and checks the configured vault is the one the router uses, so a wrong address is caught before anything is shown. */
export async function openReader(provider: Provider, cfg: ReaderConfig): Promise<ChainReader> {
  const routerAddress = getAddress(cfg.router);
  const vaultAddress = getAddress(cfg.vault);
  const router = new Contract(routerAddress, ROUTER_ABI as unknown as string[], provider);
  let tokenAddress: string;
  try {
    const [routerVault, token] = (await Promise.all([router.getFunction("vault")(), router.getFunction("token")()])) as [string, string];
    if (getAddress(routerVault) !== vaultAddress) throw new ConfigMismatch("the configured vault is not the vault this router uses");
    tokenAddress = getAddress(token);
  } catch (err) {
    if (err instanceof ConfigMismatch) throw err;
    throw new ConfigMismatch("the configured router could not be read on this network");
  }
  return {
    provider,
    router,
    vault: new Contract(vaultAddress, VAULT_ABI as unknown as string[], provider),
    token: new Contract(tokenAddress, ERC20_ABI as unknown as string[], provider),
    routerAddress,
    vaultAddress,
    tokenAddress,
  };
}

export type Scan = { fromBlock: number; toBlock: number; windows: number; reachedStart: boolean };

type RawLog = { blockNumber: number; transactionHash: string; topics: readonly string[]; data: string; index: number };

export type ScanOptions = {
  /** The block to stop at (the router's deployment block). Without one the scan stops after `maxWindows`. */
  startBlock?: number | null;
  window?: number;
  maxWindows?: number;
  /** Stop once this many logs are found. */
  want?: number;
};

/** Newest first. */
export async function scanBack(
  provider: Provider,
  filter: { address: string; topics: Array<string | string[] | null> },
  { startBlock = null, window = 2_000, maxWindows = 25, want = 10 }: ScanOptions = {},
): Promise<{ logs: RawLog[]; scan: Scan }> {
  const latest = await provider.getBlockNumber();
  const floor = startBlock ?? 0;
  const logs: RawLog[] = [];
  let to = latest;
  let size = window;
  let windows = 0;
  let low = latest;
  while (to >= floor && windows < maxWindows && logs.length < want) {
    const from = Math.max(floor, to - size + 1);
    let got: RawLog[];
    try {
      got = (await provider.getLogs({ ...filter, fromBlock: from, toBlock: to })) as unknown as RawLog[];
    } catch (err) {
      if (size > 100) {
        size = Math.max(100, Math.floor(size / 2));
        continue;
      }
      throw err;
    }
    windows += 1;
    low = from;
    logs.push(...got.slice().reverse());
    to = from - 1;
    size = window;
  }
  return { logs, scan: { fromBlock: low, toBlock: latest, windows, reachedStart: startBlock !== null && low <= startBlock } };
}

// ------------------------------------------------------------------------------------------------ builder

export type SettlementRow = {
  txHash: string;
  blockNumber: number;
  payer: string;
  toolId: string;
  amount: bigint;
  fee: bigint;
};

export type BuilderView = {
  account: string;
  /** What the builder can withdraw now. */
  earnings: bigint;
  feeBps: number;
  feeRecipient: string;
  settlements: SettlementRow[];
  scan: Scan;
};

const routerIface = new Interface(ROUTER_ABI as unknown as string[]);
const vaultIface = new Interface(VAULT_ABI as unknown as string[]);

export const topicFor = (address: string): string => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
export const settledTopic = id("Settled(address,address,bytes32,uint256,uint256,bytes32,address)");
export const sessionAuthorizedTopic = id("SessionAuthorized(address,address,uint64,uint256,uint256,uint256,bytes32)");

export async function readBuilder(reader: ChainReader, account: string, options: ScanOptions = {}): Promise<BuilderView> {
  const who = getAddress(account);
  const [earnings, feeBps, feeRecipient] = await Promise.all([
    reader.router.getFunction("earnings")(who) as Promise<bigint>,
    reader.router.getFunction("feeBps")() as Promise<bigint>,
    reader.router.getFunction("feeRecipient")() as Promise<string>,
  ]);
  const { logs, scan } = await scanBack(
    reader.provider,
    { address: reader.routerAddress, topics: [settledTopic, null, topicFor(who)] },
    options,
  );
  const settlements = logs.map((log) => {
    const parsed = routerIface.parseLog({ topics: [...log.topics], data: log.data });
    return {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      payer: getAddress(String(parsed?.args[0])),
      toolId: String(parsed?.args[2]),
      amount: BigInt(parsed?.args[3] as bigint),
      fee: BigInt(parsed?.args[4] as bigint),
    };
  });
  return { account: who, earnings, feeBps: Number(feeBps), feeRecipient: getAddress(feeRecipient), settlements, scan };
}

// -------------------------------------------------------------------------------------------------- payer

export type SessionStatus = "active" | "expired";

export type SessionView = {
  agent: string;
  status: SessionStatus;
  id: bigint;
  budget: bigint;
  spent: bigint;
  remaining: bigint;
  perCallCap: bigint;
  /** Unix seconds. */
  expiry: number;
};

export type PayerView = {
  account: string;
  qusdcBalance: bigint;
  prepaid: bigint;
  allowance: bigint;
  qieBalance: bigint;
  sessions: SessionView[];
  scan: Scan;
};

/** Reads one agent's session. Returns undefined when there is none (never authorised, or revoked). */
export async function readSession(reader: ChainReader, payer: string, agent: string, nowSeconds: number): Promise<SessionView | undefined> {
  const s = (await reader.vault.getFunction("sessionOf")(payer, agent)) as {
    budget: bigint;
    spent: bigint;
    perCallCap: bigint;
    expiry: bigint;
    id: bigint;
  };
  if (s.id === 0n) return undefined;
  return {
    agent: getAddress(agent),
    status: Number(s.expiry) < nowSeconds ? "expired" : "active",
    id: s.id,
    budget: s.budget,
    spent: s.spent,
    remaining: s.budget - s.spent,
    perCallCap: s.perCallCap,
    expiry: Number(s.expiry),
  };
}

export async function readPayer(
  reader: ChainReader,
  account: string,
  opts: { extraAgents?: string[]; nowSeconds: number } & ScanOptions,
): Promise<PayerView> {
  const who = getAddress(account);
  const [qusdcBalance, prepaid, allowance, qieBalance] = await Promise.all([
    reader.token.getFunction("balanceOf")(who) as Promise<bigint>,
    reader.router.getFunction("payerBalance")(who) as Promise<bigint>,
    reader.token.getFunction("allowance")(who, reader.routerAddress) as Promise<bigint>,
    reader.provider.getBalance(who),
  ]);
  const { logs, scan } = await scanBack(
    reader.provider,
    { address: reader.vaultAddress, topics: [sessionAuthorizedTopic, topicFor(who)] },
    { ...opts, want: opts.want ?? 20 },
  );
  const agents = new Set<string>();
  for (const log of logs) {
    const parsed = vaultIface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed) agents.add(getAddress(String(parsed.args[1])));
  }
  for (const a of opts.extraAgents ?? []) agents.add(getAddress(a));
  agents.delete(ZeroAddress);
  const sessions: SessionView[] = [];
  for (const agent of [...agents].slice(0, 30)) {
    const s = await readSession(reader, who, agent, opts.nowSeconds);
    if (s) sessions.push(s);
  }
  return { account: who, qusdcBalance, prepaid, allowance, qieBalance, sessions, scan };
}
