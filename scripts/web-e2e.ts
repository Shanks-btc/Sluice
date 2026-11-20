// pnpm web:e2e: the web app in a real browser. Run after `pnpm web:build`.
//
// It starts a local chain with the real contracts and a facilitator (nothing leaves this machine), serves the built app twice with `next
// start` (once with nothing configured, once pointed at that chain), and drives it in the system's Edge through playwright-core. The wallet
// is a mock that signs with throwaway keys and sends to the local chain. It checks every page, the empty states, the simulated demo, the
// theme, the headers, and the wallet flows (wrong network, a rejected request, a wallet with no QIE, cancel, confirm).
//
// It runs under `hardhat run` so the chain helpers are available. Exit code 1 if any check fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseEther } from "ethers";
import { USDC, signedIntent } from "../test/helpers";
import { MockWallet } from "../test/helpers/mock-wallet";
import type { MockOptions } from "../test/helpers/mock-wallet";
import { fundWallet, freshChain, startStack } from "../test/helpers/stack";
import type { Stack } from "../test/helpers/stack";
import { DOC_SOURCES } from "../apps/web/src/lib/content-types";
import { IDEA } from "../apps/web/src/content/copy";

const root = join(__dirname, "..");
const webDir = join(root, "apps", "web");
const { chromium } = createRequire(join(webDir, "package.json"))("playwright-core") as typeof import("playwright-core");
type Page = import("playwright-core").Page;
type BrowserContext = import("playwright-core").BrowserContext;

const PORT_EMPTY = 3210;
const PORT_LIVE = 3211;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stderr.write(`  ok   ${name}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: message });
    process.stderr.write(`  FAIL ${name}\n       ${message.split("\n").slice(0, 4).join("\n       ")}\n`);
  }
}

function startNext(port: number, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [join(webDir, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], {
    cwd: webDir,
    env: { ...process.env, ...env, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", () => undefined);
  return child;
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** A browser context whose window.ethereum is a mock wallet running in this process. */
async function walletContext(browser: import("playwright-core").Browser, stack: Stack, options: MockOptions, qusdc: bigint, qie: bigint, opts: { viewport?: { width: number; height: number }; colorScheme?: "light" | "dark"; reducedMotion?: "reduce" | "no-preference" } = {}) {
  const mock = new MockWallet(stack.provider, options);
  await fundWallet(stack, mock.wallet, qusdc, qie);
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 }, colorScheme: opts.colorScheme ?? "light", reducedMotion: opts.reducedMotion ?? "no-preference" });
  await context.exposeFunction("__sluiceWallet", async (args: { method: string; params?: unknown }) => {
    try {
      return { result: await mock.request(args as never) };
    } catch (err) {
      const e = err as { code?: number; message?: string };
      return { error: { code: e.code ?? -32603, message: e.message ?? "failed" } };
    }
  });
  await context.addInitScript(() => {
    const w = window as unknown as { ethereum?: unknown; __sluiceWallet: (a: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }> };
    w.ethereum = {
      request: async (args: unknown) => {
        const answer = await w.__sluiceWallet(args);
        if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
        return answer.result;
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
  });
  return { mock, context };
}

type Problems = string[];
async function open(context: BrowserContext, url: string, problems: Problems = []): Promise<Page> {
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console ${m.type()}: ${m.text().slice(0, 160)}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${String(e).slice(0, 160)}`));
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url().slice(0, 100)}`));
  const response = await page.goto(url, { waitUntil: "networkidle" });
  (page as unknown as { __status: number }).__status = response?.status() ?? 0;
  return page;
}

const text = (page: Page, testId: string) => page.getByTestId(testId).innerText();
const visible = (page: Page, testId: string, timeout = 15_000) => page.getByTestId(testId).waitFor({ state: "visible", timeout });
/** Waits for a flow to finish. If it failed, the failure's own words are the error, so a broken flow says why. */
async function flowDone(page: Page, timeout = 30_000): Promise<void> {
  const done = page.getByTestId("flow-done");
  const failed = page.getByTestId("flow-failed");
  await Promise.race([done.waitFor({ state: "visible", timeout }), failed.waitFor({ state: "visible", timeout })]);
  if (await failed.isVisible()) throw new Error(`the flow failed: ${(await failed.innerText()).replace(/s+/g, " ")}`);
}

async function waitText(page: Page, testId: string, pattern: RegExp, timeout = 15_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.getByTestId(testId).innerText().catch(() => "");
    if (pattern.test(last)) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`${testId} never matched ${pattern}; last text: ${last.slice(0, 200)}`);
}

async function main(): Promise<void> {
  await freshChain();
  const stack = await startStack({ feeBps: 100, corsOrigins: [`http://127.0.0.1:${PORT_EMPTY}`, `http://127.0.0.1:${PORT_LIVE}`] });
  const base = (port: number) => `http://127.0.0.1:${port}`;
  const empty = startNext(PORT_EMPTY, { SLUICE_RPC_URL: stack.rpcUrl, SLUICE_EXPLORER_URL: "http://127.0.0.1:9" });
  const live = startNext(PORT_LIVE, {
    NEXT_PUBLIC_ROUTER_ADDRESS: stack.routerAddress,
    NEXT_PUBLIC_VAULT_ADDRESS: stack.vaultAddress,
    NEXT_PUBLIC_CHAIN_ID: "1990",
    NEXT_PUBLIC_RPC_URL: stack.rpcUrl,
    NEXT_PUBLIC_FACILITATOR_URL: stack.facilitatorUrl,
    NEXT_PUBLIC_FROM_BLOCK: "0",
    SLUICE_RPC_URL: stack.rpcUrl,
    SLUICE_EXPLORER_URL: "http://127.0.0.1:9",
    SLUICE_FROM_BLOCK: "0",
  });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    await Promise.all([waitFor(base(PORT_EMPTY)), waitFor(base(PORT_LIVE))]);
    process.stderr.write("\nweb e2e: the app is up on two ports, the chain is local\n\n");

    // ================================================================= nothing configured
    process.stderr.write("nothing configured\n");
    const plain = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const A = base(PORT_EMPTY);

    const slugs = DOC_SOURCES.map((d) => `/docs/${d.slug}`);
    for (const path of ["/", "/demo", "/builder", "/wallet", "/docs", "/evidence", ...slugs]) {
      for (const [label, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
        await check(`${path} renders at ${label} size with no console error, no failed request and no sideways scroll`, async () => {
          const context = await browser.newContext({ viewport: size });
          const problems: Problems = [];
          const page = await open(context, A + path, problems);
          assert.equal((page as unknown as { __status: number }).__status, 200);
          assert.ok((await page.locator("h1").count()) >= 1, "has a heading");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(overflow, 0, "page scrolls sideways");
          assert.deepEqual(problems, []);
          await context.close();
        });
      }
    }

    await check("an unknown page is a 404 in the site's own design, with a way back", async () => {
      const problems: Problems = [];
      const page = await open(plain, `${A}/no-such-page`, problems);
      assert.equal((page as unknown as { __status: number }).__status, 404);
      await visible(page, "not-found");
      assert.match(await text(page, "not-found"), /That page is not here/);
      assert.ok(await page.getByRole("link", { name: "Back to the start" }).isVisible());
      await page.close();
    });

    await check("an unknown document is a 404 too", async () => {
      const page = await open(plain, `${A}/docs/nothing-here`);
      assert.equal((page as unknown as { __status: number }).__status, 404);
      await page.close();
    });

    await check("the landing page carries the idea, word for word", async () => {
      const page = await open(plain, A);
      assert.equal((await text(page, "idea")).replace(/\s+/g, " ").trim(), IDEA);
      await page.close();
    });

    await check("the landing page shows no mainnet transactions, says so, and labels the fork sample as not mainnet", async () => {
      const page = await open(plain, A);
      assert.match(await text(page, "proof-empty"), /No mainnet transactions recorded yet/);
      assert.match(await text(page, "fork-sample"), /Sample from a local fork — not mainnet/);
      assert.equal(await page.locator('a[href*="mainnet.qie.digital/tx"]').count(), 0);
      assert.match(await text(page, "hero-status"), /mainnet transactions in the evidence file: 0/);
      await page.close();
    });

    await check("no status badge says Live, and every badge is one of the README's words", async () => {
      const page = await open(plain, A);
      const statuses = await page.locator("[data-status]").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
      assert.ok(statuses.length >= 4);
      for (const s of statuses) assert.ok(["Tested on a fork", "Coming soon"].includes(String(s)), `badge says ${s}`);
      assert.equal((await page.content()).includes('data-status="Live"'), false);
      await page.close();
    });

    await check("the landing page has the differs table, the risks box with the QUSDC finding, and says the scheme is not an official x402 one", async () => {
      const page = await open(plain, A);
      assert.equal(await page.locator('[data-testid="differs-table"] tbody tr').count(), 8);
      const risks = await text(page, "risks-box");
      assert.match(risks, /QUSDC's admin can burn any holder's balance/);
      assert.match(risks, /0xdC20F1fee9e03184ddabcCe96F01E3c570E43D45/);
      assert.match(await page.locator("body").innerText(), /not an official x402 scheme/);
      await page.close();
    });

    await check("builder and wallet pages say 'Contracts not configured' instead of failing", async () => {
      for (const path of ["/builder", "/wallet"]) {
        const page = await open(plain, A + path);
        await visible(page, "not-configured");
        assert.match(await text(page, "not-configured"), /Contracts not configured/);
        await page.close();
      }
    });

    await check("the builder page shows the SDK snippet", async () => {
      const page = await open(plain, `${A}/builder`);
      const code = await text(page, "wrap-snippet");
      assert.match(code, /createPaywall/);
      assert.match(code, /registerPaidTool/);
      await page.close();
    });

    await check("the evidence page shows empty tables and says no router is configured, never zero", async () => {
      const page = await open(plain, `${A}/evidence`);
      await visible(page, "evidence-mainnet-empty");
      await visible(page, "evidence-testnet-empty");
      assert.match(await text(page, "summary-empty"), /No router is configured/);
      assert.equal(await page.getByTestId("paid-calls").count(), 0);
      assert.match(await page.locator("body").innerText(), /pnpm evidence:check/);
      await page.close();
    });

    await check("the docs render from the repository, with a sidebar and anchors", async () => {
      const page = await open(plain, `${A}/docs/spec`);
      assert.match(await page.locator("h1").first().innerText(), /Sluice payment scheme/);
      assert.ok((await page.locator(".docs-nav a").count()) >= 10);
      assert.ok((await page.locator(".docs-toc a").count()) >= 8);
      const href = await page.locator(".docs-toc a").first().getAttribute("href");
      assert.ok(href?.startsWith("#"));
      await page.close();
    });

    await check("the connect-a-client page is labelled 'documented, not yet tested with real clients'", async () => {
      const page = await open(plain, `${A}/docs/connect-a-client`);
      assert.match(await page.locator("body").innerText(), /Documented, not yet tested with real clients/);
      await page.close();
    });

    await check("the demo simulation runs to completion and keeps its banner on screen", async () => {
      const page = await open(plain, `${A}/demo`);
      assert.match(await text(page, "sim-banner"), /Simulated — no real funds, no chain/);
      await page.getByTestId("sim-run").click();
      await visible(page, "sim-done", 30_000);
      assert.match(await text(page, "sim-progress"), /Step 7 of 7/);
      assert.ok(await page.getByTestId("sim-step-settle").isVisible());
      assert.ok(await page.getByTestId("sim-banner").isVisible());
      assert.match(await text(page, "sim-checks"), /Signature/);
      await page.close();
    });

    await check("with reduced motion the walkthrough advances one step per press and never by itself", async () => {
      const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
      const page = await open(context, `${A}/demo`);
      await page.getByTestId("sim-run").click();
      await page.waitForTimeout(2500);
      assert.match(await text(page, "sim-progress"), /Step 1 of 7/);
      await page.getByTestId("sim-run").click();
      assert.match(await text(page, "sim-progress"), /Step 2 of 7/);
      await context.close();
    });

    await check("the demo's refusal examples show the spec's code, and 'show every step' and reset work", async () => {
      const page = await open(plain, `${A}/demo`);
      await page.selectOption("#refusal", { label: "the client edited the price in its copy of the terms" });
      assert.match(await text(page, "refusal-result"), /sluice_accepted_mismatch/);
      await page.getByTestId("sim-all").click();
      assert.match(await text(page, "sim-progress"), /Step 7 of 7/);
      await page.getByTestId("sim-reset").click();
      assert.match(await text(page, "sim-progress"), /Not started/);
      await page.close();
    });

    await check("the facilitator panel starts on the local network, never on mainnet, and names real funds when mainnet is chosen", async () => {
      const page = await open(plain, `${A}/demo`);
      assert.equal(await page.getByTestId("target-local").getAttribute("aria-checked"), "true");
      assert.equal(await page.getByTestId("target-mainnet").getAttribute("aria-checked"), "false");
      assert.match(await text(page, "target-note"), /no real funds/i);
      await page.getByTestId("target-mainnet").click();
      assert.match(await text(page, "target-note"), /real funds/i);
      assert.equal(await page.inputValue("#fac-url"), "");
      await page.close();
    });

    await check("the facilitator panel reads /health from a local facilitator and refuses a bad address", async () => {
      const page = await open(plain, `${A}/demo`);
      await page.fill("#fac-url", "ftp://nope");
      assert.equal(await page.getByTestId("fac-health").isDisabled(), true);
      await page.fill("#fac-url", stack.facilitatorUrl);
      await page.getByTestId("fac-health").click();
      await visible(page, "fac-result");
      const result = await text(page, "fac-result");
      assert.match(result, new RegExp(stack.routerAddress, "i"));
      assert.match(result, /Chain\s+1990/);
      await page.close();
    });

    await check("the risk panel refuses a bad address without asking the server, and reports a server refusal in words", async () => {
      const page = await open(plain, `${A}/demo`);
      await page.fill("#risk-address", "0x123");
      await page.getByTestId("risk-run").click();
      assert.match(await text(page, "risk-error"), /not a token address/);
      await page.close();
    });

    await check("the risk route validates its input and answers only POST", async () => {
      const post = (body: string, type = "application/json") => fetch(`${A}/api/risk`, { method: "POST", headers: { "content-type": type }, body });
      assert.equal((await post('{"address":"nope"}')).status, 400);
      assert.equal((await post("{")).status, 400);
      assert.equal((await post("{}", "text/plain")).status, 415);
      assert.equal((await post(JSON.stringify({ address: stack.tokenAddress, pad: "x".repeat(1000) }))).status, 413);
      const get = await fetch(`${A}/api/risk`);
      assert.equal(get.status, 405);
      const ok = await post(JSON.stringify({ address: stack.tokenAddress }));
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { ok: boolean; result: { limits: string[] } };
      assert.equal(body.ok, true);
      assert.ok(body.result.limits.length > 0);
    });

    await check("the theme toggle switches to dark, remembers the choice across a reload, and switches back", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
      const page = await open(context, A);
      assert.equal(await page.locator("html").getAttribute("data-theme"), null);
      const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.getByTestId("theme-toggle").click();
      assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
      assert.equal(await page.evaluate(() => window.localStorage.getItem("sluice-theme")), "dark");
      const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.notEqual(lightBg, darkBg);
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), darkBg);
      await page.getByTestId("theme-toggle").click();
      assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
      await context.close();
    });

    await check("with no saved choice the system's dark setting is followed", async () => {
      const context = await browser.newContext({ colorScheme: "dark" });
      const page = await open(context, A);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, "rgb(8, 19, 25)");
      assert.equal(await page.getByTestId("theme-toggle").getAttribute("data-theme-showing"), "dark");
      await context.close();
    });

    await check("the security headers and a strict CSP are set, scripts carry the request's nonce, and no element has a style attribute", async () => {
      const res = await fetch(`${A}/demo`);
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce, "the CSP has a nonce");
      assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/);
      assert.equal(res.headers.get("x-powered-by"), null);
      const html = await res.text();
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${nonce}"`) || /src="\/theme-init\.js"/.test(tag), `a script without the nonce: ${tag.slice(0, 80)}`);
      const second = (await fetch(`${A}/demo`)).headers.get("content-security-policy");
      assert.notEqual(second, csp, "a new nonce for each request");
      const page = await open(plain, `${A}/demo`);
      const styled = await page.evaluate(() => [...document.querySelectorAll("[style]")].filter((el) => el.tagName !== "NEXT-ROUTE-ANNOUNCER").map((el) => el.outerHTML.slice(0, 120))); // Next's own announcer sets one through the CSSOM
      assert.deepEqual(styled, []); // Next's own announcer sets one through the CSSOM
      await page.close();
    });

    await check("every page can be used from the keyboard: the skip link comes first and focus is visible", async () => {
      const page = await open(plain, A);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to the content");
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
      assert.notEqual(outline, "none");
      await page.close();
    });

    await check("tap targets in the navigation, the buttons and the footer are at least 44px", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      for (const path of ["/", "/demo", "/builder"]) {
        const page = await open(context, A + path);
        const small = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll("a, button, summary, select, input:not([type=checkbox])")) {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const inText = el.closest("p, li, .prose") && el.tagName === "A" && !el.closest("nav, footer, .btn");
            if (inText) continue;
            if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName} ${(el.textContent ?? "").trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return out;
        });
        assert.deepEqual(small, [], `${path} has small tap targets`);
        await page.close();
      }
      await context.close();
    });
    await plain.close();

    // ===================================================================== a local chain
    process.stderr.write("\nconfigured for the local chain\n");
    const L = base(PORT_LIVE);

    async function earnFor(builder: string, amount: bigint) {
      await stack.mint(stack.payer.address, amount);
      await stack.token.connect(stack.payer).approve(stack.routerAddress, amount);
      await stack.router.connect(stack.payer).deposit(amount);
      const { intent, signature } = await signedIntent(stack, stack.payer, stack.payer.address, builder, amount);
      await stack.router.connect(stack.stranger).settle(intent, signature);
    }

    await check("the network is named as local with no real funds", async () => {
      const { context } = await walletContext(browser, stack, {}, 0n, parseEther("1"));
      const page = await open(context, `${L}/builder`);
      assert.match(await text(page, "network-badge"), /Local node or fork · chain 1990 · no real funds/i);
      await context.close();
    });

    await check("builder: connects, reads earnings and settlements from the router, and shows the fee in effect", async () => {
      const problems: Problems = [];
      const { mock, context } = await walletContext(browser, stack, {}, 0n, parseEther("1"));
      await earnFor(mock.address, USDC("2"));
      const page = await open(context, `${L}/builder`, problems);
      await page.getByTestId("connect").click();
      await visible(page, "account");
      await visible(page, "builder-stats");
      assert.match(await text(page, "earnings"), /1\.980000/);
      assert.match(await text(page, "fee"), /1\.00%/);
      assert.equal(await page.locator('[data-testid="settlements"] tbody tr').count(), 1);
      assert.deepEqual(problems, []);
      await context.close();
    });

    await check("builder: a wallet on the wrong network is told so, switching adds the network, and then the page works", async () => {
      const { context } = await walletContext(browser, stack, { chainId: 1, knownChains: [1] }, 0n, parseEther("1"));
      const page = await open(context, `${L}/builder`);
      await page.getByTestId("connect").click();
      await visible(page, "wrong-network");
      assert.match(await text(page, "wrong-network"), /Wrong network/);
      assert.equal(await page.getByTestId("withdraw-review").count() === 0 || await page.getByTestId("withdraw-review").isDisabled(), true);
      await page.getByTestId("switch-network").click();
      await page.getByTestId("wrong-network").waitFor({ state: "detached", timeout: 10_000 });
      await context.close();
    });

    await check("builder: a connection the person rejects shows a message and stays disconnected", async () => {
      const { context } = await walletContext(browser, stack, { rejectConnect: true }, 0n, parseEther("1"));
      const page = await open(context, `${L}/builder`);
      await page.getByTestId("connect").click();
      assert.match(await text(page, "wallet-error"), /You rejected the request/);
      assert.equal(await page.getByTestId("account").count(), 0);
      await context.close();
    });

    await check("builder: withdraw shows amount, recipient and gas, sends nothing on cancel, and sends only after Confirm", async () => {
      const { mock, context } = await walletContext(browser, stack, {}, 0n, parseEther("1"));
      await earnFor(mock.address, USDC("3"));
      const page = await open(context, `${L}/builder`);
      await page.getByTestId("connect").click();
      await visible(page, "builder-stats");
      await page.fill("#withdraw-amount", "1.5");
      await page.getByTestId("withdraw-review").click();
      await visible(page, "flow-dialog");
      const fields = await text(page, "flow-fields");
      assert.match(fields, /Amount\s+1\.500000 QUSDC/);
      assert.match(fields, new RegExp(`Recipient\\s+${mock.address}`, "i"));
      assert.match(fields, /Network fee\s+about [\d.]+ QIE/);
      assert.equal(mock.count("eth_sendTransaction"), 0, "nothing is sent while the review is open");
      await page.getByTestId("flow-cancel").click();
      await page.getByTestId("flow-dialog").waitFor({ state: "hidden" });
      assert.equal(mock.count("eth_sendTransaction"), 0, "nothing is sent after cancel");
      assert.equal(await stack.router.earnings(mock.address), USDC("2.97"));

      await page.getByTestId("withdraw-review").click();
      await visible(page, "flow-dialog");
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      assert.equal(mock.count("eth_sendTransaction"), 1);
      assert.equal(await stack.router.earnings(mock.address), USDC("1.47"));
      assert.equal(await stack.token.balanceOf(mock.address), USDC("1.5"));
      await context.close();
    });

    await check("builder: a withdrawal rejected in the wallet shows why, and nothing moves", async () => {
      const { mock, context } = await walletContext(browser, stack, { rejectSend: true }, 0n, parseEther("1"));
      await earnFor(mock.address, USDC("1"));
      const page = await open(context, `${L}/builder`);
      await page.getByTestId("connect").click();
      await visible(page, "builder-stats");
      await page.fill("#withdraw-amount", "0.5");
      await page.getByTestId("withdraw-review").click();
      await page.getByTestId("flow-confirm").click();
      await visible(page, "flow-failed");
      assert.match(await text(page, "flow-failed"), /You rejected the request in your wallet/);
      assert.equal(await stack.router.earnings(mock.address), USDC("0.99"));
      await context.close();
    });

    await check("builder: an amount above the earnings is refused in words before any review opens", async () => {
      const { mock, context } = await walletContext(browser, stack, {}, 0n, parseEther("1"));
      await earnFor(mock.address, USDC("1"));
      const page = await open(context, `${L}/builder`);
      await page.getByTestId("connect").click();
      await visible(page, "builder-stats");
      await page.fill("#withdraw-amount", "50");
      await page.getByTestId("withdraw-review").click();
      assert.match(await text(page, "withdraw-error"), /more than the 0\.990000 available/);
      assert.equal(await page.getByTestId("flow-dialog").isVisible(), false);
      await context.close();
    });

    await check("builder: looking up an address needs no wallet", async () => {
      const context = await browser.newContext();
      const page = await open(context, `${L}/builder`);
      const target = (await stack.router.getAddress(), stack.feeRecipient.address);
      await page.fill("#builder-address", target);
      await visible(page, "builder-stats");
      assert.match(await text(page, "fee"), /1\.00%/);
      assert.equal(await page.getByTestId("withdraw-review").isDisabled(), true);
      await context.close();
    });

    await check("wallet: balances are read from the chain once connected", async () => {
      const { context } = await walletContext(browser, stack, {}, USDC("20"), parseEther("1"));
      const page = await open(context, `${L}/wallet`);
      await visible(page, "connect-prompt");
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      assert.match(await text(page, "wallet-qusdc"), /20\.000000/);
      assert.match(await text(page, "prepaid"), /0\.000000/);
      await context.close();
    });

    await check("wallet: deposit with QIE shows the approval and the fee, cancel sends nothing, confirm approves exactly the amount and deposits", async () => {
      const { mock, context } = await walletContext(browser, stack, {}, USDC("20"), parseEther("1"));
      const page = await open(context, `${L}/wallet`);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      await page.fill("#deposit-amount", "5");
      await page.getByTestId("deposit-review").click();
      await visible(page, "flow-dialog");
      const fields = await text(page, "flow-fields");
      assert.match(fields, /Approve the router to move exactly 5\.000000 QUSDC/);
      assert.match(fields, /Network fee\s+up to/);
      await page.getByTestId("flow-cancel").click();
      assert.equal(mock.count("eth_sendTransaction"), 0);
      await page.getByTestId("deposit-review").click();
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      assert.equal(mock.count("eth_sendTransaction"), 2);
      assert.equal(await stack.router.payerBalance(mock.address), USDC("5"));
      assert.equal(await stack.token.allowance(mock.address, stack.routerAddress), 0n);
      await page.getByTestId("flow-close").click();
      await waitText(page, "prepaid", /5\.000000/);
      await context.close();
    });

    await check("wallet: a payer with no QIE is shown the facilitator route and deposits by signing, and no transaction leaves the wallet", async () => {
      const { mock, context } = await walletContext(browser, stack, {}, USDC("20"), 0n);
      const problems: Problems = [];
      const page = await open(context, `${L}/wallet`, problems);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      assert.match(await text(page, "qie"), /0\.0000/);
      await page.fill("#deposit-amount", "4");
      await page.getByTestId("deposit-review").click();
      await visible(page, "flow-dialog");
      const dialog = await text(page, "flow-dialog");
      assert.match(dialog, /Deposit QUSDC with no QIE/);
      assert.match(dialog, /Gas top-up/);
      assert.match(dialog, /sign two transactions without sending them/);
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      assert.equal(mock.count("eth_sendTransaction"), 0);
      assert.equal(mock.count("eth_signTransaction"), 2);
      assert.equal(await stack.router.payerBalance(mock.address), USDC("4"));
      await context.close();
    });

    await check("wallet: a wallet that cannot sign without sending is told so and nothing is sent", async () => {
      const { mock, context } = await walletContext(browser, stack, { noSignTransaction: true }, USDC("20"), 0n);
      const page = await open(context, `${L}/wallet`);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      await page.fill("#deposit-amount", "4");
      await page.getByTestId("deposit-review").click();
      await page.getByTestId("flow-confirm").click();
      await visible(page, "flow-failed");
      assert.match(await text(page, "flow-failed"), /cannot sign a transaction without sending it/);
      assert.equal(await stack.router.payerBalance(mock.address), 0n);
      await context.close();
    });

    await check("wallet: a rejected signature in the zero-QIE route sends nothing to the facilitator", async () => {
      const { mock, context } = await walletContext(browser, stack, { rejectSign: true }, USDC("20"), 0n);
      const page = await open(context, `${L}/wallet`);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      await page.fill("#deposit-amount", "4");
      await page.getByTestId("deposit-review").click();
      await page.getByTestId("flow-confirm").click();
      await visible(page, "flow-failed");
      assert.match(await text(page, "flow-failed"), /You rejected the request/);
      assert.equal(await stack.router.payerBalance(mock.address), 0n);
      await context.close();
    });

    await check("wallet: authorise an agent key with limits, see it in the table with its limits, then revoke it", async () => {
      const { mock, context } = await walletContext(browser, stack, {}, USDC("5"), parseEther("1"));
      const page = await open(context, `${L}/wallet`);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      const agent = (await import("../test/helpers/stack")).throwawayWallet().address;
      const payee = stack.builder.address;
      await page.fill("#agent-address", agent);
      await page.fill("#agent-budget", "2");
      await page.fill("#agent-cap", "0.25");
      await page.fill("#agent-days", "7");
      await page.fill("#tool-payee-0", payee);
      await page.fill("#tool-name-0", "token_risk_check");
      await page.getByTestId("authorize-review").click();
      await visible(page, "flow-dialog");
      const fields = await text(page, "flow-fields");
      assert.match(fields, new RegExp(`Agent key\\s+${agent}`, "i"));
      assert.match(fields, /Budget\s+2\.000000 QUSDC/);
      assert.match(fields, /Cap per call\s+0\.250000 QUSDC/);
      assert.match(fields, /Expires\s+\d{4}-\d{2}-\d{2}/);
      assert.match(fields, /token_risk_check from/);
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      await page.getByTestId("flow-close").click();
      await visible(page, "sessions");
      const row = await page.locator('[data-testid="sessions"] tbody tr').first().innerText();
      assert.match(row, /active/i);
      assert.match(row, /2\.000000/);
      assert.match(row, /0\.250000/);
      assert.equal((await stack.vault.sessionOf(mock.address, agent)).budget, USDC("2"));
      await page.getByTestId(`revoke-${agent.replace(/^0x/, "0x")}`).click();
      await visible(page, "flow-dialog");
      assert.match(await text(page, "flow-fields"), /Revoke an agent key/);
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      await page.getByTestId("flow-close").click();
      await visible(page, "no-sessions");
      assert.equal((await stack.vault.sessionOf(mock.address, agent)).id, 0n);
      await context.close();
    });

    await check("wallet: authorising with bad limits is refused in words, and no review opens", async () => {
      const { context } = await walletContext(browser, stack, {}, USDC("5"), parseEther("1"));
      const page = await open(context, `${L}/wallet`);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      await page.fill("#agent-address", stack.builder.address);
      await page.fill("#agent-budget", "1");
      await page.fill("#agent-cap", "2");
      await page.fill("#tool-payee-0", stack.feeRecipient.address);
      await page.fill("#tool-name-0", "x");
      await page.getByTestId("authorize-review").click();
      assert.match(await text(page, "authorize-error"), /cannot be more than the budget/);
      assert.equal(await page.getByTestId("flow-dialog").isVisible(), false);
      await context.close();
    });

    await check("wallet: the page has no field for a private key or a seed phrase", async () => {
      const { context } = await walletContext(browser, stack, {}, USDC("5"), parseEther("1"));
      const page = await open(context, `${L}/wallet`);
      await page.getByTestId("connect").click();
      await visible(page, "payer-stats");
      const labels = (await page.locator("label, input, textarea").evaluateAll((els) => els.map((e) => `${e.textContent ?? ""} ${e.getAttribute("placeholder") ?? ""} ${e.getAttribute("name") ?? ""} ${e.getAttribute("type") ?? ""}`))).join(" ");
      assert.doesNotMatch(labels, /private key|seed|mnemonic|recovery phrase|password/i);
      assert.equal(await page.locator("textarea, input[type=password]").count(), 0);
      await context.close();
    });

    await check("the risk panel reports a token on the local chain from the server route", async () => {
      const context = await browser.newContext();
      const page = await open(context, `${L}/demo`);
      await page.fill("#risk-address", stack.tokenAddress);
      await page.getByTestId("risk-run").click();
      await visible(page, "risk-result", 30_000);
      assert.match(await text(page, "risk-result"), /What this check cannot see/);
      await context.close();
    });

    await check("the evidence page counts Settled events from the router, and leaves out nothing it was not told to", async () => {
      const page = await open(await browser.newContext(), `${L}/evidence`);
      await visible(page, "evidence-summary");
      const calls = Number(await text(page, "paid-calls"));
      assert.ok(calls >= 3, `paid calls counted: ${calls}`);
      assert.ok(Number(await text(page, "distinct-payers")) >= 1);
      assert.ok(Number(await text(page, "distinct-builders")) >= 1);
      await page.close();
    });

    const failed = results.filter((r) => !r.ok);
    process.stderr.write(`\nweb e2e: ${results.length - failed.length} passed, ${failed.length} failed\n`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => undefined);
    stop(empty);
    stop(live);
    await stack.stop().catch(() => undefined);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    process.stderr.write(`web e2e: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
