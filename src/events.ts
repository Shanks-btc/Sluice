// The events docs/EVIDENCE.md can record, and where to find the amount and the actor in each.
//
// These human-readable ABI fragments must match the events in the compiled contracts. A test
// (test/unit/Evidence.test.ts) compares them with the compiled artifacts, so drift is caught.

export type Which = "router" | "vault";

export type EventSpec = {
  /** Which contract emits it: the PaymentRouter or its AgentVault. */
  contract: Which;
  /** The event as an ethers human-readable ABI fragment. */
  fragment: string;
  /** The field that carries the amount in token units, or undefined when the event has no amount. */
  amountField?: string;
  /** The indexed address field that says who the row is about. */
  whoField: string;
};

export const EVENTS: Readonly<Record<string, EventSpec>> = {
  Deposited: {
    contract: "router",
    fragment: "event Deposited(address indexed account, address indexed from, uint256 amount)",
    amountField: "amount",
    whoField: "account",
  },
  Settled: {
    contract: "router",
    fragment:
      "event Settled(address indexed payer, address indexed payee, bytes32 indexed toolId, uint256 amount, uint256 fee, bytes32 nonce, address signer)",
    amountField: "amount",
    whoField: "payer",
  },
  Withdrawn: {
    contract: "router",
    fragment:
      "event Withdrawn(address indexed account, address indexed to, uint256 amount, address relayer, uint256 relayerFee)",
    amountField: "amount",
    whoField: "account",
  },
  Refunded: {
    contract: "router",
    fragment:
      "event Refunded(address indexed payer, address indexed to, uint256 amount, address relayer, uint256 relayerFee)",
    amountField: "amount",
    whoField: "payer",
  },
  SessionAuthorized: {
    contract: "vault",
    fragment:
      "event SessionAuthorized(address indexed payer, address indexed agent, uint64 indexed sessionId, uint256 budget, uint256 perCallCap, uint256 expiry, bytes32 toolsHash)",
    amountField: "budget",
    whoField: "payer",
  },
  SessionRevoked: {
    contract: "vault",
    fragment: "event SessionRevoked(address indexed payer, address indexed agent, uint64 indexed sessionId)",
    whoField: "payer",
  },
};

export const EVENT_NAMES = Object.keys(EVENTS);
