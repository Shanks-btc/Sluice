// Read-only chain access for the wallet MCP: balances, the agent's session, and Settled events. Nothing here sends a
// transaction or signs anything.
import { Contract, getAddress } from "ethers";
import type { Provider } from "ethers";
import { ERC20_ABI, ROUTER_ABI, VAULT_ABI, formatQusdc, routerInterface } from "@sluice/sdk";

export type Session = { budget: bigint; spent: bigint; perCallCap: bigint; expiry: bigint; id: bigint };

export type SettledRow = {
  block: number;
  transaction: string;
  payee: string;
  toolId: string;
  amount: string;
  fee: string;
  signer: string;
};

/** The public QIE RPC refused a wider log range than this in testing, so queries go in windows of this size. */
export const LOG_WINDOW = 2_000;

export class ChainReader {
  readonly router: Contract;
  private vaultContract?: Contract;

  constructor(
    readonly provider: Provider,
    readonly routerAddress: string,
    readonly tokenAddress: string,
  ) {
    this.router = new Contract(getAddress(routerAddress), ROUTER_ABI as unknown as string[], provider);
  }

  static async connect(provider: Provider, routerAddress: string): Promise<ChainReader> {
    const router = new Contract(getAddress(routerAddress), ROUTER_ABI as unknown as string[], provider);
    const token = getAddress((await router.getFunction("token")()) as string);
    return new ChainReader(provider, routerAddress, token);
  }

  private async vault(): Promise<Contract> {
    if (!this.vaultContract) {
      const address = getAddress((await this.router.getFunction("vault")()) as string);
      this.vaultContract = new Contract(address, VAULT_ABI as unknown as string[], this.provider);
    }
    return this.vaultContract;
  }

  async vaultAddress(): Promise<string> {
    return (await this.vault()).getAddress();
  }

  async prepaid(payer: string): Promise<bigint> {
    return (await this.router.getFunction("payerBalance")(payer)) as bigint;
  }

  async walletQusdc(owner: string): Promise<bigint> {
    const token = new Contract(this.tokenAddress, ERC20_ABI as unknown as string[], this.provider);
    return (await token.getFunction("balanceOf")(owner)) as bigint;
  }

  async session(payer: string, agent: string): Promise<Session> {
    const s = (await (await this.vault()).getFunction("sessionOf")(payer, agent)) as Session;
    return { budget: s.budget, spent: s.spent, perCallCap: s.perCallCap, expiry: s.expiry, id: s.id };
  }

  async identities(): Promise<{ owner: string; feeRecipient: string }> {
    const [owner, feeRecipient] = (await Promise.all([this.router.getFunction("owner")(), this.router.getFunction("feeRecipient")()])) as [string, string];
    return { owner: getAddress(owner), feeRecipient: getAddress(feeRecipient) };
  }

  async blockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Settled events for a payer, newest first, scanning back from the latest block in windows until `limit` rows are
   * found or `lookback` blocks are covered. `complete` is false when the scan stopped before reaching the start.
   */
  async settled(payer: string, limit: number, lookback: number): Promise<{ rows: SettledRow[]; fromBlock: number; toBlock: number; complete: boolean; error?: string }> {
    const latest = await this.blockNumber();
    const start = Math.max(0, latest - lookback);
    const topic = routerInterface.getEvent("Settled")?.topicHash as string;
    const payerTopic = `0x${getAddress(payer).slice(2).toLowerCase().padStart(64, "0")}`;
    const rows: SettledRow[] = [];
    let to = latest;
    try {
      while (to >= start && rows.length < limit) {
        const from = Math.max(start, to - LOG_WINDOW + 1);
        const logs = await this.provider.getLogs({ address: this.routerAddress, topics: [topic, payerTopic], fromBlock: from, toBlock: to });
        for (const log of [...logs].reverse()) {
          const e = routerInterface.parseLog({ topics: [...log.topics], data: log.data });
          if (!e) continue;
          rows.push({
            block: log.blockNumber,
            transaction: log.transactionHash,
            payee: String(e.args.payee),
            toolId: String(e.args.toolId),
            amount: formatQusdc(e.args.amount as bigint),
            fee: formatQusdc(e.args.fee as bigint),
            signer: String(e.args.signer),
          });
        }
        to = from - 1;
      }
    } catch {
      return { rows: rows.slice(0, limit), fromBlock: start, toBlock: latest, complete: false, error: "the RPC refused a log query" };
    }
    return { rows: rows.slice(0, limit), fromBlock: start, toBlock: latest, complete: to < start || rows.length >= limit };
  }
}
