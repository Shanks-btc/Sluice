// A client written only from docs/SPEC.md completes a paid call against the SDK, through the facilitator and the router.
// Then the spec's text is held to the code: its examples are the vectors, its type strings are the contract's, and every
// error code the SDK can return is in its table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, getAddress, parseEther } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ERRORS, FacilitatorClient, SCHEME, createPaywall, serveMcpHttp, toolIdOf } from "@sluice/sdk";
import { USDC } from "../../helpers";
import { SpecClient } from "../../helpers/spec-client";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n"); // LF whatever git's autocrlf did to the checkout

describe("Spec compatibility: a client written only from the spec", function () {
  this.timeout(120_000);
  let s: Stack;
  let payer: Wallet;
  let agent: Wallet;
  let builder: Wallet;
  let url: string;
  let close: () => Promise<void>;
  let runs = 0;

  before(async () => {
    s = await startStack({ feeBps: 100 });
    payer = throwawayWallet();
    agent = throwawayWallet();
    builder = throwawayWallet();
    await fundWallet(s, payer, USDC("5"), parseEther("1"));
    await depositFor(s, payer, USDC("5"));
    await (
      await s.vault.connect(payer.connect(s.provider)).authorize(
        { agent: agent.address, budget: USDC("0.5"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 86_400) },
        [{ payee: builder.address, toolId: toolIdOf("echo") }],
      )
    ).wait();
    const paywall = createPaywall({ facilitator: new FacilitatorClient({ url: s.facilitatorUrl }), router: s.routerAddress, vault: s.vaultAddress, asset: s.tokenAddress, now: s.clock });
    const served = await serveMcpHttp(async () => {
      const server = new McpServer({ name: "spec-target", version: "0" });
      await paywall.registerPaidTool(server, { name: "echo", price: "0.01", payee: builder.address, description: "Echoes text.", inputSchema: { text: z.string() } }, async (a: { text: string }) => {
        runs += 1;
        return { content: [{ type: "text", text: `echo:${a.text}` }] };
      });
      return server;
    });
    url = `http://127.0.0.1:${served.port}/mcp`;
    close = () => new Promise<void>((resolve) => served.server.close(() => resolve()));
  });
  after(async () => {
    await close();
    await s.stop();
  });
  beforeEach(() => {
    runs = 0;
  });

  const client = (key: string, who: string, router = s.routerAddress) =>
    new SpecClient({ url, privateKey: key, payer: who, expectedRouter: router, now: s.clock });

  it("pays for a tool as the payer: asks, reads the requirements, signs per section 4, retries, and gets the result and the settlement", async () => {
    const c = client(payer.privateKey, payer.address);
    await c.initialize();
    const { result, paid } = await c.callTool("echo", { text: "from the spec" });
    expect(paid).to.equal(true);
    expect(result.isError).to.not.equal(true);
    expect(result.content![0]!.text).to.equal("echo:from the spec");
    const settlement = result._meta!["x402/payment-response"];
    expect(settlement).to.deep.include({ success: true, transaction: "", network: "eip155:1990", payer: payer.address, amount: "10000" });
    const id = settlement.extensions.sluice.id as string;
    expect(settlement.extensions.sluice.status).to.equal("queued");
    expect(runs).to.equal(1);

    expect(await s.facilitator.flush()).to.include({ submitted: 1, settled: 1 });
    expect(s.facilitator.status(id)).to.deep.include({ status: "settled", payer: payer.address, payee: builder.address, amount: "10000" });
    expect(await s.router.earnings(builder.address)).to.equal(USDC("0.01") - USDC("0.01") / 100n);
    expect(await s.router.payerBalance(payer.address)).to.equal(USDC("5") - USDC("0.01"));
  });

  it("pays as an agent session key, which the spec says the router accepts when the payer authorised it", async () => {
    const c = client(agent.privateKey, payer.address);
    await c.initialize();
    const { result, paid } = await c.callTool("echo", { text: "agent" });
    expect(paid).to.equal(true);
    expect(result.content![0]!.text).to.equal("echo:agent");
    await s.facilitator.flush();
    const id = result._meta!["x402/payment-response"].extensions.sluice.id as string;
    expect(s.facilitator.store.get(id)!.signer).to.equal(agent.address);
  });

  it("a key with no session is refused with the code the spec names, and the tool does not run", async () => {
    const stranger = throwawayWallet();
    const c = client(stranger.privateKey, payer.address);
    await c.initialize();
    const { result, paid } = await c.callTool("echo", { text: "nope" });
    expect(paid).to.equal(true);
    expect(result.isError).to.equal(true);
    expect(SpecClient.paymentRequired(result)!.error).to.equal("sluice_session_not_found");
    expect(runs).to.equal(0);
  });

  it("declines to sign for a router it did not expect (section 13), and pays nothing", async () => {
    const c = client(payer.privateKey, payer.address, throwawayWallet().address);
    await c.initialize();
    const { paid, refused } = await c.callTool("echo", { text: "x" });
    expect(paid).to.equal(false);
    expect(refused).to.match(/router this client expects/);
    expect(runs).to.equal(0);
  });

  it("does not import any Sluice code", () => {
    const source = read("test/helpers/spec-client.ts");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).to.deep.equal(["ethers"]);
    expect(source).to.not.match(/@sluice|\.\.\/\.\.\/src|packages\//);
  });
});

describe("Spec compatibility: the text of docs/SPEC.md matches the code", () => {
  const spec = read("docs/SPEC.md");
  const vectors = JSON.parse(read("docs/spec-vectors.json"));

  it("quotes the first valid vector exactly: its signature, digest, nonce, addresses and tool id", () => {
    const v = vectors.paymentVectors.valid[0];
    for (const needle of [v.payload.payload.signature, v.digest, v.message.nonce, v.message.payer, v.message.payee, v.message.toolId, vectors.addresses.router, vectors.addresses.vault]) {
      expect(spec, needle).to.contain(needle);
    }
    const required = vectors.paymentRequired.accepts[0];
    expect(required.scheme).to.equal(SCHEME);
    expect(spec).to.contain(`"scheme": "${SCHEME}"`);
    expect(spec).to.contain(`"toolId": "${toolIdOf("echo")}"`);
  });

  it("gives the type strings the contracts use", async () => {
    for (const type of Object.values<string>(vectors.typeStrings)) expect(spec, type).to.contain(type);
  });

  it("lists every error code the SDK can return in its table", () => {
    for (const code of Object.values(ERRORS)) expect(spec, code).to.contain(`\`${code}\``);
  });

  it("states the numbers the code enforces: the 2% cap, the deadline window, the signature form and the relayer ceilings", () => {
    for (const needle of ["`MAX_FEE_BPS = 200`", "20 seconds", "min(maxTimeoutSeconds, 3600) + 30", "half the secp256k1 group order", "60,000", "130,000", "4,000,000", "5 gwei", "2 QIE"]) {
      expect(spec, needle).to.contain(needle);
    }
  });

  it("says that it is an independent scheme and credits x402, and names the QUSDC burn risk", () => {
    expect(spec).to.contain("It is not an official x402 scheme");
    expect(spec).to.contain("https://github.com/coinbase/x402");
    expect(spec).to.contain("admin account can give itself the right to burn any holder's QUSDC");
    expect(spec).to.contain("raise its own budget");
  });

  it("has the sections the brief asks for", () => {
    const headings = spec.split("\n").filter((l) => /^## /.test(l)).map((l) => l.slice(3));
    expect(headings).to.deep.equal([
      "1. The problem",
      "2. Parties and flow",
      "3. Messages (x402 over MCP)",
      "4. The signed intent",
      "5. Balance, settlement and fee",
      "6. Session keys",
      "7. Verification and the facilitator",
      "8. Starting with no QIE, and leaving",
      "9. Error codes",
      "10. Replay protection",
      "11. Security considerations",
      "12. Differences from x402",
      "13. Conformance",
      "14. Test vectors",
      "15. Credits",
    ]);
    expect(getAddress(vectors.addresses.router)).to.equal(vectors.addresses.router);
  });
});
