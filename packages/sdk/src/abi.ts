// The slice of the PaymentRouter, AgentVault and QUSDC interfaces that the packages call, as ethers
// human-readable fragments. A test compares them with the compiled contracts, so they cannot drift.
import { Interface, id } from "ethers";

const INTENT = "tuple(address payer, address payee, uint256 amount, bytes32 toolId, bytes32 nonce, uint256 deadline)";

export const ROUTER_ABI = [
  "function token() view returns (address)",
  "function vault() view returns (address)",
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function payerBalance(address) view returns (uint256)",
  "function earnings(address) view returns (uint256)",
  "function nonceUsed(address, bytes32) view returns (bool)",
  "function domainSeparator() view returns (bytes32)",
  `function hashPayment(${INTENT} intent) view returns (bytes32)`,
  "function deposit(uint256 amount)",
  `function settle(${INTENT} intent, bytes signature)`,
  `function batchSettle(${INTENT}[] intents, bytes[] signatures) returns (uint256 settled)`,
  "function withdrawBySig(address account, address to, uint256 amount, uint256 relayerFee, bytes32 nonce, uint256 deadline, bytes signature)",
  "function refundBySig(address payer, address to, uint256 amount, uint256 relayerFee, bytes32 nonce, uint256 deadline, bytes signature)",
  "event Deposited(address indexed account, address indexed from, uint256 amount)",
  "event Settled(address indexed payer, address indexed payee, bytes32 indexed toolId, uint256 amount, uint256 fee, bytes32 nonce, address signer)",
  "event SettleSkipped(uint256 indexed index, address indexed payer, bytes32 nonce, bytes4 reason)",
  "event Withdrawn(address indexed account, address indexed to, uint256 amount, address relayer, uint256 relayerFee)",
  "event Refunded(address indexed payer, address indexed to, uint256 amount, address relayer, uint256 relayerFee)",
] as const;

export const VAULT_ABI = [
  "function router() view returns (address)",
  "function sessionOf(address payer, address agent) view returns (tuple(uint128 budget, uint128 spent, uint128 perCallCap, uint64 expiry, uint64 id))",
  "function remainingBudget(address payer, address agent) view returns (uint256)",
  "function isToolAllowed(address payer, address agent, address payee, bytes32 toolId) view returns (bool)",
  "function nonces(address payer) view returns (uint256)",
  "function authorizeBySig(address payer, tuple(address agent, uint256 budget, uint256 perCallCap, uint256 expiry) grant, tuple(address payee, bytes32 toolId)[] tools, uint256 deadline, bytes signature)",
  "function revokeBySig(address payer, address agent, uint256 deadline, bytes signature)",
  "event SessionAuthorized(address indexed payer, address indexed agent, uint64 indexed sessionId, uint256 budget, uint256 perCallCap, uint256 expiry, bytes32 toolsHash)",
  "event SessionRevoked(address indexed payer, address indexed agent, uint64 indexed sessionId)",
  "event SessionSpent(address indexed payer, address indexed agent, uint64 indexed sessionId, uint256 amount, uint256 remainingBudget)",
] as const;

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

export const routerInterface = new Interface(ROUTER_ABI as unknown as string[]);
export const vaultInterface = new Interface(VAULT_ABI as unknown as string[]);
export const erc20Interface = new Interface(ERC20_ABI as unknown as string[]);

/** Every error name in ISluiceErrors. A SettleSkipped reason is the four-byte selector of one of them. */
export const CONTRACT_ERROR_NAMES = [
  "ZeroAddress",
  "ZeroAmount",
  "Expired",
  "InvalidSignature",
  "NotOwner",
  "FeeTooHigh",
  "Reentrancy",
  "NonceAlreadyUsed",
  "InsufficientBalance",
  "UnexpectedTransferAmount",
  "TransferFailed",
  "RelayerFeeTooHigh",
  "ArrayLengthMismatch",
  "EmptyBatch",
  "InvalidPayee",
  "NotRouter",
  "InvalidSession",
  "EmptyToolList",
  "TooManyTools",
  "SessionNotFound",
  "SessionExpired",
  "PerCallCapExceeded",
  "BudgetExceeded",
  "ToolNotAllowed",
] as const;

const BY_SELECTOR = new Map<string, string>(CONTRACT_ERROR_NAMES.map((n) => [id(`${n}()`).slice(0, 10), n]));

/** "0x7c9a1cf9" -> "NonceAlreadyUsed". Unknown selectors come back as themselves. */
export function errorNameOf(selector: string): string {
  return BY_SELECTOR.get(selector.toLowerCase()) ?? selector;
}
