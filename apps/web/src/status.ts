// The status badges on the site, from one typed list. Each entry says what state a component is in, and that state is held to two
// other records by tests: the README's status table (the same words for the same surfaces) and docs/EVIDENCE.md (a component is
// Live only when the mainnet events that show it working each have a verified row). `effectiveStatus` applies the second rule at
// run time too, so a badge cannot say Live without evidence even if this list were edited to say so.
import type { EvidenceRow } from "../../../src/evidence";

export const STATUSES = ["Live", "Tested on a fork", "Coming soon"] as const;
export type Status = (typeof STATUSES)[number];

export type ComponentId = "contracts" | "facilitator" | "proxy" | "wallet-mcp";

export type ComponentStatus = {
  id: ComponentId;
  name: string;
  /** One plain sentence about what it is. */
  summary: string;
  status: Status;
  /** The README status-table rows this entry stands for. Their status words must equal this one. */
  readmeSurfaces: readonly string[];
  /** The events in docs/EVIDENCE.md that must each have a verified mainnet row before this can be Live. */
  evidenceEvents: readonly string[];
  /** The test that backs "Tested on a fork". */
  testFile: string;
};

export const COMPONENTS: readonly ComponentStatus[] = [
  {
    id: "contracts",
    name: "Contracts",
    summary: "The router and the vault: balances, signed settlement, session keys.",
    status: "Tested on a fork",
    readmeSurfaces: [
      "PaymentRouter: deposit, settle, batch settle, withdraw, refund, fee",
      "Withdraw and refund by signature, with no QIE",
      "AgentVault: session keys and revoke",
    ],
    evidenceEvents: ["Deposited", "Settled", "Withdrawn", "SessionAuthorized"],
    testFile: "test/fork/qusdc.fork.test.ts",
  },
  {
    id: "facilitator",
    name: "Facilitator",
    summary: "Verifies payments, queues them and settles in batches, within hard caps.",
    status: "Tested on a fork",
    readmeSurfaces: ["Facilitator: verify, settle and status"],
    evidenceEvents: ["Settled"],
    testFile: "test/fork/mcp.fork.test.ts",
  },
  {
    id: "proxy",
    name: "Proxy",
    summary: "Pays a paid server for an agent, inside the owner's budget.",
    status: "Tested on a fork",
    readmeSurfaces: ["Payment proxy: paying a paid server inside the owner's budget"],
    evidenceEvents: ["Settled", "SessionAuthorized"],
    testFile: "test/fork/mcp.fork.test.ts",
  },
  {
    id: "wallet-mcp",
    name: "Wallet MCP",
    summary: "Lets an agent read its balance, budget and history. It cannot sign.",
    status: "Tested on a fork",
    readmeSurfaces: ["Wallet MCP for agents"],
    evidenceEvents: ["SessionAuthorized"],
    testFile: "test/fork/mcp.fork.test.ts",
  },
];

export type EvidenceKey = Pick<EvidenceRow, "network" | "event">;

/** The events a component is missing a verified mainnet row for. */
export function missingEvidence(component: ComponentStatus, rows: readonly EvidenceKey[]): string[] {
  const mainnet = new Set(rows.filter((r) => r.network === "mainnet").map((r) => r.event));
  return component.evidenceEvents.filter((e) => !mainnet.has(e));
}

/** The status a badge may show. Live is shown only with a verified mainnet row for every event the component rests on. */
export function effectiveStatus(component: ComponentStatus, rows: readonly EvidenceKey[]): { status: Status; reason?: string } {
  if (component.status !== "Live") return { status: component.status };
  const missing = missingEvidence(component, rows);
  if (component.evidenceEvents.length === 0 || missing.length > 0) {
    return { status: "Coming soon", reason: `No verified mainnet row in docs/EVIDENCE.md for ${missing.join(", ") || "any event"}.` };
  }
  return { status: "Live" };
}

export const badgeClass = (status: Status): string =>
  status === "Live" ? "tag tag-success" : status === "Tested on a fork" ? "tag tag-info" : "tag";
