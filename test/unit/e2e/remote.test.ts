// A hosted deployment, as separate processes on this machine:
//
//   an agent (MCP client)  ->  sluice-proxy (stdio)  ->  the tool server (Streamable HTTP, its own process)  ->  the facilitator (HTTP, its own process)  ->  the router
//
// This is the local-chain run. test/fork/remote.fork.test.ts runs the same scenario on a fork of QIE mainnet with the real QUSDC.
// No key leaves this machine and nothing is sent to QIE.
import { freshChain, startStack } from "../../helpers/stack";
import { runRemoteScenario } from "../../helpers/remote-scenario";
import type { Stack } from "../../helpers/stack";

describe("Remote hosting: proxy -> HTTP tool server -> facilitator, each its own process", function () {
  this.timeout(300_000);
  let s: Stack;

  before(async () => {
    await freshChain(); // the processes read the wall clock, so the chain's clock must be the wall clock too
    s = await startStack({ feeBps: 100 });
  });
  after(async () => {
    await s.stop();
  });

  it("pays for a tool over HTTP, keeps every refusal and the budget, and logs no secret", async () => {
    await runRemoteScenario(s);
  });
});
