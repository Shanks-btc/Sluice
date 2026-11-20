// The two "try it" pages, followed. The builder's page: its code is taken from the page itself, written to a scratch folder inside the
// repository and run, and the page's first request is made. The owner's page: its commands are run (the owner starts with QUSDC and no QIE,
// authorises an agent, and the scripted client makes a paid call through the proxy to the tool server built from the builder's page).
//
// Everything is local: a local chain, keys made for the run, no transaction leaves this machine. What this cannot show is whether a person
// who was not here can follow the pages: that is what the issue form collects.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Wallet, getAddress, parseEther } from "ethers";
import { PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY, toolIdOf } from "@sluice/sdk";
import { main as owner } from "../../../scripts/client/owner-setup";
import { main as smoke } from "../../../scripts/client/smoke-client";
import { main as newKey } from "../../../scripts/live/new-key";
import { USDC } from "../../helpers";
import { makePayment, requirementsFor } from "../../helpers/payments";
import { inheritedEnv, ROOT, tsCommand } from "../../helpers/spawn";
import { freshChain, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The code block that starts with a given first line. */
function block(markdown: string, firstLine: string, lang: string): string {
  const re = new RegExp("^[ \\t]*```" + lang + "\\n([\\s\\S]*?)^[ \\t]*```", "gm");
  for (const m of markdown.matchAll(re)) {
    const lines = (m[1] as string).split("\n").map((l) => l.replace(/^ {3}/, ""));
    if (lines[0]?.trim() === firstLine) return lines.join("\n");
  }
  throw new Error(`no ${lang} block starting with ${firstLine}`);
}

describe("Try it: the builder's page and the owner's page, followed", function () {
  this.timeout(300_000);
  let s: Stack;
  let scratch: string;
  let server: ChildProcess | undefined;
  let url = "";
  let dir: string;
  let builder: Wallet;
  const lines: string[] = [];

  before(async () => {
    await freshChain(); // the tool server reads the wall clock
    s = await startStack({ feeBps: 100 });
    builder = throwawayWallet();
    dir = mkdtempSync(join(tmpdir(), "sluice-tryit-"));
  });
  after(async () => {
    server?.kill("SIGKILL");
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    await s.stop();
  });

  it("the builder's code runs as written, and asks for the price when there is no payment", async () => {
    const code = block(read("docs/TRY-IT-BUILDER.md"), "// examples/my-tool/index.ts", "ts");
    scratch = join(ROOT, "examples", `.try-it-${Date.now()}`);
    mkdirSync(scratch, { recursive: true });
    const file = join(scratch, "index.ts");
    writeFileSync(file, code);
    const { command, args } = tsCommand(`examples/${scratch.split(/[\\/]/).pop()}/index.ts`);
    server = spawn(command, args, {
      cwd: ROOT,
      env: {
        ...inheritedEnv(),
        SLUICE_NETWORK: "mainnet", // the local chain has mainnet's id, which is what the page's code uses outside the testnet
        SLUICE_FACILITATOR_URL: s.facilitatorUrl,
        SLUICE_ROUTER: s.routerAddress,
        SLUICE_TOKEN: s.tokenAddress,
        SLUICE_PAYEE: builder.address,
        SLUICE_TOOLS_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errors: string[] = [];
    server.stderr?.on("data", (c: Buffer) => errors.push(c.toString()));
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the builder's server did not start: ${errors.join(" ")}`)), 90_000);
      server?.stdout?.on("data", (c: Buffer) => {
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(c.toString());
        if (m) {
          clearTimeout(timer);
          resolve(m[1] as string);
        }
      });
      server?.once("exit", (code) => reject(new Error(`the builder's server exited (${code}): ${errors.join(" ")}`)));
    });
    const asked = (await (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summarise", arguments: { url: "https://example.com" } } }),
      })
    ).json()) as { result: { isError: boolean; structuredContent: { accepts: Array<{ amount: string; payTo: string }> } } };
    expect(asked.result.isError).to.equal(true);
    expect(asked.result.structuredContent.accepts[0]).to.deep.include({ amount: "10000", payTo: builder.address });
  });

  it("the page's price is paid: a signed payment runs the tool and returns the settlement", async () => {
    const payer = throwawayWallet();
    await fundWallet(s, payer, USDC("1"), parseEther("1"));
    const token = s.token.connect(payer.connect(s.provider)) as unknown as { approve: (a: string, n: bigint) => Promise<{ wait: () => Promise<unknown> }> };
    await (await token.approve(s.routerAddress, USDC("1"))).wait();
    await (await (s.router.connect(payer.connect(s.provider)) as unknown as { deposit: (n: bigint) => Promise<{ wait: () => Promise<unknown> }> }).deposit(USDC("1"))).wait();
    const made = await makePayment(s, payer, payer.address, requirementsFor(s, builder.address, USDC("0.01"), "summarise"));
    const paid = (await (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "summarise", arguments: { url: "https://example.com" }, _meta: { [PAYMENT_META_KEY]: made.payload } } }),
      })
    ).json()) as { result: { isError?: boolean; content: Array<{ text: string }>; _meta: Record<string, { success: boolean; payer: string }> } };
    expect(paid.result.isError).to.not.equal(true);
    expect(paid.result.content[0]?.text).to.equal(`Summary of https://example.com, paid for by ${payer.address}.`);
    expect(paid.result._meta[PAYMENT_RESPONSE_META_KEY]).to.deep.include({ success: true, payer: payer.address });
    expect(await s.facilitator.flush()).to.include({ settled: 1 });
  });

  describe("the owner's page", () => {
    let ownerKey: Wallet;
    let agentKey: Wallet;
    const env = (extra: Record<string, string | undefined> = {}) => ({
      SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "owner-setup", SLUICE_KEY: ownerKey.privateKey, SLUICE_ROUTER: s.routerAddress, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, ...extra,
    });
    const run = async (argv: string[], e = env()) => {
      lines.length = 0;
      const code = await owner(argv, e, { log: (l) => lines.push(l) });
      return { code, text: lines.join("\n") };
    };

    before(async () => {
      ownerKey = throwawayWallet();
      await fundWallet(s, ownerKey, USDC("20")); // QUSDC and no QIE
      // Step 1: the agent's key, written by the same script the page names, and its address read from what it prints.
      const file = join(dir, "agent.key");
      const out: string[] = [];
      expect(newKey([file], (l) => out.push(l))).to.equal(0);
      agentKey = new Wallet(readFileSync(file, "utf8").trim());
      expect(out.join("\n")).to.contain(agentKey.address);
    });

    it("starts a wallet that holds QUSDC and no QIE: signs, the facilitator sends, and the deposit lands", async () => {
      expect(await s.provider.getBalance(ownerKey.address)).to.equal(0n);
      const out = await run(["start", "--amount", "5"]);
      expect(out.code, out.text).to.equal(0);
      expect(out.text).to.contain("signed an approval and a deposit of 5.000000 QUSDC (nothing sent yet)");
      expect(out.text).to.contain("done: 5.000000 QUSDC is in the router");
      expect(out.text).to.match(/record it: pnpm evidence:record --claim relayed-start --tx 0x[0-9a-f]{64} --topup 0x[0-9a-f]{64}/);
      expect(await s.router.payerBalance(ownerKey.address)).to.equal(USDC("5"));
      expect(out.text).to.not.contain(ownerKey.privateKey);
      expect(out.text).to.not.contain(ownerKey.privateKey.slice(2));
    });

    it("authorises the agent by signature, with the budget, the cap, the days and the tools it was given", async () => {
      const out = await run(["authorize", "--agent", agentKey.address, "--budget", "0.5", "--per-call", "0.02", "--days", "7", "--tool", `summarise=${builder.address}`]);
      expect(out.code, out.text).to.equal(0);
      expect(out.text).to.match(/authorised: 0x[0-9a-f]{64}/);
      const session = await s.vault.sessionOf(ownerKey.address, agentKey.address);
      expect(session.budget).to.equal(USDC("0.5"));
      expect(session.perCallCap).to.equal(USDC("0.02"));
      expect(await s.vault.isToolAllowed(ownerKey.address, agentKey.address, builder.address, toolIdOf("summarise"))).to.equal(true);
      expect(await s.vault.isToolAllowed(ownerKey.address, agentKey.address, builder.address, toolIdOf("other"))).to.equal(false);
      const days = Number(session.expiry) - s.clock();
      expect(days).to.be.within(6.9 * 86_400, 7.1 * 86_400);
    });

    it("makes one paid call through the proxy with the page's config, and the intent settles", async () => {
      // The page's config, with this run's addresses in place of its examples.
      const cfg = JSON.parse(block(read("docs/TRY-IT-AGENT.md"), "{", "json")) as Record<string, any>;
      expect(Object.keys(cfg).sort()).to.deep.equal(["asset", "budget", "chainId", "logFile", "payer", "router", "stateFile", "upstream"]);
      cfg.upstream = { url };
      cfg.router = s.routerAddress;
      cfg.payer = ownerKey.address;
      cfg.asset = s.tokenAddress;
      cfg.chainId = 1990;
      cfg.budget.allowedTools = [{ tool: "summarise", payee: builder.address }];
      cfg.budget.expiresAt = new Date((s.clock() + 6 * 86_400) * 1000).toISOString();
      const path = join(dir, "sluice.config.json");
      writeFileSync(path, JSON.stringify(cfg));
      const out: string[] = [];
      const before = (await s.router.payerBalance(ownerKey.address)) as bigint;
      const code = await smoke(["--config", path, "--tool", "summarise", "--args", '{"url":"https://example.com"}'], { SLUICE_AGENT_KEY: agentKey.privateKey }, {
        log: (l) => out.push(l),
        command: tsCommand("packages/proxy/src/cli.ts", ["--config", path]),
      });
      expect(code, out.join("\n")).to.equal(0);
      const text = out.join("\n");
      expect(text).to.contain(`Summary of https://example.com, paid for by ${ownerKey.address}.`);
      expect(text).to.contain("payment response: success true");
      expect(await s.facilitator.flush()).to.include({ settled: 1 });
      expect((await s.router.payerBalance(ownerKey.address)) as bigint).to.equal(before - USDC("0.01"));
      expect(readFileSync(join(dir, "sluice-payments.jsonl"), "utf8")).to.contain('"tool":"summarise"');
    });
  });

  describe("the owner's script refuses what it should", () => {
    let o: Wallet;
    beforeEach(async () => {
      o = throwawayWallet();
      await fundWallet(s, o, USDC("20"));
    });
    const e = (extra: Record<string, string | undefined> = {}) => ({
      SLUICE_NETWORK: "mainnet", SLUICE_APPROVE: "owner-setup", SLUICE_KEY: o.privateKey, SLUICE_ROUTER: s.routerAddress, SLUICE_FACILITATOR_URL: s.facilitatorUrl, SLUICE_RPC_URL: s.rpcUrl, ...extra,
    });
    const run = async (argv: string[], env: Record<string, string | undefined>) => {
      const out: string[] = [];
      const code = await owner(argv, env, { log: (l) => out.push(l) });
      return { code, text: out.join("\n") };
    };
    const quiet = async (argv: string[], env = e()) => {
      const before = await s.router.payerBalance(o.address);
      const r = await run(argv, env);
      expect(await s.router.payerBalance(o.address), "nothing was deposited").to.equal(before);
      return r;
    };

    it("needs its own approval, a network, a facilitator and a router, and stops above the QUSDC cap", async () => {
      expect((await quiet(["start", "--amount", "5"], e({ SLUICE_APPROVE: "smoke" }))).text).to.match(/refusing to run owner-setup/);
      expect((await quiet(["start", "--amount", "5"], e({ SLUICE_APPROVE: undefined }))).text).to.match(/SLUICE_APPROVE/);
      expect((await quiet(["start", "--amount", "5"], e({ SLUICE_NETWORK: undefined }))).text).to.match(/SLUICE_NETWORK/);
      expect((await quiet(["start", "--amount", "5"], e({ SLUICE_FACILITATOR_URL: undefined }))).text).to.match(/SLUICE_FACILITATOR_URL/);
      expect((await quiet(["start", "--amount", "5"], e({ SLUICE_FACILITATOR_URL: "http://facilitator.example" }))).text).to.match(/must be https/);
      expect((await quiet(["start", "--amount", "5"], e({ SLUICE_ROUTER: "0x12" }))).text).to.match(/SLUICE_ROUTER/);
      expect((await quiet(["start", "--amount", "11"])).text).to.match(/above the cap of 10\.000000/);
      expect((await quiet(["start", "--amount", "0"])).text).to.match(/above zero/);
      expect((await quiet(["start"])).text).to.match(/needs --amount/);
    });

    it("refuses a facilitator that is not on this network and router, and a wallet without the QUSDC", async () => {
      const [, other] = [0, await startStack({ feeBps: 100 })];
      try {
        const wrongRouter = await quiet(["start", "--amount", "5"], e({ SLUICE_FACILITATOR_URL: other.facilitatorUrl }));
        expect(wrongRouter.code).to.equal(1);
        expect(wrongRouter.text).to.match(/facilitator is not on this network and this router/);
      } finally {
        await other.stop();
      }
      const poor = throwawayWallet();
      const r = await run(["start", "--amount", "5"], e({ SLUICE_KEY: poor.privateKey }));
      expect(r.code).to.equal(1);
      expect(r.text).to.match(/holds 0\.000000 QUSDC, less than the 5\.000000/);
    });

    it("lets a wallet start once a day, and says why the facilitator refused a second start", async () => {
      expect((await run(["start", "--amount", "1"], e())).code).to.equal(0);
      const second = await run(["start", "--amount", "1"], e());
      expect(second.code).to.equal(1);
      expect(second.text).to.match(/the facilitator did not start the wallet: sluice_onboard_refused .*(used today|nonce)/);
    });

    it("refuses an agent that is the owner's own key, and a wrong command, before it signs anything", async () => {
      const bad = async (argv: string[], why: RegExp, code: number) => {
        const r = await run(argv, e());
        expect(r.code).to.equal(code);
        expect(r.text).to.match(why);
      };
      await bad(["authorize", "--agent", o.address, "--budget", "1", "--per-call", "0.1", "--tool", `x=${builderAddress()}`], /must not be the owner's own/, 1);
      await bad(["authorize", "--agent", throwawayWallet().address, "--budget", "0.1", "--per-call", "0.5", "--tool", `x=${builderAddress()}`], /--per-call is above --budget/, 2);
      await bad(["authorize", "--agent", throwawayWallet().address, "--budget", "1", "--per-call", "0.1"], /give from 1 to 32 --tool/, 2);
      await bad(["authorize", "--agent", throwawayWallet().address, "--budget", "1", "--per-call", "0.1", "--tool", "nope"], /--tool is name=0xPayee/, 2);
      await bad(["authorize", "--agent", throwawayWallet().address, "--budget", "1", "--per-call", "0.1", "--tool", "x=zzz"], /payee is not an address/, 2);
      await bad(["authorize", "--agent", "nope", "--budget", "1", "--per-call", "0.1", "--tool", `x=${builderAddress()}`], /--agent is not an address/, 2);
      await bad(["authorize", "--agent", throwawayWallet().address, "--budget", "1", "--per-call", "0.1", "--days", "0", "--tool", `x=${builderAddress()}`], /--days must be/, 2);
      await bad(["authorize"], /needs --agent/, 2);
      await bad(["bogus"], /the command is start or authorize/, 2);
      await bad(["start", "--amount", "1", "--bogus", "x"], /unknown option/, 2);
      expect(getAddress(builderAddress())).to.match(/^0x/);
    });

    function builderAddress(): string {
      return builder.address;
    }
  });

  it("leaves no scratch folder behind", () => {
    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).to.equal(false);
  });
});
