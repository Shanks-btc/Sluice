// What an owner does once, from a wallet that holds QUSDC and may hold no QIE: put QUSDC in the router, authorise an agent's key, and take
// earnings or an unspent balance back out (`withdraw` and `refund`, each signed and submitted by the facilitator). The
// owner only signs. The facilitator sends the transactions and pays the gas.
//
//   SLUICE_NETWORK=testnet SLUICE_APPROVE=owner-setup SLUICE_KEY=... SLUICE_ROUTER=0x... SLUICE_FACILITATOR_URL=https://... \
//   pnpm client:owner start --amount 5
//
//   ... pnpm client:owner authorize --agent 0xAgentAddress --budget 0.5 --per-call 0.02 --days 7 \
//         --tool token_risk_check=0xBuildersAddress --tool contract_lookup=0xBuildersAddress
//
//   ... pnpm client:owner revoke --agent 0xAgentAddress
//
// `start` signs an approval and a deposit (two ordinary transactions, signed by the owner's key) and gives them to the facilitator, which
// sends the wallet the QIE they can use, if it has none, and broadcasts them. `authorize` signs an agent session (a budget, a cap for each call,
// an expiry and a list of tools) for the vault, and the facilitator submits it. The chain enforces the session whatever any config says.
// `revoke` signs the end of that session, and the facilitator submits it.
//
// Any command also takes --from 0xAddress: it is refused unless the key in SLUICE_KEY is that address's, so a wrong key file signs nothing.
//
// THE OWNER RUNS THIS. It refuses to run without SLUICE_APPROVE=owner-setup and stops at the QUSDC cap (SLUICE_MAX_QUSDC, default 10). The key
// is used to sign on this machine and is never printed or sent. Use a wallet that holds only what you mean to put in.
import { exitWith } from "../../src/exit";
import { Contract, Wallet, getAddress, hexlify, randomBytes } from "ethers";
import { chooseRpc, providerFor } from "../../src/rpc-use";
import { FacilitatorClient, VAULT_ABI, signAuthorize, signOnboarding, signRefund, signRevoke, signWithdraw, toolIdOf } from "@sluice/sdk";
import { formatQusdc } from "../../src/units";
import { GuardError, parseAmount, redact, requireApproval } from "../../src/guard";
import type { Plan } from "../../src/guard";

export type Env = Record<string, string | undefined>;
export type OwnerIo = { log?: (line: string) => void; fetchImpl?: typeof fetch };

class UsageError extends Error {}

type Args = { amount?: string; to?: string; agent?: string; budget?: string; perCall?: string; days?: string; from?: string; tools: string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { tools: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--amount") out.amount = value;
    else if (flag === "--agent") out.agent = value;
    else if (flag === "--to") out.to = value;
    else if (flag === "--budget") out.budget = value;
    else if (flag === "--per-call") out.perCall = value;
    else if (flag === "--days") out.days = value;
    else if (flag === "--tool") out.tools.push(value);
    else if (flag === "--from") out.from = value;
    else throw new UsageError(`unknown option ${flag.slice(0, 40)}`);
  }
  return out;
}

const ERC20 = ["function balanceOf(address) view returns (uint256)"];

export async function main(argv: string[], env: Env = process.env, io: OwnerIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  try {
    const [command, ...rest] = argv;
    if (command !== "start" && command !== "authorize" && command !== "revoke" && command !== "withdraw" && command !== "refund") throw new UsageError("the command is start, authorize, revoke, withdraw or refund");
    const args = parseArgs(rest);
    let from: string | undefined;
    if (args.from !== undefined) {
      try {
        from = getAddress(args.from);
      } catch {
        throw new UsageError("--from is not an address");
      }
    }
    const facilitatorUrl = env.SLUICE_FACILITATOR_URL?.trim();
    const router = env.SLUICE_ROUTER?.trim();
    if (!facilitatorUrl) throw new UsageError("set SLUICE_FACILITATOR_URL");
    if (!facilitatorUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(facilitatorUrl)) throw new UsageError("SLUICE_FACILITATOR_URL must be https");
    if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) throw new UsageError("set SLUICE_ROUTER to the router's address");

    let amount = 0n;
    if (command === "start" || command === "withdraw" || command === "refund") {
      if (!args.amount) throw new UsageError(`${command} needs --amount, in QUSDC, like --amount 5`);
      amount = parseAmount(args.amount, 6, "--amount");
    }
    // Only a start moves QUSDC out of the owner's wallet, so only a start counts against the QUSDC cap. A withdrawal and a refund bring QUSDC back.
    const plan: Plan = {
      qusdc: command === "start" ? amount : 0n,
      qieWei: 0n,
      summary:
        command === "start" ? `put ${formatQusdc(amount)} QUSDC in the router; the facilitator pays the gas`
        : command === "authorize" ? "authorise an agent key by signature; the facilitator pays the gas"
        : command === "revoke" ? "end an agent key's session by signature; the facilitator pays the gas"
        : `${command} ${formatQusdc(amount)} QUSDC out of the router by signature; the facilitator pays the gas`,
    };
    const approval = requireApproval("owner-setup", env, plan); // network, approval, QUSDC cap and key, all checked before anything is opened
    // Whose key this is, checked before anything is asked of a node or a facilitator. Only the address is ever said.
    const holder = new Wallet(approval.privateKey()).address;
    if (from !== undefined && holder !== from) throw new GuardError(`the key in SLUICE_KEY is ${holder}'s, not --from ${from}'s, so nothing was signed`);

    const provider = providerFor(await chooseRpc(approval.network, env.SLUICE_RPC_URL, log), approval.chainId);
    const reported = BigInt(String(await provider.send("eth_chainId", [])));
    if (reported !== BigInt(approval.chainId)) throw new GuardError(`the RPC is on chain ${reported}, but ${approval.network} is chain ${approval.chainId}`);
    const owner = new Wallet(approval.privateKey(), provider);
    const routerContract = new Contract(router, ["function token() view returns (address)", "function vault() view returns (address)"], provider);
    const [asset, vault] = (await Promise.all([routerContract.getFunction("token")(), routerContract.getFunction("vault")()])) as [string, string];
    const client = new FacilitatorClient({ url: facilitatorUrl, ...(io.fetchImpl ? { fetch: io.fetchImpl } : {}) });
    const health = (await fetch(`${facilitatorUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json(), () => undefined)) as { chainId?: number; router?: string; ok?: boolean } | undefined;
    if (!health || health.chainId !== approval.chainId || (health.router && getAddress(health.router) !== getAddress(router))) {
      throw new GuardError("the facilitator is not on this network and this router (check SLUICE_FACILITATOR_URL and SLUICE_ROUTER)");
    }
    log(`owner ${owner.address} on ${approval.network} (chain ${approval.chainId}), router ${getAddress(router)}`);

    if (command === "start") {
      const token = new Contract(asset, ERC20, provider);
      const held = (await token.getFunction("balanceOf")(owner.address)) as bigint;
      if (held < amount) throw new GuardError(`the wallet holds ${formatQusdc(held)} QUSDC, less than the ${formatQusdc(amount)} to put in`);
      const fee = (await provider.getFeeData()).gasPrice;
      if (fee === null || fee === undefined) throw new Error("the node gave no gas price");
      const nonce = await provider.getTransactionCount(owner.address, "pending");
      // A tenth above the network's price, so a small rise before the facilitator sends them does not make it refuse.
      const gasPrice = (fee * 11n) / 10n;
      const txs = await signOnboarding(owner, { router, asset, amount, nonce, gasPrice, chainId: approval.chainId });
      log(`signed an approval and a deposit of ${formatQusdc(amount)} QUSDC (nothing sent yet); asking the facilitator to send them`);
      const out = await client.onboard({ payer: owner.address, approveTx: txs.approveTx, depositTx: txs.depositTx });
      if (!out.ok) {
        log(`the facilitator did not start the wallet: ${out.error ?? "refused"}${out.detail ? ` (${out.detail})` : ""}`);
        return 1;
      }
      if (out.topUpTx) log(`top-up from the facilitator: ${out.topUpTx} (${out.topUpWei} wei)`);
      log(`approval: ${out.approveTx}`);
      log(`deposit:  ${out.depositTx}`);
      log(`done: ${formatQusdc(amount)} QUSDC is in the router, in this wallet's balance.`);
      if (out.topUpTx) log(`record it: pnpm evidence:record --claim relayed-start --tx ${out.depositTx} --topup ${out.topUpTx} --network ${approval.network} --router ${router}`);
      else log(`record it: pnpm evidence:record --claim deposit --tx ${out.depositTx} --network ${approval.network} --router ${router}`);
      return 0;
    }

    if (command === "withdraw" || command === "refund") {
      // A builder takes earnings out (withdraw), and a payer takes unspent prepaid balance out (refund). Either signs, and the facilitator submits.
      let to: string;
      try {
        to = getAddress(args.to ?? owner.address);
      } catch {
        throw new UsageError("--to is not an address");
      }
      const views = new Contract(router, ["function earnings(address) view returns (uint256)", "function payerBalance(address) view returns (uint256)"], provider);
      const available = (await views.getFunction(command === "withdraw" ? "earnings" : "payerBalance")(owner.address)) as bigint;
      if (available < amount) throw new GuardError(`this wallet's ${command === "withdraw" ? "earnings" : "prepaid balance"} in the router is ${formatQusdc(available)} QUSDC, less than the ${formatQusdc(amount)} asked for`);
      const head = await provider.getBlock("latest");
      const deadline = BigInt(head?.timestamp ?? Math.floor(Date.now() / 1000)) + 600n;
      const nonce = hexlify(randomBytes(32));
      const sign = command === "withdraw" ? signWithdraw : signRefund;
      const signature = await sign(owner, router, { account: owner.address, to, amount, nonce, deadline }, approval.chainId);
      log(`signed ${command === "withdraw" ? "a withdrawal" : "a refund"} of ${formatQusdc(amount)} QUSDC to ${to} (nothing sent yet); asking the facilitator to submit it`);
      const out = await client.relay({ kind: command, account: owner.address, to, amount: amount.toString(), nonce, deadline: deadline.toString(), signature });
      if (!out.ok) {
        log(`the facilitator did not submit it: ${out.error ?? "refused"}${out.detail ? ` (${out.detail})` : ""}`);
        return 1;
      }
      log(`${command === "withdraw" ? "withdrawn" : "refunded"}: ${out.transaction}`);
      log(`record it: pnpm evidence:record --claim ${command} --tx ${out.transaction} --network ${approval.network} --router ${router}`);
      return 0;
    }

    if (command === "revoke") {
      if (!args.agent) throw new UsageError("revoke needs --agent, the agent key's address");
      let revoked: string;
      try {
        revoked = getAddress(args.agent);
      } catch {
        throw new UsageError("--agent is not an address");
      }
      const sessions = new Contract(vault, VAULT_ABI as unknown as string[], provider);
      const session = (await sessions.getFunction("sessionOf")(owner.address, revoked)) as { id: bigint };
      if (session.id === 0n) throw new GuardError("this wallet has no session for that agent, so there is nothing to end");
      const nonce = (await sessions.getFunction("nonces")(owner.address)) as bigint;
      const head = await provider.getBlock("latest");
      const deadline = BigInt(head?.timestamp ?? Math.floor(Date.now() / 1000)) + 600n;
      const signature = await signRevoke(owner, vault, { payer: owner.address, agent: revoked, nonce, deadline }, approval.chainId);
      log(`signed the end of the session of agent ${revoked} (nothing sent yet); asking the facilitator to submit it`);
      const out = await client.relay({ kind: "revoke", payer: owner.address, agent: revoked, deadline: deadline.toString(), signature });
      if (!out.ok) {
        log(`the facilitator did not submit it: ${out.error ?? "refused"}${out.detail ? ` (${out.detail})` : ""}`);
        return 1;
      }
      log(`revoked: ${out.transaction}`);
      return 0;
    }

    // authorize
    if (!args.agent) throw new UsageError("authorize needs --agent, the agent key's address");
    let agent: string;
    try {
      agent = getAddress(args.agent);
    } catch {
      throw new UsageError("--agent is not an address");
    }
    if (agent === owner.address) throw new GuardError("the agent's key must not be the owner's own: the agent signs for the owner, so it needs a key of its own");
    if (!args.budget || !args.perCall) throw new UsageError("authorize needs --budget and --per-call, in QUSDC");
    const budget = parseAmount(args.budget, 6, "--budget");
    const perCall = parseAmount(args.perCall, 6, "--per-call");
    if (perCall > budget) throw new UsageError("--per-call is above --budget");
    const days = Number(args.days ?? "7");
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new UsageError("--days must be a whole number from 1 to 365");
    if (args.tools.length === 0 || args.tools.length > 32) throw new UsageError("give from 1 to 32 --tool name=0xPayee");
    const tools = args.tools.map((t) => {
      const [name, payee, ...extra] = t.split("=");
      if (!name || !payee || extra.length > 0) throw new UsageError("--tool is name=0xPayee, like token_risk_check=0xBuildersAddress");
      try {
        return { payee: getAddress(payee), toolId: toolIdOf(name) };
      } catch {
        throw new UsageError("a --tool payee is not an address");
      }
    });
    const block = await provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
    const grant = { agent, budget, perCallCap: perCall, expiry: now + BigInt(days) * 86_400n };
    const deadline = now + 600n;
    const vaultContract = new Contract(vault, ["function nonces(address) view returns (uint256)"], provider);
    const nonce = (await vaultContract.getFunction("nonces")(owner.address)) as bigint;
    const signature = await signAuthorize(owner, vault, { payer: owner.address, grant, tools, nonce, deadline }, approval.chainId);
    log(`signed the agent session (nothing sent yet): agent ${agent}, up to ${formatQusdc(budget)} QUSDC in all and ${formatQusdc(perCall)} a call, for ${days} days, ${tools.length} tool${tools.length === 1 ? "" : "s"}`);
    const out = await client.relay({
      kind: "authorize",
      payer: owner.address,
      tools,
      deadline: deadline.toString(),
      signature,
      grant: { agent, budget: budget.toString(), perCallCap: perCall.toString(), expiry: grant.expiry.toString() },
    });
    if (!out.ok) {
      log(`the facilitator did not submit it: ${out.error ?? "refused"}${out.detail ? ` (${out.detail})` : ""}`);
      return 1;
    }
    log(`authorised: ${out.transaction}`);
    log(`put the same limits in the proxy's config (budget, per-call cap, expiry ${new Date(Number(grant.expiry) * 1000).toISOString()}, the same tools and payees)`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      log(`refused: ${redact(err.message, env)}`);
      return 2;
    }
    if (err instanceof GuardError) {
      log(`refused: ${redact(err.message, env)}`);
      return 1;
    }
    log("the owner setup failed to run, and nothing was sent.");
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("client:owner failed");
      exitWith(1);
    },
  );
}
