// The hosted deployment as separate processes, on a local fork of QIE mainnet with the REAL QUSDC:
//
//   an agent (MCP client)  ->  sluice-proxy (stdio)  ->  the tool server (Streamable HTTP, its own process)  ->  the facilitator (HTTP, its own process)  ->  the router
//
// Nothing is sent to QIE: the fork lives in this process, the keys are generated here, and QUSDC is minted on the fork only.
import { expect } from "chai";
import { network } from "hardhat";
import { QUSDC } from "../helpers/fork";
import { runRemoteScenario } from "../helpers/remote-scenario";
import { startStack } from "../helpers/stack";
import type { Stack } from "../helpers/stack";

describe("Fork: remote hosting with the real QUSDC", function () {
  this.timeout(900_000);
  let s: Stack;

  before(async () => {
    s = await startStack({ fork: true });
    expect(s.tokenAddress.toLowerCase(), "the router holds the real QUSDC").to.equal(QUSDC.toLowerCase());
  });
  after(async () => {
    await s.stop();
  });

  it("pays for a tool over HTTP through the proxy, with the real token, and keeps every refusal and the budget", async () => {
    // The separate processes read the wall clock, and the fork's blocks lag it by however long QIE's last block was ago. Move the
    // fork's clock up to the wall clock (a fork can move forward, not back), on this local copy only.
    const wall = Math.floor(Date.now() / 1000);
    const latest = (await network.provider.send("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    if (Number(BigInt(latest.timestamp)) < wall) await network.provider.send("evm_setNextBlockTimestamp", [wall]);
    await network.provider.send("evm_mine", []);
    const fresh = (await network.provider.send("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    // A fork cannot move back, and QIE's block times can be a little ahead of this machine's clock. The processes sign and check deadlines
    // against the wall clock, which is a few hundred seconds wide, so a chain some seconds ahead is fine and one that is behind is not.
    const drift = Number(BigInt(fresh.timestamp)) - wall;
    expect(drift, "the fork's clock is no more than 30 seconds behind the wall clock, and no more than 2 minutes ahead").to.be.within(-30, 120);
    await runRemoteScenario(s, { token: QUSDC });
  });
});
