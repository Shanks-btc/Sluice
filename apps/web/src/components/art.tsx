// Original drawings: the stepped channel with its gates (the hero band), and the mechanism diagram (agent, paid tool, facilitator,
// router, builder). Both are inline SVG. Colours come from classes that read the design tokens, and the motion is CSS that is
// switched off for people who ask for reduced motion.

/** Water stepping down through three basins, with a gate between each. Decorative. */
export function ChannelArt() {
  return (
    <svg className="channel-art" viewBox="0 0 1200 170" preserveAspectRatio="xMidYMax slice" role="presentation" aria-hidden="true" focusable="false">
      <path className="water-a" d="M0 44H400V170H0z" />
      <path className="water-b" d="M400 84H800V170H400z" />
      <path className="water-c" d="M800 124H1200V170H800z" />
      <path className="ripple" d="M24 66q30-9 60 0t60 0t60 0t60 0t60 0t60 0" />
      <path className="ripple ripple-b" d="M430 106q30-9 60 0t60 0t60 0t60 0t60 0t60 0" />
      <path className="ripple ripple-c" d="M830 146q30-9 60 0t60 0t60 0t60 0t60 0t60 0" />
      <g className="gate-shape">
        <rect x="396" y="26" width="8" height="144" rx="2" />
        <rect x="388" y="18" width="24" height="10" rx="3" />
      </g>
      <g className="gate-shape">
        <rect x="796" y="66" width="8" height="104" rx="2" />
        <rect x="788" y="58" width="24" height="10" rx="3" />
      </g>
      <circle className="packet" cx="40" cy="36" r="7" />
    </svg>
  );
}

const STATIONS = [
  { x: 10, label: "Agent", sub: "holds a session key" },
  { x: 230, label: "Paid tool", sub: "MCP server + SDK" },
  { x: 450, label: "Facilitator", sub: "verifies, queues" },
  { x: 670, label: "Router", sub: "ledger on QIE" },
  { x: 890, label: "Builder", sub: "withdraws earnings" },
] as const;

const BOX = 150;

const FLOW = [
  { x: 195, text: "pay" },
  { x: 415, text: "verify" },
  { x: 635, text: "settle" },
  { x: 855, text: "credit" },
] as const;

/** The path of one paid call. The same steps are listed as text beside it, so the drawing is never the only description. */
export function MechanismDiagram() {
  return (
    <svg className="mechanism" viewBox="0 0 1050 170" role="img" aria-labelledby="mech-title mech-desc">
      <title id="mech-title">How a paid call moves</title>
      <desc id="mech-desc">An agent calls a paid tool and pays. The tool asks a facilitator to verify the payment. The facilitator settles it on the router in a batch. The router credits the builder.</desc>
      <path className="mech-line" d="M160 70H230M380 70H450M600 70H670M820 70H890" />
      {FLOW.map((f) => (
        <text key={f.text} className="mech-flow" x={f.x} y="54" textAnchor="middle">
          {f.text}
        </text>
      ))}
      {STATIONS.map((s, i) => (
        <g key={s.label}>
          <rect className={i === 3 ? "mech-box mech-box-chain" : "mech-box"} x={s.x} y="30" width={BOX} height="80" rx="18" />
          <text className="mech-label" x={s.x + BOX / 2} y="66" textAnchor="middle">
            {s.label}
          </text>
          <text className="mech-sub" x={s.x + BOX / 2} y="90" textAnchor="middle">
            {s.sub}
          </text>
        </g>
      ))}
      <path className="mech-chain" d="M670 132h150" />
      <text className="mech-note" x="745" y="154" textAnchor="middle">
        on chain, in QUSDC
      </text>
    </svg>
  );
}
