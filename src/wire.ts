// pnpm live:wire: turns deployment.json (what scripts/live/deploy.ts wrote) into the settings files for the facilitator, the tool server and the
// web app, so no address is copied by hand. It writes three git-ignored files, .env.<network>.facilitator, .env.<network>.tool-server and
// .env.<network>.web, and prints which of their values are public, which are secrets you set yourself, and which you still have to fill in.
//
// It never writes a key. A value a person has to choose (a public address of a service, the payee, a metrics token) is written empty, with a
// comment above it, and the program that reads the file refuses to start while it is empty, so a file nobody finished fails closed. The
// approval (SLUICE_APPROVE) and the relayer's key are not written at all: the approval is a deliberate act, and the key belongs in the host's
// secret store.
import { getAddress } from "ethers";
import { NETWORKS } from "./evidence";
import type { Network } from "./evidence";
import { QUSDC_ADDRESS } from "./guard";

export class WireError extends Error {}

export type DeploymentRecord = {
  network: Network;
  chainId: number;
  router: string;
  vault: string;
  block: number;
  token: string;
};

const HEX64 = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

/** What deploy.ts wrote, checked: the network it names must be the one asked for, on that network's chain, with real addresses. */
export function parseDeployment(text: string, network: Network): DeploymentRecord {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new WireError("the deployment file is not JSON, so it was not written by scripts/live/deploy.ts");
  }
  if (raw.network !== network) throw new WireError(`the deployment file is for ${JSON.stringify(raw.network)}, not ${network}`);
  if (raw.chainId !== NETWORKS[network].chainId) throw new WireError(`the deployment file names chain ${String(raw.chainId)}, but ${network} is chain ${NETWORKS[network].chainId}`);
  const addr = (name: string): string => {
    try {
      return getAddress(String(raw[name]));
    } catch {
      throw new WireError(`the deployment file's ${name} is not an address`);
    }
  };
  const router = addr("router");
  const vault = addr("vault");
  const token = addr("token");
  if (network === "mainnet" && token !== getAddress(QUSDC_ADDRESS)) throw new WireError("the deployment file's token is not QUSDC, which is the only token a mainnet router may hold");
  const block = raw.block;
  if (typeof block !== "number" || !Number.isSafeInteger(block) || block < 0) throw new WireError("the deployment file's block is not a block number");
  return { network, chainId: NETWORKS[network].chainId, router, vault, block, token };
}

export type Entry = {
  name: string;
  value: string;
  /** public: safe to show and to commit nowhere in particular; secret: a value you choose and keep out of the repository; you: still to be filled in. */
  kind: "public" | "secret" | "you";
  note: string;
};

export type WiredFile = { file: string; title: string; entries: Entry[] };

const filename = (network: Network, which: string): string => `.env.${network}.${which}`;

/** The three files' contents, as data. */
export function wire(d: DeploymentRecord): WiredFile[] {
  const n = d.network;
  const sluiceNetwork: Entry = { name: "SLUICE_NETWORK", value: n, kind: "public", note: "the network every program checks the node's chain id against" };
  const router: Entry = { name: "SLUICE_ROUTER", value: d.router, kind: "public", note: "the deployed router" };
  const token: Entry = { name: "SLUICE_TOKEN", value: d.token, kind: "public", note: n === "mainnet" ? "QUSDC; the programs read the token from the router and refuse any other on mainnet" : "the token the router holds" };
  const facilitatorUrl: Entry = { name: "SLUICE_FACILITATOR_URL", value: "", kind: "you", note: "the facilitator's public https address, once it is hosted" };
  return [
    {
      file: filename(n, "facilitator"),
      title: `The facilitator on ${n}. Load it in the host's settings, next to SLUICE_APPROVE=facilitator and SLUICE_RELAYER_KEY, which are not written here.`,
      entries: [
        sluiceNetwork,
        router,
        token,
        { name: "SLUICE_MAX_QIE", value: "0.5", kind: "public", note: "the most QIE the relayer may spend in a day; the pre-flight check and /health compare its balance with this" },
        { name: "SLUICE_FACILITATOR_STATE", value: "", kind: "you", note: "a file on a disk that survives restarts, for the queue (for example /data/queue.jsonl)" },
        { ...facilitatorUrl },
        { name: "SLUICE_FACILITATOR_CORS_ORIGINS", value: "", kind: "you", note: "the web site's origin, with no path (for example https://sluice.example)" },
        { name: "SLUICE_FACILITATOR_METRICS_TOKEN", value: "", kind: "secret", note: "24 to 200 characters you make up, for the private metrics path; leave empty to have no such path" },
      ],
    },
    {
      file: filename(n, "tool-server"),
      title: `The hosted tool server on ${n}.`,
      entries: [
        sluiceNetwork,
        router,
        token,
        { name: "SLUICE_PAYEE", value: "", kind: "you", note: "the address that is paid for every call (the builder's)" },
        { ...facilitatorUrl },
        { name: "SLUICE_TOOLS_CORS_ORIGINS", value: "", kind: "you", note: "the web site's origin, with no path, so its pages can read the tool server's answers" },
        { name: "SLUICE_TOOLS_METRICS_TOKEN", value: "", kind: "secret", note: "24 to 200 characters you make up, for the private metrics path; leave empty to have no such path" },
      ],
    },
    {
      file: filename(n, "web"),
      title: `The web app on ${n}. Every NEXT_PUBLIC_ value reaches the browser, so none is a secret.`,
      entries: [
        { name: "NEXT_PUBLIC_CHAIN_ID", value: String(d.chainId), kind: "public", note: `${n}'s chain id` },
        { name: "NEXT_PUBLIC_ROUTER_ADDRESS", value: d.router, kind: "public", note: "the deployed router" },
        { name: "NEXT_PUBLIC_VAULT_ADDRESS", value: d.vault, kind: "public", note: "the router's vault" },
        { name: "NEXT_PUBLIC_FROM_BLOCK", value: String(d.block), kind: "public", note: "the block the router was deployed at, where scans for events stop" },
        { name: "SLUICE_FROM_BLOCK", value: String(d.block), kind: "public", note: "the same, for the pages that read on the server" },
        { name: "NEXT_PUBLIC_SESSION_CAP_QUSDC", value: "1", kind: "public", note: "the most QUSDC one session may deposit on the live pages (never above 10)" },
        { name: "NEXT_PUBLIC_FACILITATOR_URL", value: "", kind: "you", note: "the facilitator's public https address" },
        { name: "NEXT_PUBLIC_TOOLS_URL", value: "", kind: "you", note: "the hosted tool server's public https address" },
        { name: "NEXT_PUBLIC_SITE_URL", value: "", kind: "you", note: "where the site is served, for link previews" },
      ],
    },
  ];
}

/** One file's text. A value that looks like a key (a 32-byte hex string) is refused: nothing in these files may be one. */
export function renderEnvFile(f: WiredFile): string {
  const lines = [`# ${f.title}`, "# Written by pnpm live:wire from deployment.json. It holds no key. A line with no value is for you to fill in; the program refuses to start until you do.", ""];
  for (const e of f.entries) {
    if (HEX64.test(e.value)) throw new WireError(`refusing to write ${e.name}: its value looks like a key or a hash, and these files hold neither`);
    lines.push(`# ${e.kind === "you" ? "FILL IN: " : e.kind === "secret" ? "SECRET, yours to make: " : ""}${e.note}`, `${e.name}=${e.value}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** What is not written, and why. */
export const NOT_WRITTEN: ReadonlyArray<readonly [string, string]> = [
  ["SLUICE_APPROVE=facilitator", "the approval is a deliberate act: set it yourself in the host's settings when you mean to start the facilitator"],
  ["SLUICE_RELAYER_KEY", "a secret: the contents of relayer-mainnet.key, put in the host's secret store, then the file deleted"],
];

/** The table to print: every name, which file, and whether it is public, a secret you set, or yours to fill in. A value is shown only if it is public. */
export function describeWiring(files: WiredFile[]): string[] {
  const lines = ["| Name | File | Kind | Value |", "| --- | --- | --- | --- |"];
  for (const f of files) {
    for (const e of f.entries) {
      const kind = e.kind === "public" ? "public" : e.kind === "secret" ? "secret (you make it; never commit it)" : "yours to fill in";
      lines.push(`| ${e.name} | ${f.file} | ${kind} | ${e.kind === "public" ? e.value : e.kind === "secret" ? "(not written)" : "(empty: fill in)"} |`);
    }
  }
  for (const [name, why] of NOT_WRITTEN) lines.push(`| ${name} | (not in any file) | secret or deliberate | ${why} |`);
  return lines;
}

/** Parses the text of one of these files into a settings object, the way a host's loader would: NAME=value lines, # comments, blanks. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}
