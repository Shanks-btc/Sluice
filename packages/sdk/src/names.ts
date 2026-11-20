// Payees are addresses or .qie names.
//
// A .qie name needs a resolver. There is no default one: the sources read for this project document no
// on-chain read that turns a QIE ID name into an address. The only documented path is the hosted QIE Wallet
// MCP's `qie_resolve_name` tool, which is a remote service and not an on-chain read, so Sluice does not call it.
// A third-party contract verified on QIE says the QIE ID token answers balanceOf but not ownerOf, addr or name;
// that is that contract's statement and was not checked here.
//
// So: an address always works. A name works only when the caller supplies a `NameResolver`, and otherwise it
// fails loudly instead of paying a guess.
import { getAddress, isAddress } from "ethers";

export type NameResolver = (name: string) => Promise<string | null | undefined>;

export class NameResolutionError extends Error {
  constructor(name: string, why: string) {
    super(`cannot resolve ${name}: ${why}`);
    this.name = "NameResolutionError";
  }
}

export const isQieName = (value: string): boolean => /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.qie$/i.test(value.trim());

/** Turns a payee into a checksummed address, or throws. */
export async function resolvePayee(payee: string, resolver?: NameResolver): Promise<string> {
  const value: string = payee.trim();
  if (isAddress(value as unknown)) return getAddress(value);
  if (!isQieName(value)) throw new NameResolutionError(value, "not an address and not a .qie name");
  if (!resolver) {
    throw new NameResolutionError(
      value,
      "no .qie resolver is configured, and no documented on-chain QIE ID read exists to use by default. Pass the address, or supply a resolver",
    );
  }
  const resolved = await resolver(value.toLowerCase());
  if (!resolved || !isAddress(resolved)) throw new NameResolutionError(value, "the resolver returned no address");
  return getAddress(resolved);
}
