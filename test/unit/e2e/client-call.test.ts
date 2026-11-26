// What pnpm client:call, pnpm live:balances and the new checks of pnpm client:owner and pnpm client:smoke refuse. The tool server here
// is a stand-in that offers whatever a test tells it to, so that each part of an offer can be wrong on its own; the successful path
// against the real programs is in local-mainnet-run.test.ts. Everything is local, with keys made for the run.
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY, buildPaymentRequired, buildRequirements, mcpRequestListener, paymentRequiredResult, resourceFor } from "@sluice/sdk";
import type { PaymentRequirements } from "@sluice/sdk";
import { expect } from "chai";
import { Contract, Wallet, getAddress, zeroPadValue } from "ethers";
import { ethers, network } from "hardhat";
import { main as owner } from "../../../scripts/client/owner-setup";
import { main as paidCall } from "../../../scripts/client/paid-call";
import { main as smoke } from "../../../scripts/client/smoke-client";
import { BALANCES_READ_ONLY_METHODS, main as balances } from "../../../scripts/live/balances";
import type { Rpc } from "../../../src/evidence";
import { QUSDC_ADDRESS } from "../../../src/guard";
import { loadArtifact } from "../../../src/live";
import { deployContract } from "../../helpers";
import { freshChain, rpcProvider, setQie, startRpc, throwawayWallet } from "../../helpers/stack";

const OTHER = getAddress(`0x${"ab".repeat(20)}`);

describe("Client commands for a local run: what they refuse", function () {
  this.timeout(120_000);
  let rpc: Awaited<ReturnType<typeof startRpc>>;
  let router: string;
  let vault: string;
  let payer: Wallet;
  let builder: Wallet;
  let tools: { url: string; server: HttpServer };
  let facilitator: { url: string; server: HttpServer; asked: string[] };
  let elsewhere: { url: string; server: HttpServer; asked: string[] };
  // What the stand-in tool server does, set by each test.
  let offer: (base: PaymentRequirements) => PaymentRequirements[];
  let asks: boolean;
  let paidAnswer: "ok" | "tool-error" | "not-accepted";
  let status: { status: number; body: unknown };
  let health: { chainId: number; router: string };
  let calls: { unpaid: number; paid: number; args: unknown[] };

  const listen = async (server: HttpServer): Promise<string> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const close = (server: HttpServer) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

  before(async () => {
    await freshChain();
    const [deployer, feeRecipient] = await ethers.getSigners();
    await network.provider.send("hardhat_setCode", [QUSDC_ADDRESS, loadArtifact("MockQUSDC", "test").deployedBytecode]);
    const contract = await deployContract("PaymentRouter", [QUSDC_ADDRESS, deployer!.address, feeRecipient!.address, 100]);
    router = getAddress(await contract.getAddress());
    vault = getAddress((await contract.vault()) as string);
    payer = throwawayWallet();
    builder = throwawayWallet();
    // The payer holds 0.05 QUSDC in the router, put there with a little QIE.
    await setQie(payer.address, 10n ** 18n);
    const qusdc = new Contract(QUSDC_ADDRESS, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"], deployer!);
    await (await qusdc.getFunction("mint")(payer.address, 60_000n)).wait();
    rpc = await startRpc();
    const provider = rpcProvider(rpc.url);
    const signer = payer.connect(provider);
    await (await (qusdc.connect(signer) as Contract).getFunction("approve")(router, 50_000n)).wait();
    await (await new Contract(router, ["function deposit(uint256)"], signer).getFunction("deposit")(50_000n)).wait();
    provider.destroy();

    const mcp = mcpRequestListener(async () => {
      const server = new Server({ name: "stand-in", version: "0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" as const } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const payment = (request.params._meta as Record<string, unknown> | undefined)?.[PAYMENT_META_KEY];
        if (payment === undefined) {
          calls.unpaid += 1;
          calls.args.push(request.params.arguments);
          if (!asks) return { content: [{ type: "text" as const, text: "free today" }] };
          const base = buildRequirements({ toolName: request.params.name, amount: 2_000n, payTo: builder.address, router, vault, chainId: 1990, asset: QUSDC_ADDRESS });
          return paymentRequiredResult(buildPaymentRequired(resourceFor(request.params.name), offer(base))) as never;
        }
        calls.paid += 1;
        if (paidAnswer === "tool-error") return { isError: true, content: [{ type: "text" as const, text: "the node did not answer" }] };
        const settlement = { success: paidAnswer === "ok", transaction: "", network: "eip155:1990", extensions: { sluice: { id: "x", status: "queued", statusUrl: `${elsewhere.url}/status/x` } } };
        return { content: [{ type: "text" as const, text: "answered" }], _meta: { [PAYMENT_RESPONSE_META_KEY]: settlement } };
      });
      return server as never;
    });
    const toolServer = createServer((req, res) => void mcp(req, res));
    tools = { server: toolServer, url: await listen(toolServer) };
    const stand = async (answer: (path: string) => { status: number; body: unknown }) => {
      const asked: string[] = [];
      const server = createServer((req, res) => {
        asked.push(`${req.method} ${req.url}`);
        const a = answer(req.url ?? "");
        res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
      });
      return { server, asked, url: await listen(server) };
    };
    facilitator = await stand((path) => (path === "/health" ? { status: 200, body: health } : status));
    elsewhere = await stand(() => ({ status: 200, body: { status: "settled", transaction: `0x${"11".repeat(32)}` } }));
  });
  beforeEach(() => {
    offer = (base) => [base];
    asks = true;
    paidAnswer = "ok";
    status = { status: 404, body: { error: "not_found" } };
    health = { chainId: 1990, router };
    calls = { unpaid: 0, paid: 0, args: [] };
    facilitator.asked.length = 0;
    elsewhere.asked.length = 0;
  });
  after(async () => {
    await close(tools.server);
    await close(facilitator.server);
    await close(elsewhere.server);
    await rpc.close();
  });

  const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "paid-call", SLUICE_MAX_QUSDC: "0.002", SLUICE_KEY: payer.privateKey, SLUICE_ROUTER: router,
    SLUICE_RPC_URL: rpc.url, SLUICE_FACILITATOR_URL: facilitator.url, ...extra,
  });
  const argv = (change: Record<string, string | undefined> = {}): string[] => {
    const flags: Record<string, string | undefined> = { "--server": `${tools.url}/mcp`, "--from": payer.address, "--payee": builder.address, "--tool": "echo", "--wait-seconds": "0", ...change };
    return Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [k, v]));
  };
  const run = async (args = argv(), environment = env()) => {
    const lines: string[] = [];
    const code = await paidCall(args, environment, { log: (l) => lines.push(l), sleep: async () => undefined });
    const text = lines.join("\n");
    expect(text, "the key is never printed").to.not.contain(payer.privateKey.slice(2));
    return { code, text };
  };

  describe("client:call", () => {
    it("refuses a wrong command with exit 2, before it asks anyone anything", async () => {
      const cases: Array<[string[], Record<string, string | undefined>, RegExp]> = [
        [argv({ "--server": undefined }), env(), /--server is needed/],
        [argv({ "--from": undefined }), env(), /--from is needed/],
        [argv({ "--payee": undefined }), env(), /--payee is needed/],
        [argv({ "--tool": undefined }), env(), /--tool is needed/],
        [argv({ "--from": "0x12" }), env(), /--from is not an address/],
        [argv({ "--payee": "me" }), env(), /--payee is not an address/],
        [argv({ "--server": "http://tools.example/mcp" }), env(), /--server must be https/],
        [argv({ "--wait-seconds": "-1" }), env(), /--wait-seconds needs a value|--wait-seconds must be/],
        [argv({ "--wait-seconds": "601" }), env(), /--wait-seconds must be/],
        [[...argv(), "--arg", "no-equals"], env(), /--arg is name=value/],
        [[...argv(), "--arg", "a=1", "--arg", "a=2"], env(), /--arg a was given twice/],
        [[...argv(), "--tool", "echo"], env(), /--tool was given twice/],
        [[...argv(), "--args", "{}"], env(), /unknown option --args/],
        [argv(), env({ SLUICE_ROUTER: undefined }), /set SLUICE_ROUTER/],
        [argv(), env({ SLUICE_FACILITATOR_URL: undefined }), /set SLUICE_FACILITATOR_URL/],
        [argv(), env({ SLUICE_FACILITATOR_URL: "http://facilitator.example" }), /SLUICE_FACILITATOR_URL must be https/],
      ];
      for (const [args, environment, why] of cases) {
        const out = await run(args, environment);
        expect(out.code, `${args.join(" ")}\n${out.text}`).to.equal(2);
        expect(out.text).to.match(why);
      }
      expect(calls.unpaid + calls.paid + facilitator.asked.length).to.equal(0);
    });

    it("refuses without its approval, without a written cap, and with a key that is not --from's, before it asks anyone anything", async () => {
      const cases: Array<[string[], Record<string, string | undefined>, RegExp]> = [
        [argv(), env({ SLUICE_APPROVE: undefined }), /set SLUICE_APPROVE=paid-call/],
        [argv(), env({ SLUICE_APPROVE: "owner-setup" }), /approves "owner-setup", not "paid-call"/],
        [argv(), env({ SLUICE_MAX_QUSDC: undefined }), /set SLUICE_MAX_QUSDC, the most this one call may pay/],
        [argv(), env({ SLUICE_NETWORK: "local" }), /set SLUICE_NETWORK to mainnet or testnet/],
        [argv(), env({ SLUICE_KEY: "0x12" }), /SLUICE_KEY must be set/],
        [argv({ "--from": builder.address }), env(), new RegExp(`the key in SLUICE_KEY is ${payer.address}'s, not --from ${builder.address}'s, so nothing was signed`)],
      ];
      for (const [args, environment, why] of cases) {
        const out = await run(args, environment);
        expect(out.code, out.text).to.equal(1);
        expect(out.text).to.match(why);
      }
      expect(calls.unpaid + calls.paid + facilitator.asked.length).to.equal(0);
    });

    it("signs nothing for an offer that is not the one asked for, and says which part is not", async () => {
      const cases: Array<[string, (b: PaymentRequirements) => PaymentRequirements[], RegExp]> = [
        ["scheme", (b) => [{ ...b, scheme: "exact" as never }], /its scheme is not sluice-intent/],
        ["network", (b) => [{ ...b, network: "eip155:1" }], /it is for another network/],
        ["token", (b) => [{ ...b, asset: OTHER }], /it asks for another token/],
        ["router", (b) => [{ ...b, extra: { ...b.extra, router: OTHER } }], /it names another router/],
        ["payee", (b) => [{ ...b, payTo: OTHER }], new RegExp(`it would pay ${OTHER}, not --payee ${builder.address}`)],
        ["tool", (b) => [{ ...b, extra: { ...b.extra, toolId: zeroPadValue("0x01", 32) } }], /its tool id is not this tool's/],
        ["above the cap", (b) => [{ ...b, amount: "2001" }], /it asks 0\.002001 QUSDC, above the cap of 0\.002000/],
        ["zero", (b) => [{ ...b, amount: "0" }], /its amount is not above zero/],
        ["not a number", (b) => [{ ...b, amount: "2e3" }], /its amount is not above zero/],
        ["malformed", (b) => [{ ...b, payTo: "nobody" }], /it is malformed/],
        ["none", () => [], /it made none/],
      ];
      for (const [name, change, why] of cases) {
        offer = change;
        const out = await run();
        expect(out.code, `${name}\n${out.text}`).to.equal(1);
        expect(out.text, name).to.contain("nothing was signed: no offer from the server can be taken");
        expect(out.text, name).to.match(why);
      }
      expect(calls.paid, "no payment ever reached the server").to.equal(0);
    });

    it("signs nothing when the payer's balance in the router is below the price, or the server asks for nothing", async () => {
      offer = (b) => [{ ...b, amount: "50001" }];
      const poor = await run(argv(), env({ SLUICE_MAX_QUSDC: "1" }));
      expect(poor.code).to.equal(1);
      expect(poor.text).to.contain("nothing was signed: the payer's balance in the router is 0.050000 QUSDC, less than the price of 0.050001");
      asks = false;
      const free = await run();
      expect(free.code).to.equal(1);
      expect(free.text).to.contain("the server did not ask for a payment, so nothing was signed: free today");
      expect(calls.paid).to.equal(0);
    });

    it("does not go on when the facilitator is for another router or another chain, or does not answer", async () => {
      for (const bad of [{ chainId: 1990, router: OTHER }, { chainId: 1983, router }]) {
        health = bad;
        const out = await run();
        expect(out.code).to.equal(1);
        expect(out.text).to.contain("the facilitator is not answering for this network and this router");
      }
      const gone = await run(argv(), env({ SLUICE_FACILITATOR_URL: "http://127.0.0.1:1" }));
      expect(gone.text).to.contain("the facilitator is not answering");
      expect(calls.unpaid + calls.paid).to.equal(0);
    });

    it("passes the tool's arguments as they were given", async () => {
      await run([...argv(), "--arg", "tokenIn=QIE", "--arg", "note=a=b c"]);
      expect(calls.args[0]).to.deep.equal({ tokenIn: "QIE", note: "a=b c" });
    });

    it("says to check before paying again when the paid call fails or is not accepted", async () => {
      paidAnswer = "tool-error";
      const failed = await run();
      expect(failed.code).to.equal(1);
      expect(failed.text).to.match(/the call did not go through: .*\ncheck whether the facilitator holds the payment before paying again: http:\/\/127\.0\.0\.1:\d+\/status\/0x[0-9a-f]{64}/);
      paidAnswer = "not-accepted";
      const refused = await run();
      expect(refused.code).to.equal(1);
      expect(refused.text).to.contain("the reply does not say the payment was accepted. Check before paying again:");
      expect(calls.paid).to.equal(2);
    });

    it("reads the settlement from the facilitator it was given, never from an address the server sent", async () => {
      const waiting = await run();
      expect(waiting.code, waiting.text).to.equal(0);
      expect(waiting.text).to.contain("settlement: not known");
      expect(waiting.text).to.match(/not settled yet\. Ask again later, and do not pay a second time for this call: http:\/\/127\.0\.0\.1:\d+\/status\/0x[0-9a-f]{64}/);
      expect(waiting.text).to.not.contain("record it");
      expect(elsewhere.asked, "the server's address was not asked").to.deep.equal([]);
      expect(facilitator.asked.some((a) => /^GET \/status\/0x[0-9a-f]{64}$/.test(a))).to.equal(true);
    });

    it("exits 1 for a payment that will not settle, and gives the record lines only for one that did", async () => {
      for (const final of ["skipped", "expired", "failed"]) {
        status = { status: 200, body: { status: final, reason: "because" } };
        const out = await run();
        expect(out.code, final).to.equal(1);
        expect(out.text).to.contain(`settlement: ${final} (because)`).and.to.contain("the payer was not charged by it");
        expect(out.text).to.not.contain("record it");
      }
      const hash = `0x${"22".repeat(32)}`;
      status = { status: 200, body: { status: "settled", transaction: hash } };
      const done = await run();
      expect(done.code).to.equal(0);
      expect(done.text).to.contain(`record it: pnpm evidence:record --claim paid-call-settlement --tx ${hash} --network mainnet --router ${router} --tool echo`);
      expect(done.text).to.contain(`pnpm evidence:record --claim settle-batch --tx ${hash} --network mainnet --router ${router}`);
    });
  });

  describe("client:owner --from and revoke", () => {
    const ownerRun = async (args: string[], extra: Record<string, string | undefined> = {}) => {
      const lines: string[] = [];
      const code = await owner(args, env({ SLUICE_APPROVE: "owner-setup", SLUICE_MAX_QUSDC: "1", ...extra }), { log: (l) => lines.push(l) });
      const text = lines.join("\n");
      expect(text).to.not.contain(payer.privateKey.slice(2));
      return { code, text };
    };

    it("signs nothing with a key that is not --from's, for every command, and asks nothing first", async () => {
      for (const args of [["start", "--amount", "0.01"], ["withdraw", "--amount", "0.01"], ["refund", "--amount", "0.01"], ["authorize", "--agent", OTHER], ["revoke", "--agent", OTHER]]) {
        const out = await ownerRun([...args, "--from", builder.address]);
        expect(out.code, args[0]).to.equal(1);
        expect(out.text).to.contain(`the key in SLUICE_KEY is ${payer.address}'s, not --from ${builder.address}'s, so nothing was signed`);
      }
      expect(facilitator.asked).to.deep.equal([]);
      const bad = await ownerRun(["refund", "--amount", "0.01", "--from", "0x12"]);
      expect(bad.code).to.equal(2);
      expect(bad.text).to.contain("--from is not an address");
    });

    it("ends only a session that exists, and sends nothing otherwise", async () => {
      const none = await ownerRun(["revoke", "--agent", OTHER, "--from", payer.address]);
      expect(none.code, none.text).to.equal(1);
      expect(none.text).to.contain("this wallet has no session for that agent, so there is nothing to end");
      expect(facilitator.asked.filter((a) => a.startsWith("POST"))).to.deep.equal([]);
      expect((await ownerRun(["revoke"])).text).to.contain("revoke needs --agent");
      expect((await ownerRun(["revoke", "--agent", "x"])).text).to.contain("--agent is not an address");
    });
  });

  describe("client:smoke --arg", () => {
    it("refuses both forms at once, a name twice and a pair with no name, before it starts anything", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sluice-smoke-arg-"));
      try {
        writeFileSync(join(dir, "c.json"), "{}");
        const cases: Array<[string[], RegExp]> = [
          [["--arg", "a=1", "--args", "{}"], /--arg or with --args, not both/],
          [["--arg", "a=1", "--arg", "a=2"], /--arg a was given twice/],
          [["--arg", "=1"], /--arg is name=value/],
          [["--arg"], /--arg is name=value/],
          [["--args", "{address:0x12}"], /in PowerShell 5 use --arg name=value instead/],
        ];
        for (const [extra, why] of cases) {
          const lines: string[] = [];
          const code = await smoke(["--config", join(dir, "c.json"), "--tool", "x", ...extra], { SLUICE_AGENT_KEY: payer.privateKey }, { log: (l) => lines.push(l) });
          expect(code, extra.join(" ")).to.equal(2);
          expect(lines.join("\n")).to.match(why);
          expect(lines.join("\n")).to.not.contain("step 1");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("live:balances", () => {
    const read = async (args: string[], environment: Record<string, string | undefined> = { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: rpc.url }, io: { rpc?: Rpc; cwd?: string } = {}) => {
      const lines: string[] = [];
      const code = await balances(args, environment, { log: (l) => lines.push(l), cwd: tmpdir(), ...io });
      return { code, text: lines.join("\n") };
    };

    it("shows each address's wallet and router amounts, using the four read-only methods and nothing else", async () => {
      const methods: string[] = [];
      const recording: Rpc = async (method, params) => {
        methods.push(method);
        return network.provider.send(method, params);
      };
      const out = await read(["--router", router, "--address", payer.address, "--address", builder.address], undefined, { rpc: recording });
      expect(out.code, out.text).to.equal(0);
      expect(out.text).to.match(new RegExp(`^mainnet, block \\d+, router ${router}\\.`, "m"));
      expect(out.text).to.match(new RegExp(`^${payer.address}  QIE 0\\.9\\d+  QUSDC in wallet 0\\.010000  prepaid in router 0\\.050000  earnings in router 0\\.000000$`, "m"));
      expect(out.text).to.contain(`${builder.address}  QIE 0  QUSDC in wallet 0.000000  prepaid in router 0.000000  earnings in router 0.000000`);
      expect([...new Set(methods)].sort()).to.deep.equal([...BALANCES_READ_ONLY_METHODS].sort());
    });

    it("takes the router from SLUICE_ROUTER, or from a deployment record of the same network", async () => {
      expect((await read(["--address", payer.address], { SLUICE_NETWORK: "mainnet", SLUICE_RPC_URL: rpc.url, SLUICE_ROUTER: router })).code).to.equal(0);
      const dir = mkdtempSync(join(tmpdir(), "sluice-balances-"));
      try {
        writeFileSync(join(dir, "deployment.json"), JSON.stringify({ network: "mainnet", router }));
        expect((await read(["--address", payer.address], undefined, { cwd: dir })).text).to.contain(`router ${router}`);
        writeFileSync(join(dir, "deployment.json"), JSON.stringify({ network: "testnet", router }));
        expect((await read(["--address", payer.address], undefined, { cwd: dir })).text).to.contain("no router: give --router");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses a wrong command, another chain and an address with no router, and never prints a number it did not read", async () => {
      for (const [args, environment, why] of [
        [[], undefined, /give from 1 to 12 --address/],
        [["--address", "x"], undefined, /--address is not an address/],
        [["--bogus", "1"], undefined, /unknown option --bogus/],
        [["--address", payer.address], {}, /set SLUICE_NETWORK/],
      ] as Array<[string[], Record<string, string | undefined> | undefined, RegExp]>) {
        const out = await read(args, environment);
        expect(out.code).to.equal(2);
        expect(out.text).to.match(why);
      }
      const chain = await read(["--router", router, "--address", payer.address], { SLUICE_NETWORK: "testnet", SLUICE_RPC_URL: rpc.url });
      expect(chain.code, chain.text).to.not.equal(0);
      expect(chain.text).to.not.contain("QUSDC in wallet");
      const empty = await read(["--router", OTHER, "--address", payer.address]);
      expect(empty.code).to.equal(1);
      expect(empty.text).to.contain(`there is no router at ${OTHER} on mainnet`);
      const down = await read(["--router", router, "--address", payer.address], undefined, { rpc: async () => { throw new Error("down"); } });
      expect(down.code).to.not.equal(0);
      expect(down.text).to.not.contain("QUSDC in wallet");
    });
  });
});
