// What a page says beside a count of evidence rows: how many of them are the project's own, from the founder list. A row about a
// listed wallet shows that something happened on the chain, not that anyone else used Sluice, so no count of rows is shown without
// this. A row names one address; the paid-call counts also look at who was paid and who signed.

const share = (total: number, own: number): string => (own === 0 ? "none" : own === total ? "all" : String(own));

/** What follows a count inside a sentence ("mainnet 4, all of them about the project's own wallets"); nothing after a count of zero. */
export function ownRowsPhrase(total: number, own: number): string {
  return total === 0 ? "" : `, ${share(total, own)} of them about the project's own wallets`;
}

/** The sentence under one network's rows, or nothing when the network has no row. */
export function ownRowsSentence(network: "mainnet" | "testnet", total: number, own: number): string {
  if (total === 0) return "";
  const first = `Of the ${network} rows, ${share(total, own)} ${own === 1 && own !== total ? "is" : "are"} about the project's own wallets, by the founder list.`;
  return own === total ? `${first} None of them is counted as use by anyone else.` : first;
}

/** How many of these rows have a Who address on the list, whatever its letter case. */
export const countOwn = (rows: ReadonlyArray<{ who: string }>, ownAddresses: readonly string[]): number => rows.filter((r) => ownAddresses.includes(r.who.toLowerCase())).length;
