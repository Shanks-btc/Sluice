// The real-client kit's scripted client, run across separate processes on a local chain:
//
//   the scripted MCP client (this test, using the official SDK client)  ->  the payment proxy (child process, stdio)  ->  the tool server (HTTP, its own process)  ->  the facilitator (HTTP, its own process)
//
// This is a script's run, and it is labelled as one. It is not a run of any MCP application. No key leaves this machine.
import { expect } from "chai";
import { id } from "ethers";
import { ethers } from "hardhat";
import { main as smoke } from "../../../scripts/client/smoke-client";
import { deployContract } from "../../helpers";
import { fakeExplorer, serveExplorer } from "../../helpers/explorer";
import { startDeployment } from "../../helpers/remote";
import type { Deployment } from "../../helpers/remote";
import { settled } from "../../helpers/remote-scenario";
import { tsCommand } from "../../helpers/spawn";
import { freshChain, startStack } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

describe("Real-client kit: the scripted MCP client through proxy, tool server and facilitator", function () {
  this.timeout(300_000);
  let s: Stack;
  let d: Deployment;
  let explorer: Awaited<ReturnType<typeof serveExplorer>>;
  let target: string;

  const run = async (argv: string[], env: Record<string, string | undefined> = { SLUICE_AGENT_KEY: d.agent.privateKey }) => {
    const lines: string[] = [];
    const code = await smoke(argv, env, { log: (l) => lines.push(l), command: tsCommand("packages/proxy/src/cli.ts", ["--config", d.configPath]) });
    return { code, text: lines.join("\n"), lines };
  };

  before(async () => {
    await freshChain(); // the processes read the wall clock
    s = await startStack({ feeBps: 100 });
    const [admin, tokenOwner] = await ethers.getSigners();
    const token = await deployContract("RoleToken", [admin!.address, tokenOwner!.address]);
    await (await token.connect(admin!).grantRole(id("VAULT_ROLE"), tokenOwner!.address)).wait();
    target = await token.getAddress();
    explorer = await serveExplorer(fakeExplorer(ethers.provider));
    d = await startDeployment(s, { explorerUrl: explorer.url, budget: { allowed: ["token_risk_check", "contract_lookup"], perCallCap: "0.02", totalCap: "0.5" } });
  });
  after(async () => {
    await d?.stop();
    await explorer?.close();
    await s.stop();
  });

  it("lists the tools the proxy offers, with their advertised prices", async () => {
    const out = await run(["--config", d.configPath, "--list-only"]);
    expect(out.code, out.text).to.equal(0);
    expect(out.text).to.contain("step 1: start the payment proxy as a child process");
    expect(out.text).to.contain("step 2: connected over stdio");
    expect(out.text).to.match(/step 3: tools\/list returned 3 tools/);
    expect(out.text).to.match(/contract_lookup\s+price 5000 units/);
  });

  it("makes one paid call and prints every step, labelled as a scripted client", async () => {
    const out = await run(["--config", d.configPath, "--tool", "contract_lookup", "--args", JSON.stringify({ address: target })]);
    expect(out.code, out.text).to.equal(0);
    for (const step of ["step 1:", "step 2:", "step 3:", "step 4: tools/call contract_lookup", "step 5: the tool answered", "step 6: payment response: success true"]) {
      expect(out.text, step).to.contain(step);
    }
    expect(out.text).to.contain("scripted MCP client");
    expect(out.text).to.contain(`payer ${d.owner.address}`);
    expect(out.text).to.contain("network eip155:1990, amount 5000 units");
    const intent = /intent (0x[0-9a-f]{64}) is queued/.exec(out.text)?.[1];
    expect(intent, out.text).to.be.a("string");
    // The facilitator process settles it on its own timer.
    expect((await settled(d, intent as string)).status).to.equal("settled");
  });

  it("never names an MCP application it did not run, and never prints the session key", async () => {
    const out = await run(["--config", d.configPath, "--tool", "contract_lookup", "--args", JSON.stringify({ address: target })]);
    expect(out.code, out.text).to.equal(0);
    expect(out.text).to.not.match(/Claude|Cursor/i);
    expect(out.text).to.not.contain(d.agent.privateKey);
    expect(out.text).to.not.contain(d.agent.privateKey.slice(2));
    // A key that slipped into a line would be cut out by the printer itself.
    const lines: string[] = [];
    await smoke(["--config", d.configPath, "--list-only"], { SLUICE_AGENT_KEY: d.agent.privateKey }, { log: (l) => lines.push(l), command: tsCommand("packages/proxy/src/cli.ts", ["--config", d.configPath]) });
    expect(lines.join("\n")).to.not.contain(d.agent.privateKey);
  });

  it("reports a refusal by the proxy as a refusal: a tool the owner did not allow is not called, and the exit code says so", async () => {
    const out = await run(["--config", d.configPath, "--tool", "dex_quote", "--args", JSON.stringify({ tokenIn: "QIE", tokenOut: target, amountIn: "1" })]);
    expect(out.code, out.text).to.equal(1);
    expect(out.text).to.match(/step 5: the call did not go through: sluice_proxy_refused \(unknown_tool\)/);
  });

  it("says so when the tool is not in the list, and does not call it", async () => {
    const out = await run(["--config", d.configPath, "--tool", "not_a_tool"]);
    expect(out.code).to.equal(1);
    expect(out.text).to.contain('the tool "not_a_tool" is not in that list, so nothing was called');
  });

  it("refuses a wrong command with a reason, before it starts anything", async () => {
    const bad = async (argv: string[], env: Record<string, string | undefined>, why: RegExp) => {
      const out = await run(argv, env);
      expect(out.code).to.equal(2);
      expect(out.text).to.match(why);
      expect(out.text).to.not.contain("step 1");
    };
    await bad([], { SLUICE_AGENT_KEY: d.agent.privateKey }, /give the proxy's config file/);
    await bad(["--config", d.configPath, "--list-only"], {}, /set SLUICE_AGENT_KEY/);
    await bad(["--config", d.configPath, "--list-only"], { SLUICE_AGENT_KEY: "0x1234" }, /set SLUICE_AGENT_KEY/);
    await bad(["--config", d.configPath], { SLUICE_AGENT_KEY: d.agent.privateKey }, /give --tool/);
    await bad(["--config", d.configPath, "--tool", "x", "--args", "[1]"], { SLUICE_AGENT_KEY: d.agent.privateKey }, /--args must be a JSON object/);
    await bad(["--config", d.configPath, "--tool", "x", "--args", "nope"], { SLUICE_AGENT_KEY: d.agent.privateKey }, /--args must be a JSON object/);
    await bad(["--bogus"], { SLUICE_AGENT_KEY: d.agent.privateKey }, /unknown option/);
    await bad(["--config"], { SLUICE_AGENT_KEY: d.agent.privateKey }, /needs a value/);
  });

  it("says plainly when the proxy cannot start, instead of hanging or showing a stack", async () => {
    const lines: string[] = [];
    const code = await smoke(["--config", d.configPath, "--list-only"], { SLUICE_AGENT_KEY: d.owner.privateKey }, { log: (l) => lines.push(l), command: tsCommand("packages/proxy/src/cli.ts", ["--config", d.configPath]) });
    // The owner's own key: the proxy refuses to start with it, so the client cannot connect.
    expect(code).to.equal(1);
    expect(lines.join("\n")).to.contain("the proxy could not be started or did not answer");
    expect(lines.join("\n")).to.not.contain(d.owner.privateKey);
  });
});
