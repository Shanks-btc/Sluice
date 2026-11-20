// A Sluice client written ONLY from docs/SPEC.md. It imports nothing from this repository: just ethers for keccak256,
// ABI encoding and raw ECDSA, and fetch for HTTP. It exists to show that the specification is enough to implement a client,
// and a test fails if this file ever imports Sluice code.
//
// It speaks MCP over Streamable HTTP as plain JSON-RPC, so it does not even use the MCP SDK.
import { AbiCoder, SigningKey, concat, getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";

const coder = AbiCoder.defaultAbiCoder();
const k = (text: string) => keccak256(toUtf8Bytes(text));

// Section 4: the type strings and the digest.
const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const PAYMENT_TYPE = "Payment(address payer,address payee,uint256 amount,bytes32 toolId,bytes32 nonce,uint256 deadline)";

export type Intent = { payer: string; payee: string; amount: string; toolId: string; nonce: string; deadline: string };

export function digestOf(router: string, chainId: number, i: Intent): string {
  const domainSeparator = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "uint256", "address"], [k(DOMAIN_TYPE), k("SluiceRouter"), k("1"), chainId, router]));
  const structHash = keccak256(
    coder.encode(["bytes32", "address", "address", "uint256", "bytes32", "bytes32", "uint256"], [k(PAYMENT_TYPE), i.payer, i.payee, i.amount, i.toolId, i.nonce, i.deadline]),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

/** r || s || v with v of 27 or 28 and a low s, which is what ethers' SigningKey produces. */
export function sign(privateKey: string, digest: string): string {
  return new SigningKey(privateKey).sign(digest).serialized;
}

export type JsonRpcResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: Array<{ type: string; text?: string }>; _meta?: Record<string, any> };

export type SpecClientOptions = {
  /** The MCP endpoint, for example http://127.0.0.1:3000/mcp */
  url: string;
  /** The signing key: the payer's, or an agent session key. */
  privateKey: string;
  /** Whose prepaid balance pays. */
  payer: string;
  /** The router this client is willing to sign for. A payment request naming another router is not paid. */
  expectedRouter: string;
  chainId?: number;
  /** Unix seconds. */
  now: () => number;
};

export class SpecClient {
  private id = 0;
  constructor(private readonly o: SpecClientOptions) {}

  private async post(body: Record<string, unknown>): Promise<Record<string, any> | undefined> {
    const res = await fetch(this.o.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text) as Record<string, any>;
  }

  async initialize(): Promise<void> {
    await this.post({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spec-client", version: "0" } },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async call(name: string, args: Record<string, unknown>, payment?: unknown): Promise<JsonRpcResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (payment) params._meta = { "x402/payment": payment }; // section 3.2
    const reply = await this.post({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params });
    if (!reply || reply.error) throw new Error(`the server returned a JSON-RPC error: ${JSON.stringify(reply?.error)}`);
    return reply.result as JsonRpcResult;
  }

  /** Section 3.1: prefer structuredContent, fall back to the JSON in content[0].text. */
  static paymentRequired(result: JsonRpcResult): Record<string, any> | undefined {
    if (!result.isError) return undefined;
    const candidates: unknown[] = [result.structuredContent];
    const text = result.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        candidates.push(JSON.parse(text));
      } catch {
        // an ordinary error message
      }
    }
    return candidates.find((c): c is Record<string, any> => typeof c === "object" && c !== null && (c as any).x402Version === 2 && Array.isArray((c as any).accepts));
  }

  /** Calls a tool, and pays at most once if the server asks. Returns the final result and whether a payment was made. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ result: JsonRpcResult; paid: boolean; refused?: string }> {
    const first = await this.call(name, args);
    const required = SpecClient.paymentRequired(first);
    if (!required) return { result: first, paid: false };

    const chainId = this.o.chainId ?? 1990;
    const offer = required.accepts.find(
      (a: any) => a.scheme === "sluice-intent" && a.network === `eip155:${chainId}` && getAddress(a.extra.router) === getAddress(this.o.expectedRouter),
    );
    if (!offer) return { result: first, paid: false, refused: "no offer for the router this client expects" };

    const intent: Intent = {
      payer: getAddress(this.o.payer),
      payee: getAddress(offer.payTo),
      amount: String(offer.amount),
      toolId: String(offer.extra.toolId),
      nonce: hexlify(randomBytes(32)),
      deadline: String(this.o.now() + Math.min(Number(offer.maxTimeoutSeconds), 300)),
    };
    const signature = sign(this.o.privateKey, digestOf(getAddress(offer.extra.router), chainId, intent));
    const payment = {
      x402Version: 2,
      resource: required.resource,
      accepted: offer,
      payload: { signature, authorization: intent },
    };
    return { result: await this.call(name, args, payment), paid: true };
  }
}
