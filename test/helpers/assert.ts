// Small assertion helpers that need no extra libraries.
import { expect } from "chai";

/** Awaits a promise that must reject, and returns the error. Fails the test if it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

export async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await rejection(promise);
  expect(error.message).to.match(pattern);
}
