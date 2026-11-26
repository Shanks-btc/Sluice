// Words that appear on more than one page, kept in one place. All copy on the site is plain and specific, and a test scans it (and every
// other string in the app) for claims nothing here can back up.

/** The idea, word for word. It is shown on the landing page and in the page description, and never reworded anywhere. */
export const IDEA =
  "Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys.";

export const IDEA_SENTENCES = [
  "Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use.",
  "Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys.",
] as const;

export const SITE_TITLE = "Sluice";
export const SITE_DESCRIPTION = IDEA;

export const HOW_STEPS = [
  {
    title: "A builder wraps a tool with the SDK",
    body: "Put a price in QUSDC and a payee on an MCP tool. A call that arrives without payment is answered with the price, in the x402-over-MCP message format.",
  },
  {
    title: "An agent pays per call in QUSDC",
    body: "The agent's payment proxy checks the price against the budget its owner set, signs an intent with a session key, and retries the call. No subscription and no API key.",
  },
  {
    title: "Payments settle in batches on QIE",
    body: "A facilitator submits many signed intents in one transaction. The router moves balances, and QUSDC leaves it when a builder withdraws or a payer refunds.",
  },
] as const;

export const PROBLEMS = [
  "A monthly plan and an API key need a human to sign up first.",
  "A card payment has minimums and fees that make a price of a fraction of a cent impossible.",
  "One on-chain transfer per call means a wallet signature and a transaction for every call.",
  "An agent holding a wallet key with no limit can spend everything it can reach.",
] as const;

export const SAFETY = [
  {
    title: "Contracts that cannot be changed",
    body: "There is no proxy, no pause, no delegatecall and no selfdestruct. A test reads the compiled bytecode and fails if any of them appears.",
  },
  {
    title: "A fee capped in code",
    body: "The fee comes out of the builder's side, and the contract refuses anything above 2% (200 basis points). A payer always pays exactly the signed amount.",
  },
  {
    title: "An owner with two powers",
    body: "The owner can set the fee within the cap and change who is credited with it. The owner cannot move, freeze or take anyone's balance.",
  },
  {
    title: "Agent keys with limits on chain",
    body: "A session key has a budget, a cap per call, an expiry and a list of tools. The vault enforces them in the transaction that settles the payment, and a key cannot raise its own limits.",
  },
  {
    title: "No open allowance",
    body: "A deposit approves exactly the amount deposited, so no standing allowance is left open to the router.",
  },
  {
    title: "Leave at any time",
    body: "A payer can refund the unspent balance and a builder can withdraw earnings, with no delay, no pause and no one to ask. With no QIE, a signed request sent by a relayer does the same.",
  },
] as const;

export const QUSDC_FINDING = {
  heading: "QUSDC's admin can burn any holder's balance",
  body: "This risk is in QUSDC, not in Sluice. Read from QIE mainnet on 2026-11-18 with read-only calls: the token has a role, VAULT_ROLE, that allows burning the QUSDC held by any account with no approval from that account, and the account that holds the admin role can grant that role to any address, itself included.",
  facts: [
    ["Token", "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5"],
    ["VAULT_ROLE holder (a contract)", "0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45"],
    ["DEFAULT_ADMIN_ROLE holder (an account)", "0xe1acec6312eb701D4A14De700CCec8DeE17a8D28"],
  ],
  tested: "A fork test impersonates the admin, grants it the role and burns QUSDC from an ordinary wallet and from the router. Both work. It was not tried on the live chain, because nothing was sent.",
  advice: "Keep prepaid balances small, refund what is unspent and withdraw earnings often. The contracts cannot remove a power that QUSDC's admin holds.",
  others: [
    "No outside security review has been done.",
    "The contracts cannot be fixed after deployment, so a bug would stay.",
    "A paid server runs the tool before it is paid, so a payer who refunds in between leaves the call unpaid.",
  ],
} as const;

/** What the contracts' owner can and cannot do, as the README states it. A test holds these rows to the README's table. */
export const OWNER_POWERS = [
  ["Can", "Change the fee", "Never above 200 basis points (2%), and it applies to later settlements."],
  ["Can", "Change who is credited the fee", "Fees already credited stay with their holder."],
  ["Cannot", "Move, freeze or take a payer's balance or a builder's earnings", "No function does it."],
  ["Cannot", "Pause, upgrade or replace the contracts", "No proxy, no pause, no delegatecall, no selfdestruct. A test reads the bytecode."],
  ["Cannot", "Change the token, the vault or the owner", "They are fixed at deployment."],
  ["Cannot", "Spend an agent's session", "The router does it, inside the limits the payer set."],
] as const;

/** The facilitator's limits: the default each starts at and the ceiling no setting can pass. A test holds these to packages/facilitator/src/caps.ts. */
export const FACILITATOR_LIMITS = [
  ["QIE the relayer may spend in a day, gas and top-ups together", "0.5 QIE", "2 QIE"],
  ["Highest gas price the relayer pays", "2 gwei", "5 gwei"],
  ["QIE one top-up may carry", "0.001 QIE", "0.0015 QIE"],
  ["QIE sent to one address in a day", "0.001 QIE", "0.003 QIE"],
  ["QUSDC one zero-QIE start may deposit", "10 QUSDC", "100 QUSDC"],
  ["Zero-QIE starts per payer in a day", "1", "3"],
  ["Relayed withdrawals or refunds per account in a day", "3", "10"],
  ["QUSDC one payer may have queued in a day", "50 QUSDC", "1,000 QUSDC"],
  ["QUSDC all payers together may have queued in a day", "500 QUSDC", "10,000 QUSDC"],
  ["Payments in one batch", "50", "50"],
] as const;

/** Limits that apply to someone using this site, as sentences. The cap is the site's own setting, so it is passed in (QUSDC units). */
export function liveLimits(sessionCapUnits: number): string[] {
  const cap = (sessionCapUnits / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
  return [
    `This site lets one session put at most ${cap} QUSDC in the router, and keeps the prepaid balance it tops up at or below that. A single paid call is held to the same ceiling. The contracts have no such limit; it is the site's own.`,
    "The fee is taken from the builder's side and is capped in the contract at 2% (200 basis points). A payer pays exactly the price they signed.",
    "An agent key spends only inside the budget, the cap per call, the expiry and the tool list its owner set, and the vault enforces them on chain.",
    "A signed payment can be used once, for the price and the payee it names, and expires within the hour.",
    "No outside security review of the contracts or the services has been done.",
  ];
}
