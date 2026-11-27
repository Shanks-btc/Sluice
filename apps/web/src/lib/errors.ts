// What went wrong, in plain words, for every way a live flow can fail. A person reads three things: what happened, what to do next, and
// whether their money is safe. The raw message of a wallet, a node or a server is read here to choose the case and is never shown: it can
// hold an address, a URL or a key fragment.
import { FacilitatorUnavailable } from "@sluice/sdk/facilitator-client";
import { ERRORS } from "@sluice/sdk/protocol";
import { WalletError, classifyWalletError } from "./eip1193";

export type ErrorKind =
  | "rejected"
  | "locked"
  | "no_wallet"
  | "wrong_network"
  | "wallet_busy"
  | "unsupported_wallet"
  | "insufficient_qusdc"
  | "insufficient_allowance"
  | "insufficient_prepaid"
  | "insufficient_gas"
  | "nonce"
  | "underpriced"
  | "reverted"
  | "session_missing"
  | "session_expired"
  | "session_limit"
  | "tool_not_allowed"
  | "tool_down"
  | "facilitator_down"
  | "kill_switch"
  | "daily_limit"
  | "rpc_down"
  | "stale_quote"
  | "payment_expired"
  | "duplicate"
  | "rate_limited"
  | "refused"
  | "not_configured"
  | "unknown";

/** When trying again makes sense. "now": straight away. "later": after the service recovers. "change": only after the person changes something. "no": do not retry. */
export type Retry = "now" | "later" | "change" | "no";

export type Explained = {
  kind: ErrorKind;
  /** What happened. */
  headline: string;
  /** What to do next. */
  advice: string;
  retry: Retry;
  /** Whether any money moved or is at risk, in a sentence. */
  funds: string;
};

/** Where in a paid call a failure happened, so "the tool server did not answer" is not confused with "the facilitator did not answer". */
export type Stage = "tool_server" | "facilitator" | "wallet" | "chain";

/** A failure of a paid call that has a name: a Sluice error code from the tool server or the facilitator, or a plain problem at a stage. */
export class SluiceCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stage: Stage,
  ) {
    super(message);
    this.name = "SluiceCallError";
  }
}

const NOTHING_SENT = "Nothing was sent and no money moved.";
const NOTHING_CHARGED = "You were not charged. Your prepaid balance in the router is unchanged and is still yours.";

const E = (kind: ErrorKind, headline: string, advice: string, retry: Retry, funds: string): Explained => ({ kind, headline, advice, retry, funds });

/** The cases a Sluice error code names, from docs/SPEC.md's error table. */
function fromCode(code: string): Explained | undefined {
  switch (code) {
    case ERRORS.insufficientFunds:
      return E("insufficient_prepaid", "Your prepaid balance in the router is too low for this call.", "Deposit more QUSDC, then make the call again.", "change", NOTHING_CHARGED);
    case ERRORS.sessionNotFound:
      return E("session_missing", "This agent key has no session: it was never authorised, or it was revoked.", "Authorise a session for it on the Wallet page, then try again.", "change", NOTHING_CHARGED);
    case ERRORS.sessionExpired:
      return E("session_expired", "This agent key's session has expired.", "Authorise a new session on the Wallet page, then try again.", "change", NOTHING_CHARGED);
    case ERRORS.perCallCap:
    case ERRORS.budgetExceeded:
      return E("session_limit", "This call is above what the agent key's session allows.", "Raise the budget or the cap per call by authorising a new session, or make a smaller call.", "change", NOTHING_CHARGED);
    case ERRORS.toolNotAllowed:
      return E("tool_not_allowed", "This agent key is not allowed to pay for this tool.", "Authorise a session that lists this tool and its payee.", "change", NOTHING_CHARGED);
    case ERRORS.killSwitch:
      return E(
        "kill_switch",
        "The operator has paused payments and top-ups.",
        "Reading still works. Try again later, and see the Status page. You can take your prepaid balance back at any time with a refund from a wallet that holds QIE.",
        "later",
        NOTHING_CHARGED,
      );
    case ERRORS.facilitatorUnavailable:
    case ERRORS.storeUnavailable:
      return E("facilitator_down", "The facilitator cannot take payments just now.", "Try again in a few minutes, and see the Status page. Your balance stays in the router and stays yours.", "later", NOTHING_CHARGED);
    case ERRORS.capPayerDaily:
    case ERRORS.capGlobalDaily:
    case ERRORS.capBudget:
    case ERRORS.capGasPrice:
      return E("daily_limit", "The service has reached one of its limits for now.", "Try again later. The limits are there to cap what a fault could cost.", "later", NOTHING_CHARGED);
    case ERRORS.rateLimited:
      return E("rate_limited", "Too many requests came from your connection.", "Wait a minute and try again.", "later", NOTHING_CHARGED);
    case ERRORS.paymentPending:
    case "payment_in_progress":
      return E("unknown", "Your payment is not yet known to have settled, so the answer is held back.", "Do not sign a new payment yet. Look in your activity in a few minutes.", "no", "It may still settle. If it does, you are charged once for it.");
    case ERRORS.paymentNotTaken:
      return E("facilitator_down", "The payment could not be settled, so no answer was given.", "Try again in a few minutes, and see the Status page.", "later", NOTHING_CHARGED);
    case "unconfirmed":
      return E("tool_down", "The tool server did not answer after you signed.", "Look in your activity before signing again, and see the Status page.", "later", "The payment may have reached it. If it settles, you are charged once for it.");
    case ERRORS.amountTooLow:
    case ERRORS.acceptedMismatch:
    case ERRORS.payeeMismatch:
    case ERRORS.toolMismatch:
      return E("stale_quote", "The price or the payee changed while you were deciding.", "The call was not paid. Ask for the price again, read it, and confirm the new one.", "change", NOTHING_CHARGED);
    case ERRORS.expired:
    case ERRORS.deadlineTooFar:
      return E("payment_expired", "The signed payment ran out of time before it was used.", "Sign a new one. The old signature can no longer be used.", "now", NOTHING_CHARGED);
    case ERRORS.nonceUsed:
    case ERRORS.intentReplayed:
      return E(
        "duplicate",
        "This payment was already submitted once.",
        "Look in your activity for its settlement before signing again. Sign again only if the earlier one failed.",
        "no",
        "A payment is settled once: the second submission was refused, so you were not charged twice.",
      );
    case ERRORS.invalidNetwork:
    case ERRORS.invalidAsset:
    case ERRORS.invalidRouter:
      return E("refused", "The tool server is set up for a different network, token or router than this page.", "Nothing was signed that could be used elsewhere. Tell the site's operator.", "no", NOTHING_CHARGED);
    default:
      return undefined;
  }
}

/** The case for any failure. Always returns something a person can act on. */
export function explain(err: unknown): Explained {
  if (err instanceof SluiceCallError) {
    const named = fromCode(err.code);
    if (named) return named;
    if (err.stage === "tool_server") {
      // Not answering at all, or answering with something unreadable, is "down". An answer with an error code this page does not know is a refusal.
      if (["unreachable", "unreadable", "too_large"].includes(err.code)) {
        return E("tool_down", "The tool server did not answer.", "Try again in a minute, and see the Status page.", "later", NOTHING_CHARGED);
      }
      return E("refused", "The tool server did not accept the payment.", "Try again in a minute. If it happens again, tell the tool's builder.", "later", NOTHING_CHARGED);
    }
    if (err.stage === "facilitator") {
      return E("facilitator_down", "The facilitator did not answer.", "Try again in a few minutes, and see the Status page. Your balance stays in the router and stays yours.", "later", NOTHING_CHARGED);
    }
    return E("refused", "The request was refused.", "Check what you entered and try again.", "change", NOTHING_CHARGED);
  }
  if (err instanceof FacilitatorUnavailable) {
    return E("facilitator_down", "The facilitator did not answer.", "Try again in a few minutes, and see the Status page. Your balance stays in the router and stays yours.", "later", NOTHING_SENT);
  }
  if (err instanceof WalletError || (typeof err === "object" && err !== null)) {
    const code = classifyWalletError(err);
    switch (code) {
      case "rejected":
        return E("rejected", "You rejected the request in your wallet.", "Press the button again when you are ready.", "now", NOTHING_SENT);
      case "locked":
        return E("locked", "Your wallet is locked.", "Unlock it, then connect again.", "now", NOTHING_SENT);
      case "no_wallet":
        return E("no_wallet", "No wallet was found in this browser.", "Install QIE Wallet or MetaMask, then reload the page.", "change", NOTHING_SENT);
      case "wrong_network":
      case "unknown_chain":
        return E("wrong_network", "Your wallet is on a different network than this page.", "Use the Switch network button, then try again.", "change", NOTHING_SENT);
      case "request_pending":
        return E("wallet_busy", "Your wallet already has a request waiting.", "Open your wallet, answer it, then try again.", "now", NOTHING_SENT);
      case "unsupported_method":
        // A flow that knows exactly which request the wallet cannot do says so in its own words, and those are shown.
        return E("unsupported_wallet", "Your wallet cannot do this kind of request.", err instanceof WalletError && err.message.trim() !== "" ? err.message : "Use QIE Wallet or MetaMask, or add a little QIE and use the direct route.", "change", NOTHING_SENT);
      case "insufficient_gas":
        return E("insufficient_gas", "Your wallet holds too little QIE to pay the network fee.", "Add a little QIE, or use the route that needs none if a facilitator is set.", "change", NOTHING_SENT);
      case "nonce":
        return E("nonce", "Your wallet's transaction count is out of date.", "Another transaction from it is probably still finishing. Wait a few seconds and try again.", "now", NOTHING_SENT);
      case "underpriced":
        return E("underpriced", "The network fee in the request was too low, or the same transaction is already waiting.", "Check your wallet for a pending transaction, wait a moment, and try again.", "now", "Check your wallet's pending list before retrying: a transaction may already be waiting.");
      case "reverted":
        return E("reverted", "The network says this would fail, so it was not sent.", "Check your QUSDC balance, the approval, and for an agent key its limits.", "change", NOTHING_SENT);
      case "node_down":
        return E("rpc_down", "The QIE network node did not answer.", "The page tries other QIE nodes for reading. Wait a moment and try again.", "later", "If your wallet shows a pending transaction, check the explorer before retrying.");
      default:
        break;
    }
    const message = err instanceof Error ? err.message : "";
    if (/allowance/i.test(message)) {
      return E("insufficient_allowance", "The router is not yet approved to move that much QUSDC.", "Run the deposit again: it approves the exact amount first.", "change", NOTHING_SENT);
    }
    if (/exceeds balance|insufficient (qusdc|balance|token)/i.test(message)) {
      return E("insufficient_qusdc", "Your wallet holds less QUSDC than this needs.", "Add QUSDC or use a smaller amount.", "change", NOTHING_SENT);
    }
    if (/facilitator refused/i.test(message)) {
      return E("refused", "The facilitator refused the request.", "Its reason is not shown here. Try the direct route with a little QIE, or try again later.", "later", NOTHING_SENT);
    }
    if (/different from what was shown|different account|does not match what was shown|signed something different/i.test(message)) {
      return E("refused", "Your wallet returned something other than what was shown, so nothing was sent.", "Nothing was used. Try again, and check that the wallet shows the same details as this page.", "now", NOTHING_SENT);
    }
    if (/not confirmed yet/i.test(message)) {
      return E("unknown", "The transaction was sent but is not confirmed yet.", "Check the explorer for it before sending anything again.", "no", "Money may have moved. Check before you retry.");
    }
    if (/failed on the network/i.test(message)) {
      return E("reverted", "The transaction was sent and failed on the network.", "Check the explorer for the reason, and your balances, before trying again.", "change", "A failed transaction moves no QUSDC, and costs only the network fee.");
    }
  }
  if (err instanceof TypeError) {
    // fetch() fails with a TypeError when the server cannot be reached at all.
    return E("tool_down", "The service could not be reached from your browser.", "Check your connection and try again. See the Status page for the service itself.", "later", NOTHING_SENT);
  }
  return E("unknown", "Something went wrong, and nothing further was sent.", "Check your wallet and the explorer before trying again.", "no", "If you are unsure whether anything moved, check the explorer first.");
}

/** One line for a place that has room for only one. */
export const explainLine = (err: unknown): string => {
  const e = explain(err);
  return `${e.headline} ${e.advice}`;
};

/** A sentence about the network fee, from the live gas price the page read: "about 0.0002 QIE". */
export function costLine(gasUnits: bigint, gasPriceWei: bigint, upTo: boolean): string {
  const wei = gasUnits * gasPriceWei;
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  const qie = frac ? `${whole}.${frac}` : `${whole}`;
  const gwei = Number(gasPriceWei) / 1e9;
  return `${upTo ? "Up to" : "About"} ${qie === "0" ? "less than 0.000001" : qie} QIE in network fees (${gasUnits.toString()} gas at ${Number.isFinite(gwei) ? gwei.toPrecision(4).replace(/\.?0+$/, "") : "?"} gwei, read just now).`;
}
