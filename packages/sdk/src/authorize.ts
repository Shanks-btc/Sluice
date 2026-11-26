// Signing an agent session without sending a transaction: the owner signs an EIP-712 `Authorize` (or `Revoke`) for the
// AgentVault, and anyone (a facilitator, a relayer) submits it with `authorizeBySig` (or `revokeBySig`). The owner needs
// no QIE. Only the owner's key can make this signature, which is why an agent can never raise its own budget.
import { getAddress } from "ethers";
import type { TypedDataDomain } from "ethers";
import { CHAIN_ID, routerDomain } from "./protocol";
import type { TypedSigner } from "./protocol";

export const VAULT_DOMAIN_NAME = "SluiceAgentVault";
export const VAULT_DOMAIN_VERSION = "1";

export const AUTHORIZE_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Authorize: [
    { name: "payer", type: "address" },
    { name: "agent", type: "address" },
    { name: "budget", type: "uint256" },
    { name: "perCallCap", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "tools", type: "Tool[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Tool: [
    { name: "payee", type: "address" },
    { name: "toolId", type: "bytes32" },
  ],
};

export const REVOKE_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Revoke: [
    { name: "payer", type: "address" },
    { name: "agent", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const vaultDomain = (vault: string, chainId: number = CHAIN_ID): TypedDataDomain => ({
  name: VAULT_DOMAIN_NAME,
  version: VAULT_DOMAIN_VERSION,
  chainId,
  verifyingContract: getAddress(vault),
});

export type SessionGrant = { agent: string; budget: bigint; perCallCap: bigint; expiry: bigint };
export type SessionTool = { payee: string; toolId: string };

/** `nonce` is the payer's current `vault.nonces(payer)`: it advances by one with every signed authorisation or revocation. */
export async function signAuthorize(
  signer: TypedSigner,
  vault: string,
  args: { payer: string; grant: SessionGrant; tools: SessionTool[]; nonce: bigint; deadline: bigint },
  chainId: number = CHAIN_ID,
): Promise<string> {
  return signer.signTypedData(vaultDomain(vault, chainId), AUTHORIZE_TYPES, {
    payer: args.payer,
    agent: args.grant.agent,
    budget: args.grant.budget,
    perCallCap: args.grant.perCallCap,
    expiry: args.grant.expiry,
    tools: args.tools,
    nonce: args.nonce,
    deadline: args.deadline,
  });
}

// A withdrawal or a refund signed without sending a transaction: a builder (or a payer) who holds no QIE signs an EIP-712 `Withdraw` (or
// `Refund`) for the router, and a facilitator submits it with `withdrawBySig` (or `refundBySig`). The relayer fee is always zero: the
// facilitator asks for nothing. The web app signs these same messages (apps/web/src/lib/flows.ts), and docs/SPEC.md has their digests.
export const WITHDRAW_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Withdraw: [
    { name: "account", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export const REFUND_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Refund: [
    { name: "payer", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "relayerFee", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export type ExitArgs = { account: string; to: string; amount: bigint; nonce: string; deadline: bigint };

/** Signs a withdrawal of `amount` of the account's earnings to `to`. `nonce` is 32 random bytes: it makes the signature usable once. */
export async function signWithdraw(signer: TypedSigner, router: string, args: ExitArgs, chainId: number = CHAIN_ID): Promise<string> {
  return signer.signTypedData(routerDomain(router, chainId), WITHDRAW_TYPES, {
    account: getAddress(args.account),
    to: getAddress(args.to),
    amount: args.amount,
    relayerFee: 0n,
    nonce: args.nonce,
    deadline: args.deadline,
  });
}

/** Signs a refund of `amount` of the account's prepaid balance to `to`. */
export async function signRefund(signer: TypedSigner, router: string, args: ExitArgs, chainId: number = CHAIN_ID): Promise<string> {
  return signer.signTypedData(routerDomain(router, chainId), REFUND_TYPES, {
    payer: getAddress(args.account),
    to: getAddress(args.to),
    amount: args.amount,
    relayerFee: 0n,
    nonce: args.nonce,
    deadline: args.deadline,
  });
}

export async function signRevoke(
  signer: TypedSigner,
  vault: string,
  args: { payer: string; agent: string; nonce: bigint; deadline: bigint },
  chainId: number = CHAIN_ID,
): Promise<string> {
  return signer.signTypedData(vaultDomain(vault, chainId), REVOKE_TYPES, args);
}
