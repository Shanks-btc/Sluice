// One paid call to a paid tool server, signed with the payer's own key. It asks the server for the price, checks every part of the offer
// against what was asked for on the command line, signs one payment, calls again with it, and then waits for the facilitator to settle it.
// No agent session is made and the payment proxy is not used: the signature is the payer's, which the router accepts directly.
//
//   SLUICE_NETWORK=mainnet SLUICE_APPROVE=paid-call SLUICE_MAX_QUSDC=0.01 SLUICE_KEY=... SLUICE_ROUTER=0x... \
//   SLUICE_FACILITATOR_URL=http://127.0.0.1:8402 \
//   pnpm client:call --server http://127.0.0.1:8403/mcp --from 0xPayer --payee 0xBuilder --tool dex_quote --arg tokenIn=QIE --arg tokenOut=0x... --arg amountIn=1
//
//   --server        the tool server's MCP address (https; plain http only on this machine)
//   --from          the payer: refused unless SLUICE_KEY is this address's key
//   --payee         who may be paid: an offer naming anyone else is refused
//   --tool          the tool to call
//   --arg           one argument of the tool as name=value, text only; repeat it for each. (PowerShell 5 strips the quotes out of a JSON
//                   argument, so there is no JSON form here.)
//   --wait-seconds  how long to wait for the settlement (default 90; 0 does not wait)
//
// THE OWNER OF THE KEY RUNS THIS. It refuses to run without SLUICE_APPROVE=paid-call, and SLUICE_MAX_QUSDC must be set: it is the most
// this one call may pay. It sends no transaction and spends no QIE. The key signs on this machine and is never printed or sent.
//
// Exit code 0: paid and answered (settled, or not yet settled when the wait ended). 1: refused, or the call or the payment failed.
// 2: the command was wrong, and nothing was signed.
import { exitWith } from "../../src/exit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Contract, Wallet, getAddress } from "ethers";
import {
  DEFAULT_TIMEOUT_SECONDS, PAYMENT_META_KEY, QUSDC_ADDRESS, X402_VERSION,
  intentDigest, newNonce, parsePaymentRequired, settlementOf, signIntent, toWire, toolIdOf,
} from "@sluice/sdk";
import type { Intent, PaymentPayload, PaymentRequirements, ToolResult } from "@sluice/sdk";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import { formatQusdc } from "../../src/units";
import { GuardError, redact, requireApproval } from "../../src/guard";

export type Env = Record<string, string | undefined>;
export type PaidCallIo = { log?: (line: string) => void; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

class UsageError extends Error {}

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
const VALUE_FLAGS = new Set(["--server", "--from", "--payee", "--tool", "--arg", "--wait-seconds"]);
const FINAL = new Set(["settled", "skipped", "expired", "failed"]);

type Args = { server: string; from: string; payee: string; tool: string; toolArgs: Record<string, string>; waitSeconds: number };

function parseArgs(argv: string[]): Args {
  const one: Record<string, string> = {};
  const toolArgs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--arg") {
      const m = /^([A-Za-z_][A-Za-z0-9_]{0,63})=(.*)$/.exec(value);
      if (!m) throw new UsageError("--arg is name=value, like --arg amountIn=1");
      const name = m[1] as string;
      if (Object.prototype.hasOwnProperty.call(toolArgs, name)) throw new UsageError(`--arg ${name} was given twice`);
      toolArgs[name] = m[2] as string;
    } else {
      if (flag in one) throw new UsageError(`${flag} was given twice`);
      one[flag] = value;
    }
  }
  for (const flag of ["--server", "--from", "--payee", "--tool"]) if (!one[flag]) throw new UsageError(`${flag} is needed`);
  const server = one["--server"] as string;
  if (!server.startsWith("https://") && !LOCAL.test(server)) throw new UsageError("--server must be https (plain http is for this machine only)");
  const address = (flag: string): string => {
    try {
      return getAddress(one[flag] as string);
    } catch {
      throw new UsageError(`${flag} is not an address`);
    }
  };
  const wait = one["--wait-seconds"] ?? "90";
  if (!/^\d{1,3}$/.test(wait) || Number(wait) > 600) throw new UsageError("--wait-seconds must be a whole number from 0 to 600");
  return { server, from: address("--from"), payee: address("--payee"), tool: one["--tool"] as string, toolArgs, waitSeconds: Number(wait) };
}

const short = (text: string, n = 240): string => (text.length > n ? `${text.slice(0, n)}…` : text);
const textOf = (result: ToolResult): string => String((result.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text ?? "").replace(/\s+/g, " ");

export async function main(argv: string[], env: Env = process.env, io: PaidCallIo = {}): Promise<number> {
  const log = (line: string) => (io.log ?? console.log)(redact(line, env));
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let client: Client | undefined;
  let opened: ReturnType<typeof providerFor> | undefined;
  let signed = false;
  try {
    const args = parseArgs(argv);
    const router = env.SLUICE_ROUTER?.trim();
    if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) throw new UsageError("set SLUICE_ROUTER to the router's address");
    const facilitator = env.SLUICE_FACILITATOR_URL?.trim().replace(/\/+$/, "");
    if (!facilitator) throw new UsageError("set SLUICE_FACILITATOR_URL: the settlement is read from it");
    if (!facilitator.startsWith("https://") && !LOCAL.test(facilitator)) throw new UsageError("SLUICE_FACILITATOR_URL must be https");
    // The default cap of the other scripts is far above one call's price, so here the cap has to be written down.
    if (!env.SLUICE_MAX_QUSDC?.trim()) throw new GuardError("refusing to run paid-call: set SLUICE_MAX_QUSDC, the most this one call may pay");
    // Network, approval, cap and key, all checked before anything is opened. The price is not known yet, so it is checked below.
    const approval = requireApproval("paid-call", env, { qusdc: 0n, qieWei: 0n, summary: "sign one payment for one tool call" });
    const payer = new Wallet(approval.privateKey());
    if (payer.address !== args.from) throw new GuardError(`the key in SLUICE_KEY is ${payer.address}'s, not --from ${args.from}'s, so nothing was signed`);

    const provider = providerFor(await chooseRpc(approval.network, env.SLUICE_RPC_URL, log), approval.chainId);
    opened = provider;
    const reported = BigInt(String(await provider.send("eth_chainId", [])));
    if (reported !== BigInt(approval.chainId)) throw new GuardError(`the RPC is on chain ${reported}, but ${approval.network} is chain ${approval.chainId}`);
    const contract = new Contract(router, ["function token() view returns (address)", "function payerBalance(address) view returns (uint256)"], provider);
    const asset = getAddress((await contract.getFunction("token")()) as string);
    if (approval.network === "mainnet" && asset !== getAddress(QUSDC_ADDRESS)) throw new GuardError("the router does not hold QUSDC, so it is not the router to pay through on mainnet");
    const health = (await (io.fetchImpl ?? fetch)(`${facilitator}/health`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json(), () => undefined)) as { chainId?: number; router?: string } | undefined;
    if (!health || health.chainId !== approval.chainId || !health.router || getAddress(health.router) !== getAddress(router)) {
      throw new GuardError("the facilitator is not answering for this network and this router (check SLUICE_FACILITATOR_URL and SLUICE_ROUTER)");
    }

    client = new Client({ name: "sluice-paid-call", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(args.server)));
    const params = { name: args.tool, arguments: args.toolArgs };
    log(`payer ${payer.address} on ${approval.network} (chain ${approval.chainId}), asking ${args.tool} for its price`);
    const first = (await client.callTool(params)) as ToolResult;
    const required = parsePaymentRequired(first);
    if (!required) {
      log(`the server did not ask for a payment, so nothing was signed: ${short(textOf(first))}`);
      return 1;
    }

    // The offer is taken only if every part of it is what was asked for. Each refusal says which part is not.
    const wrong = (offer: PaymentRequirements): string | undefined => {
      try {
        if (offer.scheme !== "sluice-intent") return "its scheme is not sluice-intent";
        if (offer.network !== `eip155:${approval.chainId}`) return "it is for another network";
        if (getAddress(offer.asset) !== asset) return "it asks for another token";
        if (getAddress(offer.extra.router) !== getAddress(router)) return "it names another router";
        if (getAddress(offer.payTo) !== args.payee) return `it would pay ${getAddress(offer.payTo)}, not --payee ${args.payee}`;
        if (String(offer.extra.toolId).toLowerCase() !== toolIdOf(args.tool).toLowerCase()) return "its tool id is not this tool's";
        if (!/^\d+$/.test(offer.amount) || BigInt(offer.amount) <= 0n) return "its amount is not above zero";
        if (BigInt(offer.amount) > approval.caps.maxQusdc) return `it asks ${formatQusdc(BigInt(offer.amount))} QUSDC, above the cap of ${formatQusdc(approval.caps.maxQusdc)}`;
        return undefined;
      } catch {
        return "it is malformed";
      }
    };
    const accepted = required.accepts.find((o) => wrong(o) === undefined);
    if (!accepted) {
      const why = required.accepts.map((o) => wrong(o)).filter(Boolean);
      throw new GuardError(`nothing was signed: no offer from the server can be taken (${why.join("; ") || "it made none"})`);
    }
    const amount = BigInt(accepted.amount);
    const held = (await contract.getFunction("payerBalance")(payer.address)) as bigint;
    if (held < amount) throw new GuardError(`nothing was signed: the payer's balance in the router is ${formatQusdc(held)} QUSDC, less than the price of ${formatQusdc(amount)}`);

    const intent: Intent = {
      payer: payer.address,
      payee: getAddress(accepted.payTo),
      amount,
      toolId: accepted.extra.toolId,
      nonce: newNonce(),
      deadline: BigInt(Math.floor(Date.now() / 1000) + Math.min(accepted.maxTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS)),
    };
    const signature = await signIntent(payer, router, intent, approval.chainId);
    signed = true;
    const id = intentDigest(router, intent, approval.chainId);
    log(`signed a payment of ${formatQusdc(amount)} QUSDC to ${intent.payee} for ${args.tool}; intent ${id}`);
    const payload: PaymentPayload = { x402Version: X402_VERSION, resource: required.resource, accepted, payload: { signature, authorization: toWire(intent) } };
    const second = (await client.callTool({ ...params, _meta: { [PAYMENT_META_KEY]: payload } })) as ToolResult;
    if (second.isError) {
      log(`the call did not go through: ${short(parsePaymentRequired(second)?.error ?? textOf(second))}`);
      log(`check whether the facilitator holds the payment before paying again: ${facilitator}/status/${id}`);
      return 1;
    }
    log(`the tool answered: ${short(textOf(second))}`);
    const reply = settlementOf(second);
    if (!reply || reply.success !== true) {
      log(`the reply does not say the payment was accepted. Check before paying again: ${facilitator}/status/${id}`);
      return 1;
    }

    // The settlement is read from the facilitator named here, never from an address the server sent.
    type Status = { status?: string; transaction?: string; reason?: string };
    const ask = async (): Promise<Status | undefined> =>
      (io.fetchImpl ?? fetch)(`${facilitator}/status/${id}`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? (r.json() as Promise<Status>) : undefined), () => undefined);
    const until = Date.now() + args.waitSeconds * 1000;
    let state = await ask();
    while (args.waitSeconds > 0 && !(state?.status && FINAL.has(state.status)) && Date.now() < until) {
      await sleep(2_000);
      state = (await ask()) ?? state;
    }
    const status = state?.status ?? "not known";
    log(`settlement: ${status}${state?.transaction ? `, transaction ${state.transaction}` : ""}${state?.reason ? ` (${state.reason.slice(0, 160)})` : ""}`);
    if (status === "settled" && state?.transaction) {
      log(`record it: pnpm evidence:record --claim paid-call-settlement --tx ${state.transaction} --network ${approval.network} --router ${getAddress(router)} --tool ${args.tool}`);
      log(`and the batch, once for each transaction: pnpm evidence:record --claim settle-batch --tx ${state.transaction} --network ${approval.network} --router ${getAddress(router)}`);
      return 0;
    }
    if (FINAL.has(status)) {
      log("the payment did not settle, so the payer was not charged by it.");
      return 1;
    }
    log(`not settled yet. Ask again later, and do not pay a second time for this call: ${facilitator}/status/${id}`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      log(`refused: ${err.message}`);
      return 2;
    }
    if (err instanceof GuardError) {
      log(`refused: ${err.message}`);
      return 1;
    }
    log(signed ? "the call stopped after a payment was signed: check the facilitator's status for the intent before paying again." : "the call failed before anything was signed.");
    return 1;
  } finally {
    await client?.close().catch(() => undefined);
    opened?.destroy();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("client:call failed");
      exitWith(1);
    },
  );
}
