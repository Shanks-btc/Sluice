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
