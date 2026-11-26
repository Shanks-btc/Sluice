// pnpm live:balances: what some addresses hold, in their wallets and inside the router. Read-only.
//
//   SLUICE_NETWORK=mainnet pnpm live:balances --address 0x... --address 0x...      (the router comes from deployment.json in this folder)
//   SLUICE_NETWORK=mainnet pnpm live:balances --router 0x... --address 0x...
//
// For each address: its QIE, its QUSDC (the token the router holds), the balance it prepaid into the router, and what it has earned there
// and not withdrawn. All read at one block. It uses eth_chainId, eth_blockNumber, eth_getBalance and eth_call and nothing else, holds no
// key and sends nothing.
//
//   --address  an address to read; repeat it, up to 12
//   --router   the router. Left out: SLUICE_ROUTER, then the router in deployment.json in this folder.
//
// SLUICE_NETWORK is mainnet or testnet (no default). SLUICE_RPC_URL names one endpoint; left out, QIE's five endpoints are probed in turn.
// Exit code 0: everything was read. 1: the node is on another chain, or there is no router there. 2: the command was wrong, or the chain
// could not be read.
import { exitWith } from "../../src/exit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface, getAddress } from "ethers";
import { NoHealthyEndpoint, QIE_CHAIN_ID, describeSelection, orderedUrls, resolveEndpoint } from "@sluice/sdk";
import { NetworkError } from "../../src/evidence";
import type { Rpc } from "../../src/evidence";
import { RpcRefused, readOnlyRpc } from "../../src/readrpc";
import { formatQie } from "../../src/guard";
import { formatQusdc } from "../../src/units";

export type Env = Record<string, string | undefined>;
export type BalancesIo = { log?: (line: string) => void; fetchImpl?: typeof fetch; rpc?: Rpc; cwd?: string };

/** Every method this command may call. Nothing here can send, sign or change anything. */
export const BALANCES_READ_ONLY_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_call"]);

class UsageError extends Error {}

const token = new Interface(["function balanceOf(address) view returns (uint256)"]);
const routerIface = new Interface(["function token() view returns (address)", "function payerBalance(address) view returns (uint256)", "function earnings(address) view returns (uint256)"]);

function address(text: string | undefined, name: string): string {
  try {
    return getAddress(String(text).trim());
  } catch {
    throw new UsageError(`${name} is not an address`);
  }
}

function parseArgs(argv: string[]): { router?: string; addresses: string[] } {
  const out: { router?: string; addresses: string[] } = { addresses: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag !== "--address" && flag !== "--router") throw new UsageError(`unknown option ${flag.slice(0, 40)} (the options are --address and --router)`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--address") out.addresses.push(address(value, "--address"));
    else if (out.router) throw new UsageError("--router was given twice");
    else out.router = address(value, "--router");
  }
  if (out.addresses.length === 0 || out.addresses.length > 12) throw new UsageError("give from 1 to 12 --address");
  return out;
}

export async function main(argv: string[], env: Env = process.env, io: BalancesIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  try {
    const args = parseArgs(argv);
    const network = env.SLUICE_NETWORK?.trim();
    if (network !== "mainnet" && network !== "testnet") throw new UsageError("set SLUICE_NETWORK to mainnet or testnet");
    let router = args.router;
    if (!router && env.SLUICE_ROUTER?.trim()) router = address(env.SLUICE_ROUTER, "SLUICE_ROUTER");
    if (!router) {
      try {
        const record = JSON.parse(readFileSync(join(io.cwd ?? process.cwd(), "deployment.json"), "utf8")) as { router?: unknown; network?: unknown };
        if (record.network === network && typeof record.router === "string") router = getAddress(record.router);
      } catch {
        // no deployment record for this network here
      }
    }
    if (!router) throw new UsageError("no router: give --router, set SLUICE_ROUTER, or run this where deployment.json is");

    let rpc = io.rpc;
    if (!rpc) {
      const selection = await resolveEndpoint(network, env.SLUICE_RPC_URL, { fetchImpl: io.fetchImpl });
      log(describeSelection(selection));
      rpc = readOnlyRpc(orderedUrls(selection), BALANCES_READ_ONLY_METHODS, io.fetchImpl);
    }
    const read: Rpc = rpc;
    const chain = BigInt(String(await read("eth_chainId", [])));
    if (chain !== BigInt(QIE_CHAIN_ID[network])) {
      log(`refused: the RPC is on chain ${chain}, but ${network} is chain ${QIE_CHAIN_ID[network]}`);
      return 1;
    }
    const block = String(await read("eth_blockNumber", []));
    const view = async (iface: Interface, to: string, name: string, values: unknown[] = []): Promise<unknown> =>
      iface.decodeFunctionResult(name, String(await read("eth_call", [{ to, data: iface.encodeFunctionData(name, values) }, block])))[0];
    let asset: string;
    try {
      asset = getAddress(String(await view(routerIface, router, "token")));
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      log(`refused: there is no router at ${router} on ${network}`);
      return 1;
    }
    log(`${network}, block ${BigInt(block)}, router ${router}. Amounts in the router are not in the wallet.`);
    for (const who of args.addresses) {
      const qie = BigInt(String(await read("eth_getBalance", [who, block])));
      const held = BigInt(String(await view(token, asset, "balanceOf", [who])));
      const prepaid = BigInt(String(await view(routerIface, router, "payerBalance", [who])));
      const earned = BigInt(String(await view(routerIface, router, "earnings", [who])));
      log(`${who}  QIE ${formatQie(qie)}  QUSDC in wallet ${formatQusdc(held)}  prepaid in router ${formatQusdc(prepaid)}  earnings in router ${formatQusdc(earned)}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      log(`refused: ${err.message}`);
      return 2;
    }
    if (err instanceof NetworkError || err instanceof RpcRefused || err instanceof NoHealthyEndpoint) {
      log("the chain could not be read. Nothing is guessed.");
      return 2;
    }
    log("the balances could not be read.");
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitWith(code),
    () => {
      console.error("live:balances failed");
      exitWith(1);
    },
  );
}
