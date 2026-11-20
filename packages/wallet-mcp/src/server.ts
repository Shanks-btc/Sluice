// The Sluice wallet MCP: five tools for an AI agent, over stdio.
//
//   balance               the owner's prepaid balance, their wallet's QUSDC, and this agent's session
//   deposit_instructions  how the OWNER funds the balance and authorises this agent (calldata and steps, nothing sent)
//   price_check           what a tool on the configured upstream costs, and whether this agent's budget allows it
//   pay_history           what this agent has paid: the local log, and Settled events on the chain
//   budget_status         the owner's limits, what is spent, what is left, and whether the chain agrees
//
// What it cannot do, by construction: it has no tool that signs, sends a transaction, takes a key, or changes a budget.
// The budget is the owner's: only a signature from the owner's key on the AgentVault can create, raise or revoke a
// session. The session key is loaded only to know this agent's address, and a key that is the owner's address, the
// router's owner or its fee recipient is refused. Payments are signed by the proxy, not here.
import { Interface, getAddress } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BudgetPolicy, readEntries } from "@sluice/proxy";
import type { ProxyConfig, UpstreamClient } from "@sluice/proxy";
import {
  PRICING_META_KEY,
  ERC20_ABI,
  NameResolutionError,
  formatQusdc,
  parsePaymentRequired,
  parseQusdc,
  resolvePayee,
  routerInterface,
} from "@sluice/sdk";
import type { ChainReader } from "./chain";

const erc20 = new Interface(ERC20_ABI as unknown as string[]);

export class WalletStartError extends Error {}

export type WalletOptions = {
  config: ProxyConfig;
  chain: ChainReader;
  /** The agent's session-key address. */
  agent: string;
  /** Connects to the configured upstream when price_check needs it. */
  upstream?: () => Promise<UpstreamClient>;
  now?: () => number;
  /** How many blocks pay_history looks back on the chain. */
  lookbackBlocks?: number;
};

const RISK_SENTENCE =
  "QUSDC's admin account can give itself the right to burn any holder's QUSDC, including the router's; the router cannot prevent that. Keep prepaid balances small and withdraw to your own wallet often.";

type Json = Record<string, unknown>;

function reply(data: Json, isError = false) {
  return { ...(isError ? { isError: true } : {}), structuredContent: data, content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Refuses a session key that looks like an owner's: the payer, the router's owner or its fee recipient. */
export async function assertSessionKey(chain: ChainReader, config: ProxyConfig, agent: string): Promise<void> {
  const a = getAddress(agent);
  if (a === getAddress(config.payer)) throw new WalletStartError("the key is the owner's own address. The wallet MCP uses a session key only, never the owner's key");
  const { owner, feeRecipient } = await chain.identities();
  if (a === owner) throw new WalletStartError("the key is the router's owner. The wallet MCP uses a session key only");
  if (a === feeRecipient) throw new WalletStartError("the key is the router's fee recipient. The wallet MCP uses a session key only");
}

export function createWalletServer(o: WalletOptions): McpServer {
  const { config, chain } = o;
  const agent = getAddress(o.agent);
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  // The proxy is a separate process that keeps updating the spent total on disk, so it is read afresh on every query.
  const policy = () => new BudgetPolicy(config, now);
  const server = new McpServer({ name: "sluice-wallet", version: "0.2.0" });
  let cachedUpstream: Promise<UpstreamClient> | undefined;
  const upstream = () => {
    if (!o.upstream) throw new Error("no upstream is configured");
    cachedUpstream ??= o.upstream();
    return cachedUpstream;
  };

  const sessionView = async () => {
    const s = await chain.session(config.payer, agent);
    if (s.id === 0n) return null;
    return {
      active: BigInt(now()) <= s.expiry,
      budget: formatQusdc(s.budget),
      spent: formatQusdc(s.spent),
      remaining: formatQusdc(s.budget - s.spent),
      perCallCap: formatQusdc(s.perCallCap),
      expiresAt: new Date(Number(s.expiry) * 1000).toISOString(),
      sessionId: s.id.toString(),
    };
  };

  // ---------------------------------------------------------------------------------------------- balance
  server.registerTool(
    "balance",
    {
      description:
        "Shows the owner's prepaid QUSDC balance in the Sluice router, the QUSDC in the owner's wallet, and this agent's session. Read-only. `account` may be an address; a .qie name is not resolved.",
      inputSchema: { account: z.string().optional().describe("An address. Defaults to the owner this agent pays from.") },
    },
    async ({ account }) => {
      let who = getAddress(config.payer);
      if (account) {
        try {
          who = await resolvePayee(account);
        } catch (err) {
          return reply(
            {
              error: "name_resolution_unavailable",
              message: err instanceof NameResolutionError ? err.message : "the account could not be read",
              hint: "Give a 0x address. QIE ID names cannot be resolved here: no documented on-chain read for them was found. The hosted QIE Wallet MCP's qie_resolve_name tool can turn a name into an address.",
            },
            true,
          );
        }
      }
      const [prepaid, wallet] = await Promise.all([chain.prepaid(who), chain.walletQusdc(who)]);
      return reply({
        chainId: config.chainId,
        router: chain.routerAddress,
        token: chain.tokenAddress,
        account: who,
        prepaid: formatQusdc(prepaid),
        prepaidUnits: prepaid.toString(),
        wallet: formatQusdc(wallet),
        walletUnits: wallet.toString(),
        agent,
        session: await sessionView(),
        note: "Amounts are QUSDC. The prepaid balance is what the owner's signed intents can spend; the owner can withdraw it at any time.",
      });
    },
  );

  // ------------------------------------------------------------------------------------ deposit_instructions
  server.registerTool(
    "deposit_instructions",
    {
      description:
        "How the OWNER (not this agent) funds the prepaid balance and authorises this agent's key. Returns the exact calls and the zero-QIE option. Nothing is sent and nothing is signed.",
      inputSchema: { amount: z.string().optional().describe('QUSDC to deposit, like "5.00". Default "1.00".') },
    },
    async ({ amount }) => {
      let units: bigint;
      try {
        units = parseQusdc(amount ?? "1.00");
      } catch {
        return reply({ error: "invalid_amount", message: "amount must be QUSDC above zero with at most six decimals, like 5.00" }, true);
      }
      const vault = await chain.vaultAddress();
      return reply({
        for: "the owner",
        chainId: config.chainId,
        router: chain.routerAddress,
        token: chain.tokenAddress,
        vault,
        amount: formatQusdc(units),
        steps: [
          {
            step: 1,
            title: "Approve the router to take this amount",
            to: chain.tokenAddress,
            data: erc20.encodeFunctionData("approve", [chain.routerAddress, units]),
          },
          {
            step: 2,
            title: "Deposit it into the prepaid balance",
            to: chain.routerAddress,
            data: routerInterface.encodeFunctionData("deposit", [units]),
          },
          {
            step: 3,
            title: "Authorise this agent's session key on the vault, inside the limits the owner chooses",
            to: vault,
            function: "authorize((address agent,uint256 budget,uint256 perCallCap,uint256 expiry) grant,(address payee,bytes32 toolId)[] tools)",
            grant: {
              agent,
              budget: config.budget.totalCap.toString(),
              perCallCap: config.budget.perCallCap.toString(),
              expiry: config.budget.expiresAt,
            },
            tools: "one { payee, toolId } for each tool in the proxy config, where toolId is keccak256 of the tool's name",
          },
        ],
        withNoQie: {
          summary:
            "QUSDC has no permit, so steps 1 and 2 are transactions that need QIE for gas. A wallet with QUSDC and no QIE can sign both offline and hand them to a Sluice facilitator, which sends it exactly the gas they can use and broadcasts them.",
          how: "Use signOnboarding from @sluice/sdk in the owner's own environment, then POST the two signed transactions to the facilitator's /onboard. Never give the owner's key to this wallet MCP or to an agent.",
        },
        warnings: [RISK_SENTENCE, "The owner can withdraw the unspent balance at any time with refund, or by signature through a relayer."],
      });
    },
  );

  // ------------------------------------------------------------------------------------------- price_check
  server.registerTool(
    "price_check",
    {
      description:
        "Reads what a tool on the configured upstream server costs, without paying. With `arguments`, it calls the tool once WITHOUT payment, which a paid tool answers with its price and nothing else. Says whether this agent's budget would allow the purchase.",
      inputSchema: {
        tool: z.string().describe("The tool's name."),
        arguments: z.record(z.unknown()).optional().describe("Arguments for the tool. Only needed to get the authoritative price."),
      },
    },
    async ({ tool, arguments: args }) => {
      let client: UpstreamClient;
      try {
        client = await upstream();
      } catch {
        return reply({ error: "upstream_unavailable", message: "the configured upstream server could not be reached" }, true);
      }
      const listed = (await client.listTools()) as { tools: Array<{ name: string; description?: string; _meta?: Record<string, unknown> }> };
      const found = listed.tools.find((t) => t.name === tool);
      if (!found) return reply({ error: "unknown_tool", message: `the upstream server has no tool named ${tool}`, tools: listed.tools.map((t) => t.name) }, true);
      const advertised = found._meta?.[PRICING_META_KEY] ?? null;
      const out: Json = { tool, description: found.description ?? null, advertised, authoritative: null, wouldPay: null };
      if (args !== undefined) {
        const result = await client.callTool({ name: tool, arguments: args });
        const required = parsePaymentRequired(result);
        if (!required) {
          out.authoritative = { paymentRequired: false, note: "the server did not ask for payment for this call" };
        } else {
          const offer = required.accepts[0];
          out.authoritative = {
            paymentRequired: true,
            error: required.error ?? null,
            resource: required.resource,
            accepts: required.accepts.map((a) => ({
              scheme: a.scheme,
              network: a.network,
              asset: a.asset,
              payTo: a.payTo,
              amount: a.amount,
              price: formatQusdc(BigInt(a.amount)),
              maxTimeoutSeconds: a.maxTimeoutSeconds,
              router: a.extra?.router,
            })),
          };
          if (offer) {
            const d = policy().evaluate(tool, offer);
            out.wouldPay = d.ok ? { allowed: true, price: formatQusdc(d.amount) } : { allowed: false, code: d.code, detail: d.detail };
          }
        }
      }
      return reply(out);
    },
  );

  // --------------------------------------------------------------------------------------------- pay_history
  server.registerTool(
    "pay_history",
    {
      description:
        "What this agent has paid. `local` is the proxy's own log (includes refusals and failures); `chain` is Settled events for the owner in a recent window of blocks, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        source: z.enum(["local", "chain", "both"]).optional(),
      },
    },
    async ({ limit, source }) => {
      const n = limit ?? 20;
      const which = source ?? "both";
      const out: Json = { payer: config.payer, agent };
      if (which !== "chain") out.local = readEntries(config.logFile, n);
      if (which !== "local") {
        const c = await chain.settled(config.payer, n, o.lookbackBlocks ?? 10_000);
        out.chain = {
          rows: c.rows,
          fromBlock: c.fromBlock,
          toBlock: c.toBlock,
          complete: c.complete,
          note: c.complete ? "every Settled event in this block range is listed" : "the scan stopped early or the RPC refused a query: older payments may exist",
        };
      }
      return reply(out);
    },
  );

  // ------------------------------------------------------------------------------------------ budget_status
  server.registerTool(
    "budget_status",
    {
      description:
        "The owner's budget for this agent: per-call cap, total cap, what is spent and left, the expiry and the allowed tools, from the local config and from the chain. This agent cannot change any of it.",
      inputSchema: {},
    },
    async () => {
      const session = await chain.session(config.payer, agent);
      const spent = policy();
      const local = {
        perCallCap: formatQusdc(config.budget.perCallCap),
        totalCap: formatQusdc(config.budget.totalCap),
        spent: formatQusdc(spent.spentUnits),
        remaining: formatQusdc(spent.remainingUnits),
        expiresAt: new Date(config.budget.expiresAt * 1000).toISOString(),
        expired: now() >= config.budget.expiresAt,
        payments: spent.payments,
        allowedTools: config.budget.allowedTools,
      };
      const warnings: string[] = [];
      let onChain: Json | null = null;
      if (session.id === 0n) {
        warnings.push("The chain has no session for this agent key under the owner, so every payment will be refused until the owner authorises it.");
      } else {
        const remaining = session.budget - session.spent;
        onChain = {
          budget: formatQusdc(session.budget),
          spent: formatQusdc(session.spent),
          remaining: formatQusdc(remaining),
          perCallCap: formatQusdc(session.perCallCap),
          expiresAt: new Date(Number(session.expiry) * 1000).toISOString(),
          expired: BigInt(now()) > session.expiry,
        };
        if (config.budget.perCallCap > session.perCallCap) warnings.push("The local per-call cap is above the chain's. The chain's lower cap applies.");
        if (config.budget.totalCap > session.budget) warnings.push("The local total cap is above the chain's budget. The chain's budget applies.");
        if (BigInt(config.budget.expiresAt) > session.expiry) warnings.push("The local expiry is later than the chain's. The chain's earlier expiry applies.");
      }
      return reply({
        agent,
        payer: config.payer,
        local,
        chain: onChain,
        inEffect: "A payment must pass both the local limits and the chain's session limits.",
        whoCanChangeIt: "Only the owner, by signing an authorize or revoke on the AgentVault. This wallet has no tool for it.",
        warnings,
      });
    },
  );

  return server;
}
