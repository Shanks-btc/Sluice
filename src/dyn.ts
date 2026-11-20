import type { BaseContract, ContractRunner } from "ethers";

/**
 * A contract whose methods are looked up by name from its ABI when the code runs.
 *
 * ethers v6 types those lookups as possibly undefined once `noUncheckedIndexedAccess` is on, and its
 * `connect()` forgets the method names. This type keeps strict checking everywhere else in the project while
 * letting `contract.connect(signer).deposit(amount)` type-check. A wrong method name still fails when it runs.
 */
export interface Dyn extends BaseContract {
  connect(runner: ContractRunner | null): Dyn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: any;
}

/** Views a contract object as a Dyn. */
export const dyn = (contract: BaseContract): Dyn => contract as unknown as Dyn;
