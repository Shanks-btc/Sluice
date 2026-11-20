// The go-live documents are held to the code and to the repository's honesty rules: every command is real, every setting named is declared,
// every number matches the code it describes, every link goes somewhere, and none of them says anything is live, reviewed, or done by the
// founder. The same claim scanner that runs over the README runs over them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { DEFAULT_CAPS, HARD_CAPS } from "@sluice/facilitator";
import { scanClaims } from "../../src/claims";
import { parseEvidenceStrict } from "../../src/evidence";
import { MEASURED_GAS, SMOKE_GAS_TOTAL } from "../../src/gas-figures";
import { withCommas } from "../../src/gas";

const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const mainnetRows = parseEvidenceStrict(read("docs/EVIDENCE.md")).filter((r) => r.network === "mainnet").length;
const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

const DOCS = [
  "docs/DEPLOY-FACILITATOR.md",
  "docs/DEPLOY-TOOL-SERVER.md",
  "docs/MAINNET-RUNBOOK.md",
  "docs/REHEARSAL.md",
  "docs/REAL-CLIENT-TEST.md",
  "docs/TRY-IT-BUILDER.md",
  "docs/TRY-IT-AGENT.md",
  "docs/OUTREACH.md",
];
const IDEA =
  "Payment middleware that lets MCP builders get paid, with an MCP-compatible wallet so AI agents can pay for the tools and services they use. Agents pay per request on QIE using HTTP 402-style payments, in QUSDC, with no manual subscriptions or API keys.";

const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const builtins = new Set(["install", "exec", "add", "remove", "dlx", "run"]);
const example = read(".env.example");
const declared = new Set(example.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => l.slice(0, l.indexOf("="))));

/** The text of every fenced block that is a shell block (powershell, bash, or none), and the prose outside any fence. */
function parts(markdown: string): { code: string[]; prose: string } {
  const code: string[] = [];
  const prose: string[] = [];
  let fence: { lang: string; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    const open = /^\s*```(\w*)\s*$/.exec(line);
    if (open) {
      if (fence) {
        if (["powershell", "bash", "sh", ""].includes(fence.lang)) code.push(fence.lines.join("\n"));
        fence = undefined;
      } else {
        fence = { lang: open[1] ?? "", lines: [] };
      }
      continue;
    }
    if (fence) fence.lines.push(line);
    else prose.push(line);
  }
  return { code, prose: prose.join("\n") };
}

describe("Go-live documents: they exist and are held to the claims rules", () => {
  for (const file of DOCS) {
    it(`${file} exists, has no banned claim, and says nothing is live without a mainnet row`, () => {
      expect(existsSync(join(root, file)), file).to.equal(true);
      expect(read(file).trim().length).to.be.greaterThan(1500);
      expect(scanClaims(file, read(file), mainnetRows)).to.deep.equal([]);
    });
  }

  it("the deploy files, the issue form and the ignore file exist", () => {
    for (const file of ["packages/facilitator/Dockerfile", "examples/paid-tools/Dockerfile", ".dockerignore", ".github/ISSUE_TEMPLATE/i-tried-sluice.yml"]) {
      expect(existsSync(join(root, file)), file).to.equal(true);
    }
  });

  it("none of them says the founder did, decided, tested, reviewed or ran something", () => {
    const CLAIMS = /(?:^|[.!?]\s+)The founder (set|made|decided|directed|explained|understood|reviewed|tested|wrote|designed|chose|approved|verified|ran|understands|has explained|has reviewed|has tested|did|deployed|signed|funded|tried)\b/m;
    for (const file of DOCS) expect(CLAIMS.exec(read(file))?.[0] ?? null, file).to.equal(null);
  });

  it("none of them calls the contracts reviewed, checked or safe by an outside party", () => {
    for (const file of DOCS) {
      const text = read(file);
      expect(text, file).to.not.match(/\b(audited|security review(ed)? by|pen-?test(ed)?)\b/i);
    }
  });

  it("every document says plainly what has not been run", () => {
    for (const file of ["docs/DEPLOY-FACILITATOR.md", "docs/DEPLOY-TOOL-SERVER.md", "docs/MAINNET-RUNBOOK.md", "docs/REHEARSAL.md", "docs/REAL-CLIENT-TEST.md"]) {
      expect(read(file), file).to.match(/(Nothing (in it |here )?has been run|has not been run|were not run|Nothing here has been run)/i);
    }
  });
});

describe("Go-live documents: the commands in them are real", () => {
  it("every pnpm command is a script in package.json or a pnpm built-in", () => {
    for (const file of DOCS) {
      const { code } = parts(read(file));
      for (const m of code.join("\n").matchAll(/(?:^|;\s*)pnpm\s+([\w:-]+)/gm)) {
        const name = m[1] as string;
        expect(pkg.scripts[name] !== undefined || builtins.has(name), `${file}: pnpm ${name}`).to.equal(true);
      }
    }
  });

  it("every script path in a command exists", () => {
    for (const file of DOCS) {
      const { code } = parts(read(file));
      for (const m of code.join("\n").matchAll(/ts-node(?:\s+-r\s+\S+)?\s+([\w./\\-]+\.ts)/g)) {
        const path = (m[1] as string).replace(/\\/g, "/");
        if (path.startsWith("examples/my-tool/")) continue; // the file the page tells the reader to write
        expect(existsSync(join(root, path)), `${file}: ${m[1]}`).to.equal(true);
      }
      for (const m of code.join("\n").matchAll(/node\s+([\w./\\-]+\/cli\.js)/g)) {
        const path = (m[1] as string).replace(/\\/g, "/");
        // A built program: its source exists, and `pnpm build` makes the .js
        expect(existsSync(join(root, path.replace(/dist\/cli\.js$/, "src/cli.ts"))), `${file}: ${path}`).to.equal(true);
      }
    }
  });

  it("the runbook's commands never use || (a PowerShell 5 parse error), and a command that sets a variable and runs another uses a semicolon", () => {
    for (const file of ["docs/MAINNET-RUNBOOK.md", "docs/REHEARSAL.md", "docs/TRY-IT-BUILDER.md", "docs/TRY-IT-AGENT.md", "docs/REAL-CLIENT-TEST.md"]) {
      const { code } = parts(read(file));
      for (const block of code) {
        expect(block, file).to.not.contain("||");
        expect(block, file).to.not.contain("&&");
      }
    }
    expect(read("docs/MAINNET-RUNBOOK.md")).to.not.contain("||");
  });

  it("every environment variable a document names is declared in .env.example, or is a value the scripts check by name", () => {
    const allowedValues = new Set(["SLUICE_APPROVE"]);
    for (const file of DOCS) {
      for (const m of read(file).matchAll(/\b(SLUICE_[A-Z0-9_]+|EVIDENCE_RPC_URL)\b/g)) {
        const name = m[1] as string;
        expect(declared.has(name) || allowedValues.has(name), `${file}: ${name} is not in .env.example`).to.equal(true);
      }
    }
  });

  it("the PowerShell blocks use $env: for variables, and never put a key on a command line", () => {
    for (const file of DOCS) {
      for (const block of parts(read(file)).code) {
        expect(block, file).to.not.match(/SLUICE_(RELAYER_|AGENT_)?KEY\s*=\s*['"]?0x[0-9a-fA-F]{8,}/);
        expect(block, file).to.not.match(/0x[0-9a-fA-F]{64}/);
      }
    }
  });

  it("each live step names its approval variable by the script's own name", () => {
    const run = read("docs/MAINNET-RUNBOOK.md");
    for (const [name, script] of [["deploy", "scripts/live/deploy.ts"], ["smoke", "scripts/live/smoke.ts"], ["verify", "live:verify"]] as const) {
      expect(run, name).to.contain(`$env:SLUICE_APPROVE = "${name}"`);
      expect(run, script).to.contain(script);
    }
    expect(read("docs/REHEARSAL.md")).to.contain('$env:SLUICE_APPROVE = "deploy-test-token"');
    expect(read("docs/TRY-IT-AGENT.md")).to.contain('$env:SLUICE_APPROVE = "owner-setup"');
  });
});

describe("Go-live documents: their links go somewhere", () => {
  for (const file of DOCS) {
    it(`${file}: every relative link points at a file or heading that exists`, () => {
      const text = read(file);
      const dir = join(root, file, "..");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] as string;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split("#") as [string, string | undefined];
        const resolved = path === "" ? join(root, file) : join(dir, path);
        expect(existsSync(resolved), `${file}: ${target}`).to.equal(true);
        if (anchor && resolved.endsWith(".md")) {
          const headings = readFileSync(resolved, "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
          expect(headings, `${file}: ${target}`).to.include(anchor);
        }
      }
    });
  }

  it("every document that the new documents point at in .github or docs exists, and each new document is pointed at from the README", () => {
    const readme = read("README.md");
    for (const file of DOCS) expect(readme, file).to.contain(file);
  });
});

describe("Go-live documents: their numbers are the code's numbers", () => {
  it("the facilitator's caps table gives every default and ceiling the code has", () => {
    const text = read("docs/DEPLOY-FACILITATOR.md");
    const QIE = 10n ** 18n;
    const qie = (wei: bigint) => {
      const whole = wei / QIE;
      const frac = (wei % QIE).toString().padStart(18, "0").replace(/0+$/, "");
      return frac ? `${whole}.${frac}` : `${whole}`;
    };
    const rowFor = (label: string): string => {
      const row = text.split("\n").find((l) => l.startsWith(`| ${label} |`));
      if (!row) throw new Error(`no caps row for ${label}`);
      return row;
    };
    const num = (n: number | bigint) => withCommas(BigInt(n));
    const usdc = (units: bigint) => (units / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const checks: Array<[string, string, string]> = [
      ["Gas limit of one transaction", num(DEFAULT_CAPS.gasLimitPerTx), num(HARD_CAPS.gasLimitPerTx)],
      ["Highest gas price", `${DEFAULT_CAPS.maxGasPriceWei / 1_000_000_000n} gwei`, `${HARD_CAPS.maxGasPriceWei / 1_000_000_000n} gwei`],
      ["QIE the relayer may spend in a UTC day", qie(DEFAULT_CAPS.dailyBudgetWei), qie(HARD_CAPS.dailyBudgetWei)],
      ["Payments in one batch", num(DEFAULT_CAPS.maxBatchSize), num(HARD_CAPS.maxBatchSize)],
      ["One top-up", `${qie(DEFAULT_CAPS.maxTopUpWei)} QIE`, `${qie(HARD_CAPS.maxTopUpWei)} QIE`],
      ["All top-ups to one address in a UTC day", `${qie(DEFAULT_CAPS.topUpPerAddressDailyWei)} QIE`, `${qie(HARD_CAPS.topUpPerAddressDailyWei)} QIE`],
      ["QUSDC one zero-QIE start may deposit", usdc(DEFAULT_CAPS.maxOnboardAmount), usdc(HARD_CAPS.maxOnboardAmount)],
      ["Payments one payer may queue in a UTC day", num(DEFAULT_CAPS.payerDailyIntents), num(HARD_CAPS.payerDailyIntents)],
      ["QUSDC one payer may queue in a UTC day", usdc(DEFAULT_CAPS.payerDailyAmount), usdc(HARD_CAPS.payerDailyAmount)],
      ["Payments all payers may queue in a UTC day", num(DEFAULT_CAPS.globalDailyIntents), num(HARD_CAPS.globalDailyIntents)],
      ["QUSDC all payers may queue in a UTC day", usdc(DEFAULT_CAPS.globalDailyAmount), usdc(HARD_CAPS.globalDailyAmount)],
      ["Zero-QIE starts per payer per UTC day", num(DEFAULT_CAPS.onboardPerPayerPerDay), num(HARD_CAPS.onboardPerPayerPerDay)],
      ["Relayed withdrawals and refunds per account per UTC day", num(DEFAULT_CAPS.relayPerAccountPerDay), num(HARD_CAPS.relayPerAccountPerDay)],
    ];
    for (const [label, def, ceiling] of checks) {
      const cells = rowFor(label).split("|").map((c) => c.trim());
      expect(cells[2], `${label}: default`).to.equal(def);
      expect(cells[3], `${label}: ceiling`).to.equal(ceiling);
    }
    // And every cap the code has is in the table.
    expect(Object.keys(HARD_CAPS)).to.have.length(checks.length);
  });

  it("the facilitator's settings table lists every variable its program reads, and the tool server's lists every one of its own", () => {
    const facilitator = read("packages/facilitator/src/env.ts");
    const read1 = new Set([...facilitator.matchAll(/\b(SLUICE_FACILITATOR_[A-Z0-9_]+)\b/g)].map((m) => m[1] as string));
    const doc1 = read("docs/DEPLOY-FACILITATOR.md");
    for (const name of read1) expect(doc1, name).to.contain(`\`${name}\``);
    const tools = read("examples/paid-tools/src/host.ts");
    const read2 = new Set([...tools.matchAll(/\b(SLUICE_TOOLS_[A-Z0-9_]+)\b/g)].map((m) => m[1] as string));
    const doc2 = read("docs/DEPLOY-TOOL-SERVER.md");
    for (const name of read2) expect(doc2, name).to.contain(`\`${name}\``);
    expect(read1.size).to.be.greaterThan(15);
    expect(read2.size).to.be.greaterThan(8);
  });

  it("the defaults the docs state for the tool server and the facilitator are the ones the programs use", () => {
    const text = read("docs/DEPLOY-TOOL-SERVER.md");
    for (const [name, value] of [["SLUICE_TOOLS_PORT", "8403"], ["SLUICE_TOOLS_MAX_BODY_BYTES", "32768"], ["SLUICE_TOOLS_RATE_LIMIT_IP", "300"], ["SLUICE_TOOLS_RATE_LIMIT_UNPAID", "60"], ["SLUICE_TOOLS_RPC_TIMEOUT_MS", "10000"]] as const) {
      const row = text.split("\n").find((l) => l.startsWith(`| \`${name}\``));
      expect(row, name).to.contain(`\`${value}\``);
    }
    const fac = read("docs/DEPLOY-FACILITATOR.md");
    for (const [name, value] of [["SLUICE_FACILITATOR_MAX_BODY_BYTES", "65536"], ["SLUICE_FACILITATOR_RATE_LIMIT_IP", "240"], ["SLUICE_FACILITATOR_RATE_LIMIT_PAYER", "60"], ["SLUICE_FACILITATOR_FLUSH_MS", "15000"], ["SLUICE_FACILITATOR_SHUTDOWN_MS", "30000"], ["SLUICE_FACILITATOR_RPC_TIMEOUT_MS", "20000"]] as const) {
      const row = fac.split("\n").find((l) => l.startsWith(`| \`${name}\``));
      expect(row, name).to.contain(`\`${value}\``);
    }
  });

  it("the runbook's funding plan is the measured gas times the measured gas price, to the digit", () => {
    const text = read("docs/MAINNET-RUNBOOK.md");
    const price = 1_125_000_000n; // docs/GAS.md's basis
    const row = (label: string, gas: bigint) => {
      const line = text.split("\n").find((l) => l.startsWith(`| ${label} |`));
      expect(line, label).to.be.a("string");
      const cells = (line as string).split("|").map((c) => c.trim());
      expect(cells[2], `${label}: gas`).to.equal(withCommas(gas));
      // QIE to six places, rounded half up
      const micro = (gas * price + 500_000_000_000n) / 1_000_000_000_000n;
      expect(cells[3], `${label}: QIE`).to.equal(`${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`);
    };
    row("Deploy the router, which creates the vault", MEASURED_GAS.deployRouter);
    row("The smoke run: eight transactions", SMOKE_GAS_TOTAL);
    row("Deploy and smoke run together", MEASURED_GAS.deployRouter + SMOKE_GAS_TOTAL);
    row("The largest batch measured, 50 intents from 50 payers to 50 builders", MEASURED_GAS.batch50Worst);
    expect(read("docs/GAS.md")).to.contain("1.125 gwei");
  });

  it("the Dockerfiles pin the base image by version and digest, run as the unprivileged user, and hold no secret", () => {
    for (const file of ["packages/facilitator/Dockerfile", "examples/paid-tools/Dockerfile"]) {
      const text = read(file);
      expect(text, file).to.match(/ARG NODE_IMAGE=node:\d+\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}/);
      expect(text, file).to.match(/^USER node$/m);
      expect(text, file).to.match(/pnpm install --frozen-lockfile/);
      expect(text, file).to.match(/HEALTHCHECK/);
      expect(text, file).to.not.match(/ENV\s+\w*KEY\b/);
      expect(text, file).to.not.match(/0x[0-9a-fA-F]{64}/);
      expect(text, file).to.not.match(/latest/);
    }
    const ignore = read(".dockerignore");
    for (const pattern of [".env", "**/node_modules", "**/*.jsonl", "**/evidence-draft.json", "**/deployment.json"]) expect(ignore, pattern).to.contain(pattern);
    expect(ignore).to.contain("!.env.example");
  });
});

describe("Go-live documents: the outreach drafts and the issue form", () => {
  const outreach = read("docs/OUTREACH.md");

  it("has three drafts, and each says it is an independent scheme, that the payer prepays, and what the admin of QUSDC can do", () => {
    const drafts = outreach.split(/^## \d\. /m).slice(1);
    expect(drafts).to.have.length(3);
    expect(outreach).to.match(/## 1\. To an MCP builder/);
    expect(outreach).to.match(/## 2\. To someone who might pay/);
    expect(outreach).to.match(/## 3\. To a developer community/);
    expect(outreach).to.match(/not an official x402/i);
    expect(outreach).to.match(/prepay/i);
    expect(outreach).to.match(/burn/i);
    expect(outreach).to.match(/No outside party has reviewed|No one outside the project has reviewed/i);
  });

  it("keeps the idea's wording unchanged wherever it states it, and says nothing has been sent", () => {
    expect(outreach.split(IDEA).length - 1).to.be.at.least(2);
    expect(outreach).to.contain("nothing has been sent");
    expect(read("docs/TRY-IT-BUILDER.md")).to.not.contain("Payment middleware"); // the pages do not restate the idea: the README does
  });

  it("makes no claim that anyone uses it", () => {
    expect(outreach).to.not.match(/(\d+ users|our users|early users|people already use)/i);
  });

  it("has an issue form that asks for the role, the network, a transaction, what broke and consent, and says how a user is counted", () => {
    const form = read(".github/ISSUE_TEMPLATE/i-tried-sluice.yml");
    expect(form).to.match(/^name: I tried Sluice$/m);
    expect(form).to.match(/^body:$/m);
    for (const id of ["role", "network", "tx", "address", "broke", "worked", "consent"]) expect(form, id).to.match(new RegExp(`id: ${id}$`, "m"));
    expect(form).to.contain("docs/founder-wallets.json");
    expect(form).to.match(/appears in a settlement on the chain/);
    expect(form).to.match(/pnpm evidence:summary/);
    // The two consent boxes are required; the transaction and address are not.
    const consent = form.slice(form.indexOf("id: consent"));
    expect((consent.match(/required: true/g) ?? []).length).to.equal(2);
    const tx = form.slice(form.indexOf("id: tx"), form.indexOf("id: address"));
    expect(tx).to.not.contain("required: true");
    expect(form).to.not.match(/private key:|seed phrase:|password:/i);
  });

  it("is listed in the layout and the docs list in the README", () => {
    expect(readdirSync(join(root, ".github", "ISSUE_TEMPLATE"))).to.deep.equal(["i-tried-sluice.yml"]);
  });
});
