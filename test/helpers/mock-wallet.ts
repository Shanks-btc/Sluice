// A stand-in for an injected wallet (an EIP-1193 provider), for the web app's tests. It signs with a throwaway key made for the test,
// and sends to a local chain. It can be told to refuse, to sit on another network, or to lack a method, so the tests can drive
// every case: wrong network, a rejected signature, a wallet that cannot sign a transaction without sending it.
import { JsonRpcProvider, Wallet, hexlify, randomBytes } from "ethers";
import type { Eip1193Provider, RequestArgs } from "../../apps/web/src/lib/eip1193";

export type MockOptions = {
  chainId?: number;
  /** Reject eth_requestAccounts. */
  rejectConnect?: boolean;
  /** Reject eth_signTypedData_v4 and eth_signTransaction. */
  rejectSign?: boolean;
  /** Reject eth_sendTransaction. */
  rejectSend?: boolean;
  /** The wallet cannot sign a transaction without sending it (as MetaMask cannot). */
  noSignTransaction?: boolean;
  /** Sign typed data as this other account, so the signature is not the connected account's. */
  signAs?: Wallet;
  /** Return a signed transaction whose call data differs from what was asked. */
  swapSignedTx?: boolean;
  /** Chain ids the wallet already knows. Others make wallet_switchEthereumChain answer 4902. */
  knownChains?: number[];
};

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const refuse = (code: number, message: string) => Object.assign(new Error(message), { code });

export class MockWallet implements Eip1193Provider {
  readonly wallet: Wallet;
  readonly calls: RequestArgs[] = [];
  chainId: number;
  private readonly known: Set<number>;

  constructor(
    private readonly chain: JsonRpcProvider,
    readonly options: MockOptions = {},
    wallet: Wallet = new Wallet(hexlify(randomBytes(32))),
  ) {
    this.wallet = wallet;
    this.chainId = options.chainId ?? 1990;
    this.known = new Set(options.knownChains ?? [this.chainId]);
  }

  get address(): string {
    return this.wallet.address;
  }

  /** The requests of one kind that reached the wallet. */
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async request(args: RequestArgs): Promise<unknown> {
    this.calls.push(args);
    const params = (args.params ?? []) as unknown[];
    switch (args.method) {
      case "eth_requestAccounts":
        if (this.options.rejectConnect) throw refuse(4001, "User rejected the request.");
        return [this.address];
      case "eth_accounts":
        return [this.address];
      case "eth_chainId":
        return hex(this.chainId);
      case "wallet_switchEthereumChain": {
        const id = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        if (!this.known.has(id)) throw refuse(4902, "Unrecognized chain ID.");
        this.chainId = id;
        return null;
      }
      case "wallet_addEthereumChain": {
        const id = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        this.known.add(id);
        this.chainId = id;
        return null;
      }
      case "eth_sendTransaction": {
        if (this.options.rejectSend) throw refuse(4001, "User rejected the request.");
        const tx = params[0] as { to: string; data: string; value?: string };
        const sent = await this.wallet.connect(this.chain).sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
        return sent.hash;
      }
      case "eth_signTypedData_v4": {
        if (this.options.rejectSign) throw refuse(4001, "User rejected the request.");
        const typed = JSON.parse(String(params[1])) as { types: Record<string, Array<{ name: string; type: string }>>; domain: Record<string, unknown>; message: Record<string, unknown> };
        const { EIP712Domain: _domain, ...types } = typed.types;
        return (this.options.signAs ?? this.wallet).signTypedData(typed.domain as never, types, typed.message);
      }
      case "eth_signTransaction": {
        if (this.options.noSignTransaction) throw refuse(-32601, "The method eth_signTransaction does not exist/is not available");
        if (this.options.rejectSign) throw refuse(4001, "User rejected the request.");
        const tx = params[0] as { to: string; data: string; nonce: string; gas: string; gasPrice: string; chainId: string; type: string; value: string };
        return this.wallet.signTransaction({
          to: tx.to,
          data: this.options.swapSignedTx ? `${tx.data.slice(0, -1)}${tx.data.endsWith("0") ? "1" : "0"}` : tx.data,
          nonce: Number.parseInt(tx.nonce, 16),
          gasLimit: BigInt(tx.gas),
          gasPrice: BigInt(tx.gasPrice),
          chainId: BigInt(tx.chainId),
          type: Number.parseInt(tx.type, 16),
          value: BigInt(tx.value),
        });
      }
      default:
        throw refuse(4200, `The method ${args.method} is not supported.`);
    }
  }
}
