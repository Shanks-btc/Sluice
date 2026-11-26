// QIE's explorer's own answers about the AgentVault, saved in docs/explorer/vault-record.json, and the one question the documents and
// the web app ask of them: did the explorer show verified source for this vault, and when was that read? Without a record that says so,
// nothing may say so. The record is not a row of docs/EVIDENCE.md: no program re-reads it from the explorer, and the vault's code is
// checked separately, over RPC, by src/vaultcheck.ts.
//
// This file reads text it is given. It asks nothing of any network.

export const VAULT_RECORD_PATH = "docs/explorer/vault-record.json";

export type VaultShown = {
  /** The vault the explorer answered about, with its checksum capitals as recorded. */
  vault: string;
  /** When the answers were read, as 2026-11-26T06:11:51Z. */
  readAt: string;
};

type Answer = Record<string, unknown>;

const object = (value: unknown): Answer | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Answer) : undefined);

/** What the record shows, or null if there is no record, it cannot be read, or any part of it does not say the vault is verified. */
export function explorerShowsVault(text: string | undefined): VaultShown | null {
  if (text === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = object(parsed);
  if (!record || record["explorer"] !== "https://mainnet.qie.digital" || record["chainId"] !== 1990) return null;
  const vault = record["vault"];
  const readAt = record["readAt"];
  if (typeof vault !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(vault)) return null;
  if (typeof readAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(readAt)) return null;
  const address = object(record["GET /api/v2/addresses/{vault}"]);
  const source = object(record["GET /api/v2/smart-contracts/{vault}"]);
  if (!address || !source) return null;
  if (typeof address["hash"] !== "string" || address["hash"].toLowerCase() !== vault.toLowerCase()) return null;
  if (address["is_contract"] !== true || address["is_verified"] !== true || address["name"] !== "AgentVault") return null;
  if (source["is_verified"] !== true || source["name"] !== "AgentVault") return null;
  return { vault, readAt };
}
