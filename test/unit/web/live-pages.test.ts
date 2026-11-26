// What the new pages and dialogs show, rendered to HTML: the demo's two modes, the live demo's states, the status page, the security page, the
// terms and privacy pages, the review dialogs, and the navigation. The browser tests cover clicking; these cover the words, and that the
// pages say nothing the code does not back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { getAddress } from "ethers";
import { DEMO_TABS, DemoTabs } from "../../../apps/web/src/components/demo-tabs";
import { FlowDialog } from "../../../apps/web/src/components/flow-dialog";
import { Footer } from "../../../apps/web/src/components/footer";
import { HistoryPanel } from "../../../apps/web/src/components/history-panel";
import { LiveDemo } from "../../../apps/web/src/components/live-demo";
import { NAV_LINKS } from "../../../apps/web/src/components/nav";
import { PaidCallDialog } from "../../../apps/web/src/components/paid-call-dialog";
import { PaidCallPanel, SettlementLine } from "../../../apps/web/src/components/paid-call-panel";
import { SecurityView } from "../../../apps/web/src/components/security-view";
import { StatusView, ago } from "../../../apps/web/src/components/status-view";
import { DemoBody } from "../../../apps/web/src/components/demo-body";
import { LegalDoc } from "../../../apps/web/src/components/legal-doc";
import { content } from "../../../apps/web/src/lib/content";
import { DRAFT_BANNER } from "../../../apps/web/src/lib/content-types";
import { readConfig } from "../../../apps/web/src/lib/config";
import { FlowSession } from "../../../apps/web/src/lib/flows";
import type { Plan } from "../../../apps/web/src/lib/flows";
import { PaidCallSession } from "../../../apps/web/src/lib/paid-call";
import type { PaidCallDeps, PaidCallPlan, SettlementView } from "../../../apps/web/src/lib/paid-call";
import type { ServiceStatus } from "../../../apps/web/src/lib/service-status";
import { h, html, textOf, withApp } from "../../../apps/web/test-support/render";

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const ROUTER = getAddress(`0x${"12".repeat(20)}`);
const VAULT = getAddress(`0x${"34".repeat(20)}`);
const full = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: ROUTER, NEXT_PUBLIC_VAULT_ADDRESS: VAULT, NEXT_PUBLIC_FACILITATOR_URL: "https://facilitator.example", NEXT_PUBLIC_TOOLS_URL: "https://tools.example" });
const local = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: ROUTER, NEXT_PUBLIC_VAULT_ADDRESS: VAULT, NEXT_PUBLIC_FACILITATOR_URL: "http://127.0.0.1:8402", NEXT_PUBLIC_TOOLS_URL: "http://127.0.0.1:8403", NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545" });

describe("Live pages: the demo's two modes", () => {
  it("has the real payment first and selected, and the sandbox second, labelled as no funds", () => {
    expect(DEMO_TABS.map((t) => t.label)).to.deep.equal(["Real payment", "Sandbox (no funds)"]);
    const out = html(h(DemoTabs, { live: h("p", null, "LIVE-BODY"), sandbox: h("p", null, "SANDBOX-BODY") }));
    expect(out).to.match(/data-testid="tab-live"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-testid="tab-live"/);
    expect(out).to.match(/aria-selected="false"[^>]*data-testid="tab-sandbox"|data-testid="tab-sandbox"[^>]*aria-selected="false"/);
    expect(out).to.match(/data-testid="panel-sandbox"[^>]*hidden|hidden=""[^>]*data-testid="panel-sandbox"/);
    expect(out).to.not.match(/data-testid="panel-live"[^>]*hidden/);
    expect(out).to.contain("Sandbox: simulated, no wallet, no chain, no funds");
    expect(out).to.contain("nothing here is counted as evidence");
    expect(out).to.contain("LIVE-BODY");
  });

  it("can open on the sandbox only when told to, and the demo page never does", () => {
    const sandboxFirst = html(h(DemoTabs, { live: h("i"), sandbox: h("b"), initial: "sandbox" }));
    expect(sandboxFirst).to.match(/aria-selected="true"[^>]*data-testid="tab-sandbox"|data-testid="tab-sandbox"[^>]*aria-selected="true"/);
    const page = html(withApp(h(DemoBody), readConfig({})));
    expect(page).to.match(/data-testid="tab-live"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-testid="tab-live"/);
    expect(page.indexOf("Real payment")).to.be.lessThan(page.indexOf("Sandbox (no funds)"));
  });

  it("introduces the demo as a real payment with the wallet's review first, and keeps the facilitator reader and the risk check below", () => {
    const text = textOf(withApp(h(DemoBody), readConfig({})));
    expect(text).to.contain("Pay for one real tool call");
    expect(text).to.contain("Every step shows what your wallet will be asked to sign before it opens");
    expect(text).to.contain("Read a facilitator");
    expect(text).to.contain("Risk check");
  });
});

describe("Live pages: the live demo", () => {
  it("says what is missing and does not pretend, when the site is not set up for it", () => {
    const text = textOf(withApp(h(LiveDemo), readConfig({})));
    expect(text).to.contain("This site is not set up for real payments yet");
    expect(text).to.contain("NEXT_PUBLIC_ROUTER_ADDRESS");
    expect(text).to.contain("NEXT_PUBLIC_FACILITATOR_URL");
    expect(text).to.contain("NEXT_PUBLIC_TOOLS_URL");
    expect(text).to.contain("Nothing on this page is simulated");
    expect(text).to.not.contain("Review deposit");
  });

  it("names the network and says the funds are real on mainnet, and that they have no value on a local node", () => {
    const real = textOf(withApp(h(LiveDemo), full));
    expect(real).to.contain("QIE mainnet, chain 1990.");
    expect(real).to.contain("real QUSDC");
    expect(real).to.contain("will not let one session put in more than its cap");
    const test = textOf(withApp(h(LiveDemo), local));
    expect(test).to.match(/no real funds|have no value/);
    expect(test).to.not.contain("real QUSDC");
  });

  it("walks the steps in order, with the deposit's cap and the zero-QIE explanation ready, and asks the person to connect first", () => {
    const text = textOf(withApp(h(LiveDemo), full));
    const at = (s: string) => text.indexOf(s);
    expect(at("1. Connect")).to.be.greaterThan(-1);
    expect(at("2. Your balances")).to.be.greaterThan(at("1. Connect"));
    expect(at("3. Put a small amount in the router")).to.be.greaterThan(at("2. Your balances"));
    expect(at("4. Pay for a real tool call")).to.be.greaterThan(at("3. Put a small amount in the router"));
    expect(text).to.contain("put in more than 1.000000 QUSDC");
    expect(text).to.contain("Connect your wallet on QIE mainnet to see them");
    const out = html(withApp(h(LiveDemo), full));
    expect(out).to.match(/value="0\.1"/); // the default deposit is 0.10 QUSDC
    expect(out).to.match(/data-testid="live-deposit-review"[^>]*disabled|disabled=""[^>]*data-testid="live-deposit-review"/); // nothing to review before a wallet is connected
  });

  it("shows the session cap this site is set to, not a fixed one", () => {
    const capped = readConfig({ NEXT_PUBLIC_ROUTER_ADDRESS: ROUTER, NEXT_PUBLIC_VAULT_ADDRESS: VAULT, NEXT_PUBLIC_FACILITATOR_URL: "https://f.example", NEXT_PUBLIC_TOOLS_URL: "https://t.example", NEXT_PUBLIC_SESSION_CAP_QUSDC: "0.25" });
    expect(textOf(withApp(h(LiveDemo), capped))).to.contain("put in more than 0.250000 QUSDC");
  });
});

describe("Live pages: the paid call panel and the activity list", () => {
  it("says no tool server is set when there is none, and offers a price check only when there is", () => {
    const none = html(withApp(h(PaidCallPanel, { reader: null, account: null, deps: null }), readConfig({})));
    expect(none).to.contain("tools-unconfigured");
    expect(textOf(withApp(h(PaidCallPanel, { reader: null, account: null, deps: null }), readConfig({})))).to.contain("NEXT_PUBLIC_TOOLS_URL");
    const set = html(withApp(h(PaidCallPanel, { reader: null, account: null, deps: null, title: "Test your tool" }), full));
    expect(set).to.contain("tools-loading");
    expect(set).to.contain("Test your tool");
  });

  it("shows each state of a settlement in words: pending, settled with a receipt, not settled, and not known", () => {
    const pending = textOf(h(SettlementLine, { view: { state: "pending", status: "queued" } as SettlementView }));
    expect(pending).to.contain("Settling: queued").and.to.contain("usually within a minute");
    const settled = html(h(SettlementLine, { view: { state: "settled", status: "settled", receipt: { transaction: `0x${"c1".repeat(32)}`, blockNumber: 12345, timestamp: 1_800_000_000, payer: ROUTER, payee: VAULT, amount: 10_000n, fee: 100n, toolId: `0x${"ab".repeat(32)}`, nonce: `0x${"cd".repeat(32)}`, explorerUrl: `https://mainnet.qie.digital/tx/0x${"c1".repeat(32)}` } } as SettlementView }));
    expect(settled).to.contain("Settled on chain");
    expect(settled).to.contain(`href="https://mainnet.qie.digital/tx/0x${"c1".repeat(32)}"`);
    expect(settled).to.contain("12,345");
    expect(settled).to.contain("0.010000 QUSDC");
    expect(settled).to.contain("built from the router");
    const bad = textOf(h(SettlementLine, { view: { state: "not_settled", status: "expired", reason: "deadline" } as SettlementView }));
    expect(bad).to.contain("The payment was not settled: expired (deadline)");
    const unknown = textOf(h(SettlementLine, { view: { state: "unknown", reason: "No facilitator address is set." } as SettlementView, onCheck: () => undefined }));
    expect(unknown).to.contain("Not known").and.to.contain("Check again");
  });

  it("starts the activity list with what it reads and no table until it has read something, and never a made-up row", () => {
    const text = textOf(withApp(h(HistoryPanel, { reader: {} as never, account: ROUTER }), full));
    expect(text).to.contain("Activity");
    expect(text).to.contain("deposits, payments for tool calls, what you earned as a builder, refunds, withdrawals, and agent keys authorised or revoked");
    expect(html(withApp(h(HistoryPanel, { reader: {} as never, account: ROUTER }), full))).to.not.contain("history-table");
  });
});

describe("Live pages: the review dialogs", () => {
  const plan = (over: Partial<Plan> = {}): Plan => ({
    kind: "deposit",
    route: "wallet",
    title: "Deposit QUSDC",
    summary: "Your wallet will send the transactions itself.",
    fields: [{ label: "Amount", value: "0.100000 QUSDC" }, { label: "Network", value: "QIE mainnet, chain 1990 (real funds)" }],
    steps: ["Approve", "Deposit"],
    warnings: ["A deposit stays yours."],
    gas: { units: 160_000n, priceWei: 1_125_000_000n, costWei: 160_000n * 1_125_000_000n },
    input: { kind: "deposit", route: "wallet", amount: 100_000n, needsApprove: true, gasPrice: 1_125_000_000n },
    ...over,
  });

  it("shows a deposit's fields, its steps and a cost line from the live gas price, and sends nothing until Confirm", () => {
    const session = new FlowSession(plan(), {} as never);
    const out = html(withApp(h(FlowDialog, { session, onClose: () => undefined }), full));
    expect(out).to.contain("Review before your wallet opens");
    expect(out).to.contain("0.100000 QUSDC");
    expect(out).to.contain("Up to 0.00018 QUSDC".replace("QUSDC", "QIE") + " in network fees (160000 gas at 1.125 gwei, read just now).");
    expect(out).to.contain("Nothing is sent until you press Confirm");
    expect(out).to.contain("Confirm and open wallet");
    expect(out).to.not.contain("flow-pending");
    expect(session.state).to.equal("planned");
  });

  it("says a route through the facilitator costs the person no network fee, and asks for a signature, not a transaction", () => {
    const session = new FlowSession(plan({ route: "facilitator", gas: undefined, title: "Deposit QUSDC with no QIE" }), {} as never);
    const out = html(withApp(h(FlowDialog, { session, onClose: () => undefined }), full));
    expect(out).to.contain("You pay no network fee on this route.");
    expect(out).to.contain("Confirm and sign in wallet");
  });

  const paidPlan = (): PaidCallPlan => ({
    title: "Pay for contract lookup",
    summary: "Your wallet will sign one payment message.",
    fields: [{ label: "Price", value: "0.005000 QUSDC" }, { label: "Paid to", value: `${VAULT} (the tool's builder)` }],
    steps: ["Your wallet signs the payment (no transaction)"],
    warnings: ["The signature can be used once."],
    quote: {} as never,
    intent: {} as never,
    args: {},
    prepaid: { before: 1_000_000n, after: 995_000n },
  });

  it("shows the decoded payment before the wallet opens, and signs nothing until Confirm", () => {
    const session = new PaidCallSession(paidPlan(), {} as PaidCallDeps);
    const out = html(h(PaidCallDialog, { session, onClose: () => undefined }));
    expect(out).to.contain("Review before your wallet opens");
    expect(out).to.contain("Price").and.to.contain("0.005000 QUSDC");
    expect(out).to.contain("Nothing is signed until you press Confirm");
    expect(out).to.contain("Confirm and sign in wallet");
    expect(out).to.not.contain("pay-pending");
    expect(session.state).to.equal("planned");
  });

  it("renders an empty dialog when there is nothing to review", () => {
    expect(html(h(PaidCallDialog, { session: null, onClose: () => undefined }))).to.not.contain("pay-fields");
    expect(html(withApp(h(FlowDialog, { session: null, onClose: () => undefined }), full))).to.not.contain("flow-fields");
  });
});

describe("Live pages: the status page", () => {
  const base = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({
    checkedAt: 1_800_000_000_000,
    chainId: 1990,
    network: "QIE mainnet",
    realFunds: true,
    overall: "operational",
    problems: [],
    facilitator: { configured: true, reachable: true, ok: true, chainId: 1990, chainMatches: true, routerMatches: true, killSwitch: false, lowBalance: false, draining: false, storeHealthy: true, queued: 2, inFlight: 0, oldestInFlightAgeSeconds: 0, relayerBalanceWei: "500000000000000000", alerts: [], lastSettled: { blockNumber: 12_345, at: 1_799_999_910, ageSeconds: 90 } },
    tools: { configured: true, reachable: true, chainMatches: true, routerMatches: true, tools: [{ name: "contract_lookup", price: "0.005" }] },
    rpc: { endpoints: [{ host: "rpc1mainnet.qie.digital", ok: true, ms: 120 }, { host: "rpc2mainnet.qie.digital", ok: false, ms: 4000, reason: "timeout" }], healthy: 1 },
    ...over,
  });

  it("says working, and shows the readings: the queue, the last settled batch, the relayer's QIE, each endpoint", () => {
    const text = textOf(h(StatusView, { status: base() }));
    expect(text).to.contain("Working");
    expect(text).to.contain("Everything this page can read");
    expect(text).to.contain("QIE mainnet, chain 1990, real funds");
    expect(text).to.contain("2 minutes ago, block 12,345");
    expect(text).to.contain("0.5000 QIE");
    expect(text).to.contain("contract_lookup (0.005 QUSDC)");
    expect(text).to.contain("rpc1mainnet.qie.digital").and.to.contain("Answers").and.to.contain("Too slow");
    expect(text).to.contain("1 of 2 answering");
  });

  it("shows the kill switch, a low relayer and a stuck batch as what they are", () => {
    const f = base().facilitator as Extract<ServiceStatus["facilitator"], { reachable: true }>;
    const status = base({ overall: "degraded", problems: ["The kill switch is on: payments and top-ups are paused. Reading still works."], facilitator: { ...f, killSwitch: true, lowBalance: true, inFlight: 1, oldestInFlightAgeSeconds: 700 } });
    const text = textOf(h(StatusView, { status }));
    expect(text).to.contain("Working with problems");
    expect(text).to.contain("The kill switch is on");
    expect(text).to.contain("On: payments and top-ups paused");
    expect(text).to.contain("Low");
    expect(text).to.contain("the oldest 12 minutes ago");
  });

  it("shows a service that does not answer as not answering, never as fine, and a site with nothing set as having nothing to check", () => {
    const down = textOf(h(StatusView, { status: base({ overall: "down", problems: ["The facilitator is not answering. The address could not be reached from this browser."], facilitator: { configured: true, reachable: false, reason: "The address could not be reached from this browser." }, tools: { configured: true, reachable: false, reason: "x" } }) }));
    expect(down).to.contain("Not working");
    expect(down).to.contain("The facilitator is not answering");
    expect(down).to.contain("The tool server is not answering");
    const none = textOf(h(StatusView, { status: base({ overall: "not_configured", problems: ["No facilitator and no tool server are configured on this site, so there is nothing to check."], facilitator: { configured: false }, tools: { configured: false } }) }));
    expect(none).to.contain("Nothing to check");
    expect(none).to.contain("No facilitator is set on this site");
    expect(none).to.contain("No tool server is set on this site");
  });

  it("says how long ago in words", () => {
    expect(ago(1)).to.equal("1 second ago");
    expect(ago(89)).to.equal("89 seconds ago");
    expect(ago(90)).to.equal("2 minutes ago");
    expect(ago(5_399)).to.equal("90 minutes ago");
    expect(ago(5_400)).to.equal("2 hours ago");
    expect(ago(172_800)).to.equal("2 days ago");
  });
});

describe("Live pages: the security page", () => {
  const view = (depth: Parameters<typeof SecurityView>[0]["depth"], cap = 1_000_000) => textOf(h(SecurityView, { sessionCapUnits: cap, networkLabel: "QIE mainnet", depth }));

  it("states the cap this site is set to, the owner's powers, the facilitator's limits and that no outside review has been done", () => {
    const text = view(undefined, 2_000_000);
    expect(text).to.contain("at most 2 QUSDC");
    expect(text).to.contain("Move, freeze or take a payer's balance or a builder's earnings");
    expect(text).to.contain("Never above 200 basis points (2%)");
    expect(text).to.contain("QUSDC one zero-QIE start may deposit").and.to.contain("10 QUSDC").and.to.contain("100 QUSDC");
    expect(text).to.contain("No outside security review of the contracts or the services has been done");
    expect(text).to.contain("QUSDC's admin can burn any holder's balance".replace("QUSDC's admin can burn any holder's balance", "This risk is in QUSDC, not in Sluice"));
  });

  it("shows the liquidity depth as a reading from the chain, says so when it could not be read, and says nothing is read off mainnet", () => {
    const ok = view({ ok: true, qusdcUnits: 1_234_567_000_000n, qusdc: "1,234,567", pair: ROUTER, readAt: 0 });
    expect(ok).to.match(/holds\s+1,234,567 QUSDC\s*, read from the chain just now/);
    expect(ok).to.contain("Sluice does not swap");
    const failed = view({ ok: false, reason: "The pool could not be read just now." });
    expect(failed).to.contain("The pool could not be read just now. No figure is shown rather than a guess.");
    expect(failed).to.not.match(/holds [\d,]+ QUSDC/);
    expect(view(undefined)).to.contain("This site is set to QIE mainnet, so there is no reading to show");
  });
});

describe("Live pages: terms, privacy and the navigation", () => {
  it("keeps the draft banner in the repository's documents and out of the site's pages", () => {
    for (const file of ["docs/TERMS.md", "docs/PRIVACY.md"]) {
      const text = read(file);
      expect(text.startsWith("> **Draft: not legal advice.**"), file).to.equal(true);
      expect(DRAFT_BANNER.test(text), file).to.equal(true);
      expect(text.replace(DRAFT_BANNER, ""), file).to.not.contain("Draft: not legal advice");
    }
    for (const slug of ["terms", "privacy"]) {
      const doc = content.docs.find((d) => d.slug === slug);
      expect(doc, slug).to.not.equal(undefined);
      expect(doc?.markdown, slug).to.not.contain("not legal advice");
      expect(doc?.group).to.equal("Legal");
    }
    for (const slug of ["terms", "privacy"]) {
      expect(html(withApp(h(LegalDoc, { slug, repoUrl: null }), readConfig({}))), slug).to.not.contain("not legal advice");
    }
  });

  it("says what the product does: a balance that stays yours, the QUSDC admin's burn power, no keys, relayer top-ups and what is logged", () => {
    const terms = textOf(withApp(h(LegalDoc, { slug: "terms", repoUrl: null }), readConfig({})));
    for (const phrase of ["prepaid balance", "cannot be changed after they are deployed", "burn the QUSDC held by any account", "Sluice never sees a key or a seed phrase", "sends a small amount of QIE", "No outside security review", "never above 2%"]) {
      expect(terms, phrase).to.contain(phrase.replace("prepaid balance", "balance inside a smart contract").replace("never above 2%", "never above 2%"));
    }
    const privacy = textOf(withApp(h(LegalDoc, { slug: "privacy", repoUrl: null }), readConfig({})));
    for (const phrase of ["no cookies", "no analytics", "never asks for a private key or a seed phrase", "Its logs hold the method, the tool name", "They hold no argument, no signature and no payment", "Everything that reaches the chain is public"]) {
      expect(privacy, phrase).to.contain(phrase);
    }
  });

  it("tells the privacy notice's browser storage from the code: the theme choice and the in-flight list, and nothing else", () => {
    const privacy = read("docs/PRIVACY.md");
    expect(privacy).to.contain("Your light or dark theme choice");
    expect(privacy).to.contain("the payment's id, the tool, the amount, your address and the payment's nonce");
    expect(privacy).to.contain("It holds no key, no signature and no tool answer");
  });

  it("puts Status in the navigation, and Security, Status, Terms and Privacy in the footer, and calls the demo the demo", () => {
    expect(NAV_LINKS.map((l) => l.href)).to.include("/status");
    const foot = html(h(Footer, { repoUrl: null, deployed: true }));
    for (const href of ["/security", "/status", "/terms", "/privacy", "/demo"]) expect(foot, href).to.contain(`href="${href}"`);
    expect(textOf(h(Footer, { repoUrl: null, deployed: true }))).to.not.contain("Simulated demo");
  });
});
