// How a command-line program ends. `process.exit()` while a network connection is still closing can abort Node 24 on Windows with a libuv
// assertion ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), after the work has finished and printed its result, and the program
// then exits with a failure code that has nothing to do with what it did. A recorder that has written its row would look as if it had failed.
//
// So a program sets its exit code and lets the event loop empty, which ends it by itself. If something is still holding the loop open after
// ten seconds, the program is ended then, with the same code: the timer is not kept alive by itself, so it never delays a clean end.

/**
 * Ends the process with `code` once nothing is left to do, or after at most ten seconds. `endNow` is what ends it then (process.exit by
 * default); a test passes its own, and clears the timer this returns, so that no test run is ended by a command's safety net.
 */
export function exitWith(code: number, endNow: (code: number) => void = (c) => process.exit(c)): ReturnType<typeof setTimeout> {
  process.exitCode = code;
  const timer = setTimeout(() => endNow(code), 10_000);
  timer.unref();
  return timer;
}
