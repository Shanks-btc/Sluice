import Link from "next/link";
import type { Metadata } from "next";
import { ChannelArt, MechanismDiagram } from "../components/art";
import { ProofStrip } from "../components/proof-strip";
import { StatusGrid } from "../components/status-badge";
import { HOW_STEPS, IDEA_SENTENCES, PROBLEMS, QUSDC_FINDING, SAFETY, liveLimits } from "../content/copy";
import { loadConfigFromProcess } from "../lib/config";
import { content, fork } from "../lib/content";
import { ownRowsPhrase } from "../lib/own-rows";
import { renderInline } from "../lib/markdown";

export const metadata: Metadata = { alternates: { canonical: "/" } };

const mdOptions = { source: "README.md" } as const;

export default function Landing() {
  const rows = content.evidence.rows;
  const { mainnet, testnet, own } = content.evidence;
  return (
    <div className="landing">
      <section className="hero">
        <div className="wrap hero-inner">
          <p className="eye">Sluice · payments for MCP tools on QIE</p>
          <h1 className="hero-statement" data-testid="idea">
            <span>{IDEA_SENTENCES[0]}</span> <span className="hero-second">{IDEA_SENTENCES[1]}</span>
          </h1>
          <div className="hero-cta">
            <Link className="btn btn-dark" href="/demo">
              Try the demo
            </Link>
            <Link className="btn btn-soft" href="/builder">
              Wrap a tool
            </Link>
            <Link className="link hero-link" href="/docs/spec">
              Read the spec
            </Link>
          </div>
          <p className="hero-status" data-testid="hero-status">
            Verified mainnet rows in the evidence file: {mainnet}{ownRowsPhrase(mainnet, own.mainnet)}. Testnet: {testnet}{ownRowsPhrase(testnet, own.testnet)}.{" "}
            {mainnet === 0 ? "Nothing is deployed to a QIE network yet. What is built has been tested on a local copy of QIE mainnet." : ""}
          </p>
        </div>
        <ChannelArt />
        <div className="wrap hero-proof">
          <ProofStrip rows={rows} sample={fork} own={content.ownAddresses} />
        </div>
      </section>

      <section className="section" id="how" aria-labelledby="how-title">
        <div className="wrap">
          <p className="eye">How it works</p>
          <h2 id="how-title">Three steps from a priced tool to a settled payment</h2>
          <ol className="how-grid">
            {HOW_STEPS.map((s, i) => (
              <li key={s.title} className="card card-solid how-step">
                <span className="step-dot">{i + 1}</span>
                <h3>{s.title}</h3>
                <p className="muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section section-tint" id="problem" aria-labelledby="problem-title">
        <div className="wrap split">
          <div>
            <p className="eye">The problem</p>
            <h2 id="problem-title">An agent that needs a tool at run time has no good way to pay for it</h2>
            <p className="lede muted">And a builder has no good way to charge. These are the reasons.</p>
          </div>
          <ul className="problem-list">
            {PROBLEMS.map((p) => (
              <li key={p} className="card card-solid card-sm">
                {p}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" id="mechanism" aria-labelledby="mech-heading">
        <div className="wrap">
          <p className="eye">The mechanism</p>
          <h2 id="mech-heading">Agent, paid tool, facilitator, router, builder</h2>
          <div className="card card-solid diagram-card">
            <MechanismDiagram />
          </div>
          <ol className="mech-steps">
            <li>The agent calls a tool and gets its price.</li>
            <li>The agent signs an intent inside its owner&apos;s budget and calls again.</li>
            <li>The paid tool checks the intent with the facilitator, runs, and queues the payment.</li>
            <li>The facilitator settles many intents on the router in one transaction, and the builder&apos;s earnings go up.</li>
          </ol>
        </div>
      </section>

      <section className="section section-tint" id="safety" aria-labelledby="safety-title">
        <div className="wrap">
          <p className="eye">The safety model</p>
          <h2 id="safety-title">What the contracts and the keys can and cannot do</h2>
          <div className="grid-3">
            {SAFETY.map((s) => (
              <article key={s.title} className="card card-solid">
                <h3>{s.title}</h3>
                <p className="muted">{s.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="differs" aria-labelledby="differs-title">
        <div className="wrap">
          <p className="eye">How this differs</p>
          <h2 id="differs-title">Others have parts of this. Here is what was checked.</h2>
          <p className="lede muted" data-testid="differs-intro">
            {renderInlineText(content.differs.intro)}
          </p>
          <p className="banner banner-info">Sluice&apos;s scheme is an independent scheme. It is not an official x402 scheme, and nobody at x402 reviewed it.</p>
          <div className="table-wrap">
            <table className="table differs-table" data-testid="differs-table">
              <thead>
                <tr>
                  <th>Other work</th>
                  <th>What the pre-build check shows</th>
                  <th>How Sluice differs</th>
                  <th>Unknown</th>
                </tr>
              </thead>
              <tbody>
                {content.differs.rows.map((r) => (
                  <tr key={r.other}>
                    <td data-label="Other work" dangerouslySetInnerHTML={{ __html: renderInline(r.other, mdOptions) }} />
                    <td data-label="What the check shows" dangerouslySetInnerHTML={{ __html: renderInline(r.shows, mdOptions) }} />
                    <td data-label="How Sluice differs" dangerouslySetInnerHTML={{ __html: renderInline(r.differs, mdOptions) }} />
                    <td data-label="Unknown" dangerouslySetInnerHTML={{ __html: renderInline(r.unknown, mdOptions) }} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section section-tint" id="risks" aria-labelledby="risks-title">
        <div className="wrap">
          <div className="callout" data-testid="risks-box">
            <p className="eye callout-eye">Honest risks</p>
            <h2 id="risks-title" className="callout-title">
              {QUSDC_FINDING.heading}
            </h2>
            <p>{QUSDC_FINDING.body}</p>
            <dl className="kv callout-kv">
              {QUSDC_FINDING.facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p>{QUSDC_FINDING.tested}</p>
            <p>
              <strong>What helps.</strong> {QUSDC_FINDING.advice}
            </p>
            <ul className="callout-list">
              {QUSDC_FINDING.others.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
            <p>
              <strong>Limits in force on this site.</strong>
            </p>
            <ul className="callout-list" data-testid="risks-limits">
              {liveLimits(loadConfigFromProcess().sessionCapUnits).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p>
              <Link href="/docs/risks">Read all the risks</Link> · <Link href="/security">Security and limits</Link> · <Link href="/demo#risk">Run the risk check on any token</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="status" aria-labelledby="status-title">
        <div className="wrap">
          <p className="eye">Status</p>
          <h2 id="status-title">Where each part stands</h2>
          <StatusGrid rows={rows} />
          <p className="muted status-note">
            A badge says Live only when the evidence file holds a verified mainnet row for it. Verified rows: mainnet {mainnet}{ownRowsPhrase(mainnet, own.mainnet)}; testnet {testnet}{ownRowsPhrase(testnet, own.testnet)}. &quot;Tested on a fork&quot; means a test ran it against a local copy of QIE mainnet.
          </p>
        </div>
      </section>

      <section className="section closing" aria-label="Where to go next">
        <div className="wrap grid-2">
          <Link className="card card-solid closing-card" href="/builder">
            <p className="eye">For MCP builders</p>
            <h3>Put a price on a tool and watch the earnings</h3>
            <p className="muted">The builder dashboard reads the router, and the guide shows the SDK call to wrap a tool.</p>
          </Link>
          <Link className="card card-solid closing-card" href="/wallet">
            <p className="eye">For agents and their owners</p>
            <h3>Fund an agent and set its limits</h3>
            <p className="muted">Deposit QUSDC, authorise an agent key with a budget and an expiry, and revoke it at any time.</p>
          </Link>
        </div>
      </section>
    </div>
  );
}

/** A plain-text version of an inline Markdown run, for a paragraph the page controls: links become their labels. */
function renderInlineText(markdown: string): string {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "");
}
