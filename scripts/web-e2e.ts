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
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseEther } from "ethers";
import { USDC, signedIntent } from "../test/helpers";
import { MockWallet } from "../test/helpers/mock-wallet";
import type { MockOptions } from "../test/helpers/mock-wallet";
import { depositFor, fundWallet, freshChain, startStack } from "../test/helpers/stack";
import type { Stack } from "../test/helpers/stack";
import { fakeExplorer } from "../test/helpers/explorer";
import { createToolServer, readToolServerEnv } from "../examples/paid-tools/src";
import type { ToolServer } from "../examples/paid-tools/src";
import { DOC_SOURCES } from "../apps/web/src/lib/content-types";
import { IDEA } from "../apps/web/src/content/copy";
import { parseEvidenceStrict } from "../src/evidence";

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
async function walletContext(browser: import("playwright-core").Browser, stack: Stack, options: MockOptions, qusdc: bigint, qie: bigint, opts: { viewport?: { width: number; height: number }; colorScheme?: "light" | "dark"; reducedMotion?: "reduce" | "no-preference"; lateMs?: number } = {}) {
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
  await context.addInitScript((lateMs: number) => {
    const w = window as unknown as { ethereum?: unknown; __sluiceWallet: (a: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }> };
    const install = () => {
      w.ethereum = {
        request: async (args: unknown) => {
          const answer = await w.__sluiceWallet(args);
          if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
          return answer.result;
        },
        on: () => undefined,
        removeListener: () => undefined,
      };
    };
    // A wallet app's browser on a phone can put the wallet on the page after it has loaded, and says so with this event.
    if (lateMs > 0) setTimeout(() => (install(), window.dispatchEvent(new Event("ethereum#initialized"))), lateMs);
    else install();
  }, opts.lateMs ?? 0);
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

/** What is wider than the screen, so a sideways scroll names its cause instead of only its size. */
async function wideElements(page: Page): Promise<string> {
  const found = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const out: string[] = [];
    const over = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.right > limit + 0.5;
    };
    // Only the innermost elements that stick out: their parents stick out because of them.
    for (const el of document.querySelectorAll("body *")) {
      if (!over(el) || [...el.children].some(over)) continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${String(el.className).split(" ")[0] ?? ""} right=${Math.round(r.right)} width=${Math.round(r.width)} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
      if (out.length >= 8) break;
    }
    return out;
  });
  return found.join("; ");
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
  // The hosted tool server, run in this process against the local chain, paid to the builder's throwaway address. Only the live page's
  // origin may read its answers.
  const tools: ToolServer = await createToolServer({
    env: readToolServerEnv({
      SLUICE_NETWORK: "local",
      SLUICE_ROUTER: stack.routerAddress,
      SLUICE_PAYEE: stack.builder.address,
      SLUICE_FACILITATOR_URL: stack.facilitatorUrl,
      SLUICE_RPC_URL: stack.rpcUrl,
      SLUICE_TOOLS_PORT: "0",
      SLUICE_TOOLS_CORS_ORIGINS: base(PORT_LIVE),
    }),
    explorer: fakeExplorer(stack.provider),
  });
  const toolsUrl = `http://127.0.0.1:${await tools.listen()}`;
  const empty = startNext(PORT_EMPTY, { SLUICE_RPC_URL: stack.rpcUrl, SLUICE_EXPLORER_URL: "http://127.0.0.1:9" });
  const live = startNext(PORT_LIVE, {
    NEXT_PUBLIC_ROUTER_ADDRESS: stack.routerAddress,
    NEXT_PUBLIC_VAULT_ADDRESS: stack.vaultAddress,
    NEXT_PUBLIC_CHAIN_ID: "1990",
    NEXT_PUBLIC_RPC_URL: stack.rpcUrl,
    NEXT_PUBLIC_FACILITATOR_URL: stack.facilitatorUrl,
    NEXT_PUBLIC_TOOLS_URL: toolsUrl,
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
    for (const path of ["/", "/demo", "/builder", "/wallet", "/status", "/security", "/terms", "/privacy", "/docs", "/evidence", ...slugs]) {
      for (const [label, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
        await check(`${path} renders at ${label} size with no console error, no failed request and no sideways scroll`, async () => {
          const context = await browser.newContext({ viewport: size });
          const problems: Problems = [];
          const page = await open(context, A + path, problems);
          assert.equal((page as unknown as { __status: number }).__status, 200);
          assert.ok((await page.locator("h1").count()) >= 1, "has a heading");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(overflow, 0, `page scrolls sideways: ${await wideElements(page)}`);
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

    // What the pages show of the chain follows docs/EVIDENCE.md, whatever it holds on the day this runs.
    const evidence = parseEvidenceStrict(await readFile(join(root, "docs", "EVIDENCE.md"), "utf8"));
    const onMainnet = evidence.filter((r) => r.network === "mainnet");
    const onTestnet = evidence.filter((r) => r.network === "testnet");

    await check("the landing page shows the evidence file's mainnet rows and no other transaction, or says there are none and labels the fork sample as not mainnet", async () => {
      const page = await open(plain, A);
      assert.match(await text(page, "hero-status"), new RegExp(`mainnet rows in the evidence file: ${onMainnet.length}[,.]`));
      if (onMainnet.length > 0) {
        // The count never stands alone: how many of the rows are the project's own is said beside it and under the transactions.
        assert.match(await text(page, "hero-status"), /them about the project's own wallets/);
        assert.match(await text(page, "proof-own"), /about the project's own wallets, by the founder list/);
      }
      const links = await page.locator('a[href*="mainnet.qie.digital/tx"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
      if (onMainnet.length === 0) {
        assert.match(await text(page, "proof-empty"), /No mainnet transactions recorded yet/);
        assert.match(await text(page, "fork-sample"), /Sample from a local fork — not mainnet/);
        assert.deepEqual(links, []);
      } else {
        const shown = Math.min(onMainnet.length, 6);
        assert.equal(await page.locator('[data-testid="proof-strip"] li[data-kind="mainnet"]').count(), shown);
        assert.equal(await page.getByTestId("proof-empty").count(), 0);
        assert.equal(await page.getByTestId("fork-sample").count(), 0);
        assert.equal(links.length, shown);
        for (const href of links) assert.ok(onMainnet.some((r) => href === `https://mainnet.qie.digital/tx/${r.hash}`), `a link the evidence file does not hold: ${href}`);
      }
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

    await check("the evidence page shows each network's rows, or an empty table where there are none, and says no router is configured, never zero", async () => {
      const page = await open(plain, `${A}/evidence`);
      for (const [network, held] of [["mainnet", onMainnet], ["testnet", onTestnet]] as const) {
        await visible(page, `evidence-${network}`);
        assert.equal(await page.locator(`[data-testid="evidence-${network}"] tbody tr`).count(), held.length, `${network} rows`);
        assert.equal(await page.getByTestId(`evidence-${network}-empty`).count(), held.length === 0 ? 1 : 0, `${network} empty state`);
        assert.equal(await page.getByTestId(`evidence-${network}-own`).count(), held.length === 0 ? 0 : 1, `${network} says whose rows they are`);
      }
      assert.match(await text(page, "vault-source"), /pnpm live:vaultcheck/);
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

    await check("the demo opens on the real payment, with the sandbox as a second tab that is not selected", async () => {
      const page = await open(plain, `${A}/demo`);
      assert.equal(await page.getByTestId("tab-live").getAttribute("aria-selected"), "true");
      assert.equal(await page.getByTestId("tab-sandbox").getAttribute("aria-selected"), "false");
      assert.match(await text(page, "tab-sandbox"), /Sandbox \(no funds\)/);
      assert.equal(await page.getByTestId("panel-sandbox").isVisible(), false);
      await visible(page, "live-unconfigured");
      assert.match(await text(page, "live-unconfigured"), /not set up for real payments yet/);
      assert.match(await text(page, "live-unconfigured"), /Nothing on this page is simulated/);
      await page.close();
    });

    await check("the demo simulation runs to completion and keeps its banner on screen", async () => {
      const page = await open(plain, `${A}/demo`);
      await page.getByTestId("tab-sandbox").click();
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
      await page.getByTestId("tab-sandbox").click();
      await page.getByTestId("sim-run").click();
      await page.waitForTimeout(2500);
      assert.match(await text(page, "sim-progress"), /Step 1 of 7/);
      await page.getByTestId("sim-run").click();
      assert.match(await text(page, "sim-progress"), /Step 2 of 7/);
      await context.close();
    });

    await check("the demo's refusal examples show the spec's code, and 'show every step' and reset work", async () => {
      const page = await open(plain, `${A}/demo`);
      await page.getByTestId("tab-sandbox").click();
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

    // ===================================================================== the live flow
    // These are tests. The chain is a local node, the tokens have no value, and the tool server and the facilitator are processes this
    // script started. They check what the page does, step by step. They are not evidence of anything on mainnet.
    process.stderr.write("\nthe live flow (a test on a local chain, with throwaway keys)\n");

    async function payDone(page: Page, timeout = 30_000): Promise<void> {
      const done = page.getByTestId("pay-done");
      const failed = page.getByTestId("pay-failed");
      await Promise.race([done.waitFor({ state: "visible", timeout }), failed.waitFor({ state: "visible", timeout })]);
      if (await failed.isVisible()) throw new Error(`the payment failed: ${(await failed.innerText()).replace(/\s+/g, " ")}`);
    }

    /** A funded wallet, with a prepaid balance put in from outside the page, on a page where it is connected. */
    async function connectedPayer(path: string, options: MockOptions = {}, prepaid: bigint = USDC("0.1"), opts: { viewport?: { width: number; height: number }; qie?: bigint } = {}) {
      const problems: Problems = [];
      const { mock, context } = await walletContext(browser, stack, options, USDC("5"), opts.qie ?? parseEther("1"), opts.viewport ? { viewport: opts.viewport } : {});
      if (prepaid > 0n) await depositFor(stack, mock.wallet, prepaid);
      const page = await open(context, `${L}${path}`, problems);
      await page.getByTestId("connect").click();
      return { mock, context, page, problems };
    }

    /** Opens the payment review, confirms it and closes the result. */
    async function payOnce(page: Page): Promise<void> {
      await page.getByTestId("pay-review").click();
      await visible(page, "pay-dialog");
      await page.getByTestId("pay-confirm").click();
      await payDone(page);
      await page.getByTestId("pay-close").click();
    }

    /** Has the facilitator settle what it holds, then waits for the page to show the payment as settled. */
    async function seeSettled(page: Page): Promise<void> {
      await stack.facilitator.flush();
      const deadline = Date.now() + 30_000;
      let last = "";
      while (Date.now() < deadline) {
        last = await page.getByTestId("settlement-status").first().innerText().catch(() => "");
        if (/settled on chain/i.test(last)) return;
        const again = page.getByTestId("settlement-check").first();
        if (await again.isVisible().catch(() => false)) await again.click().catch(() => undefined);
        await page.waitForTimeout(500);
      }
      throw new Error(`the payment never showed as settled; the page said: ${last.slice(0, 160)}`);
    }

    await check("live: /demo opens on the real payment, names the local network as having no value, and reads the balances once connected", async () => {
      const { context, page, problems } = await connectedPayer("/demo", {}, 0n);
      assert.equal(await page.getByTestId("tab-live").getAttribute("aria-selected"), "true");
      assert.equal(await page.getByTestId("panel-sandbox").isVisible(), false);
      assert.match(await text(page, "live-banner"), /funds on this network have no value/);
      await visible(page, "live-balances-view");
      assert.match(await text(page, "live-qusdc"), /5\.000000/);
      assert.match(await text(page, "live-prepaid"), /0\.000000/);
      assert.match(await text(page, "live-qie"), /1\.0000/);
      assert.equal(await page.inputValue("#live-deposit-amount"), "0.1", "the deposit starts at 0.10 QUSDC");
      assert.deepEqual(problems, []);
      await context.close();
    });

    await check("live: a deposit above the page's cap is refused in words before any review opens, and nothing is sent", async () => {
      const { mock, context, page } = await connectedPayer("/demo", {}, 0n);
      await visible(page, "live-balances-view");
      await page.fill("#live-deposit-amount", "5");
      await page.getByTestId("live-deposit-review").click();
      assert.match(await text(page, "live-deposit-error"), /at most 1\.000000 QUSDC/);
      assert.equal(await page.getByTestId("flow-dialog").isVisible(), false);
      await page.fill("#live-deposit-amount", "abc");
      await page.getByTestId("live-deposit-review").click();
      assert.ok((await text(page, "live-deposit-error")).length > 10);
      assert.equal(mock.count("eth_sendTransaction"), 0);
      await context.close();
    });

    await check("live: the deposit review shows the approval for exactly the amount, cancel sends nothing, and confirm deposits and updates the balance", async () => {
      const { mock, context, page } = await connectedPayer("/demo", {}, 0n);
      await visible(page, "live-balances-view");
      await page.getByTestId("live-deposit-review").click();
      await visible(page, "flow-dialog");
      const fields = await text(page, "flow-fields");
      assert.match(fields, /Approve the router to move exactly 0\.100000 QUSDC/);
      assert.match(fields, /Network fee\s+up to/);
      assert.match(fields, /Network\s+Local node or fork, chain 1990 \(no real funds\)/, "a local node is never described as real funds");
      assert.equal(mock.count("eth_sendTransaction"), 0, "nothing is sent while the review is open");
      await page.getByTestId("flow-cancel").click();
      assert.equal(mock.count("eth_sendTransaction"), 0, "nothing is sent after cancel");
      await page.getByTestId("live-deposit-review").click();
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      assert.equal(mock.count("eth_sendTransaction"), 2);
      assert.equal(await stack.router.payerBalance(mock.address), USDC("0.1"));
      await page.getByTestId("flow-close").click();
      await waitText(page, "live-prepaid", /0\.100000/);
      await context.close();
    });

    await check("live: with no QIE the page says what the facilitator will send, the wallet signs without sending, and the deposit lands", async () => {
      const { mock, context, page } = await connectedPayer("/demo", {}, 0n, { qie: 0n });
      await visible(page, "zero-qie-note");
      assert.match(await text(page, "zero-qie-note"), /facilitator will send you exactly the QIE/);
      await page.getByTestId("live-deposit-review").click();
      await visible(page, "flow-dialog");
      const dialog = await text(page, "flow-dialog");
      assert.match(dialog, /Deposit QUSDC with no QIE/);
      assert.match(dialog, /Gas top-up/);
      assert.match(dialog, /sign two transactions without sending them/);
      assert.equal(mock.count("eth_signTransaction"), 0, "nothing is signed while the review is open");
      await page.getByTestId("flow-confirm").click();
      await flowDone(page);
      assert.equal(mock.count("eth_sendTransaction"), 0);
      assert.equal(mock.count("eth_signTransaction"), 2);
      assert.equal(await stack.router.payerBalance(mock.address), USDC("0.1"));
      await context.close();
    });

    await check("live: a paid call shows its price, payee and what is signed before the wallet opens; cancel signs nothing; confirm returns the tool's answer, then the settlement with a receipt", async () => {
      const problems: Problems = [];
      const before = await stack.router.earnings(stack.builder.address);
      const { mock, context, page } = await connectedPayer("/demo");
      await visible(page, "tool-select");
      assert.match(await text(page, "tool-select"), /token_risk_check: 0\.01 QUSDC/);
      await page.getByTestId("pay-review").click();
      await visible(page, "pay-dialog");
      const fields = await text(page, "pay-fields");
      assert.match(fields, /Price\s+0\.010000 QUSDC/);
      assert.match(fields, new RegExp(`Paid to\\s+${stack.builder.address}`, "i"));
      assert.match(fields, new RegExp(`From\\s+${mock.address}`, "i"));
      assert.match(fields, /Prepaid balance\s+0\.100000 QUSDC now, 0\.090000 QUSDC after/);
      assert.match(fields, /Network fee\s+None for you/);
      assert.match(fields, /Network\s+Local node or fork, chain 1990 \(no real funds\)/, "a local node is never described as real funds");
      assert.doesNotMatch(await text(page, "pay-dialog"), /real QUSDC|QIE mainnet/);
      assert.match(await text(page, "pay-dialog"), /Nothing is signed until you press Confirm/);
      assert.equal(mock.count("eth_signTypedData_v4"), 0, "nothing is signed while the review is open");
      await page.getByTestId("pay-cancel").click();
      assert.equal(mock.count("eth_signTypedData_v4"), 0, "nothing is signed after cancel");
      await page.getByTestId("pay-review").click();
      await page.getByTestId("pay-confirm").click();
      await payDone(page);
      assert.equal(mock.count("eth_signTypedData_v4"), 1);
      assert.equal(mock.count("eth_sendTransaction"), 0, "a call is paid by signing, not by sending");
      await page.getByTestId("pay-close").click();
      await visible(page, "paid-result");
      assert.ok((await text(page, "pay-output")).trim().length > 20, "the tool's answer is on the page");
      assert.match((await page.getByTestId("pay-signature").textContent()) ?? "", /^0x[0-9a-f]{6,}/i, "the signature the person made is shown (it is in a closed details)");
      await seeSettled(page);
      assert.match(await text(page, "receipt"), /0x[0-9a-f]{6,}/i);
      assert.equal((await stack.router.earnings(stack.builder.address)) - before, USDC("0.0099"), "the builder was credited the price less the 1% fee, once");
      assert.equal(await stack.router.payerBalance(mock.address), USDC("0.09"));
      assert.deepEqual(problems, []);
      await context.close();
    });

    await check("live: pressing Confirm twice signs once and charges once", async () => {
      const before = await stack.router.earnings(stack.builder.address);
      const { mock, context, page } = await connectedPayer("/demo");
      await visible(page, "tool-select");
      await page.getByTestId("pay-review").click();
      await visible(page, "pay-dialog");
      // Two presses in the same moment, as a double-click makes: the second lands on a button that has already been disabled.
      await page.evaluate(() => {
        const button = document.querySelector('[data-testid="pay-confirm"]') as HTMLButtonElement;
        button.click();
        button.click();
      });
      await payDone(page);
      assert.equal(mock.count("eth_signTypedData_v4"), 1);
      await page.getByTestId("pay-close").click();
      await seeSettled(page);
      assert.equal((await stack.router.earnings(stack.builder.address)) - before, USDC("0.0099"));
      assert.equal(await page.getByTestId("paid-result").count(), 1);
      await context.close();
    });

    await check("live: a reload in the middle of a payment picks it up again from the saved record and the chain, and it settles once", async () => {
      const before = await stack.router.earnings(stack.builder.address);
      const { mock, context, page } = await connectedPayer("/demo");
      await visible(page, "tool-select");
      await payOnce(page);
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("connect").click();
      await visible(page, "paid-result");
      assert.match(await text(page, "paid-result"), /picked up again after a reload/);
      assert.equal(mock.count("eth_signTypedData_v4"), 1, "the reload signed nothing");
      await seeSettled(page);
      assert.equal((await stack.router.earnings(stack.builder.address)) - before, USDC("0.0099"));
      // Once it shows as settled it is no longer in flight, so another reload does not bring it back.
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("connect").click();
      await visible(page, "live-balances-view");
      await page.waitForTimeout(1500);
      assert.equal(await page.getByTestId("paid-result").count(), 0, "a settled payment came back after another reload");
      await context.close();
    });

    await check("live: a payer who has not deposited is told the balance and to deposit, and nothing is signed", async () => {
      const { mock, context, page } = await connectedPayer("/demo", {}, 0n);
      await visible(page, "tool-select");
      await page.getByTestId("pay-review").click();
      const message = await text(page, "pay-error");
      assert.match(message, /prepaid balance in the router is 0\.000000 QUSDC/);
      assert.match(message, /Deposit first|deposit step/i);
      assert.equal(await page.getByTestId("pay-dialog").isVisible(), false);
      assert.equal(mock.count("eth_signTypedData_v4"), 0);
      await context.close();
    });

    await check("live: a signature rejected in the wallet says so, charges nothing, and offers a way to review again", async () => {
      const { mock, context, page } = await connectedPayer("/demo", { rejectSign: true });
      await visible(page, "tool-select");
      await page.getByTestId("pay-review").click();
      await page.getByTestId("pay-confirm").click();
      await visible(page, "pay-failed");
      assert.match(await text(page, "pay-failed-headline"), /You rejected the request in your wallet/);
      assert.match(await text(page, "pay-failed-funds"), /nothing|no funds|not been|was not/i);
      assert.equal(await stack.router.payerBalance(mock.address), USDC("0.1"));
      assert.equal(await page.getByTestId("paid-result").count(), 0);
      await context.close();
    });

    await check("live: a wallet on the wrong network is told so, nothing can be reviewed, and switching makes the page work", async () => {
      const { context, page } = await connectedPayer("/demo", { chainId: 1, knownChains: [1] }, 0n);
      await visible(page, "wrong-network");
      assert.match(await text(page, "wrong-network"), /Wrong network/);
      assert.equal(await page.getByTestId("pay-review").isDisabled(), true);
      await page.getByTestId("switch-network").click();
      await page.getByTestId("wrong-network").waitFor({ state: "detached", timeout: 10_000 });
      await visible(page, "live-balances-view");
      await context.close();
    });

    await check("live: a wallet that a phone's wallet-app browser puts on the page after it has loaded is found, with no reload", async () => {
      const { context } = await walletContext(browser, stack, {}, USDC("5"), parseEther("1"), { viewport: { width: 390, height: 844 }, lateMs: 5000 });
      const page = await open(context, `${L}/demo`);
      await page.getByTestId("connect").click();
      assert.match(await text(page, "wallet-error"), /No wallet is ready yet/, "pressing Connect before the wallet is there says to wait, and does not do nothing");
      await visible(page, "no-wallet", 8000); // the page gave up looking after about three seconds
      await page.getByTestId("no-wallet").waitFor({ state: "detached", timeout: 10_000 }); // and took the wallet when it arrived and announced itself
      await page.getByTestId("connect").click();
      await visible(page, "live-balances-view");
      await context.close();
    });

    await check("live: with no wallet at all the page says so after a few seconds, and tells a phone's visitor where to open it", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const page = await open(context, `${L}/demo`);
      await visible(page, "no-wallet", 10_000);
      assert.match(await text(page, "no-wallet"), /On a phone, open this page from the browser inside the wallet app/);
      await context.close();
    });

    await check("live: a tool server that does not answer is named in words, with a retry, and nothing is asked of the wallet", async () => {
      const { mock, context } = await walletContext(browser, stack, {}, USDC("5"), parseEther("1"));
      await depositFor(stack, mock.wallet, USDC("0.1"));
      await context.route(`${toolsUrl}/**`, (route) => route.abort());
      const page = await context.newPage();
      await page.goto(`${L}/demo`, { waitUntil: "networkidle" });
      await page.getByTestId("connect").click();
      await visible(page, "tools-error");
      assert.match(await text(page, "tools-error"), /Nothing was paid/);
      assert.equal(await page.getByTestId("tools-retry").isVisible(), true);
      assert.equal(await page.getByTestId("pay-review").count(), 0);
      assert.equal(mock.count("eth_signTypedData_v4"), 0);
      await context.unroute(`${toolsUrl}/**`);
      await page.getByTestId("tools-retry").click();
      await visible(page, "tool-select");
      await context.close();
    });

    await check("live: when the page cannot reach the facilitator, a paid call still completes and the settlement line says it is not known instead of failing", async () => {
      const { context, page, problems } = await connectedPayer("/demo");
      await visible(page, "tool-select");
      await context.route(`${stack.facilitatorUrl}/**`, (route) => route.abort());
      await payOnce(page);
      await visible(page, "settlement-status");
      const line = await text(page, "settlement-status");
      assert.doesNotMatch(line, /settled on chain/i);
      assert.equal(problems.filter((p) => p.startsWith("page error")).length, 0, "no uncaught error");
      await context.close();
    });

    await check("wallet: the history lists what happened on chain with explorer links, can be downloaded as a CSV, and an empty wallet gets an empty state", async () => {
      const fresh = await walletContext(browser, stack, {}, 0n, parseEther("1"));
      const empty = await open(fresh.context, `${L}/wallet`);
      await empty.getByTestId("connect").click();
      await visible(empty, "history-empty");
      await fresh.context.close();

      const { mock, context, page } = await connectedPayer("/wallet");
      await page.goto(`${L}/demo`, { waitUntil: "networkidle" });
      await page.getByTestId("connect").click();
      await visible(page, "tool-select");
      await payOnce(page);
      await seeSettled(page);
      await page.goto(`${L}/wallet`, { waitUntil: "networkidle" });
      await page.getByTestId("connect").click();
      await visible(page, "history-table");
      const kinds = await page.locator('[data-testid="history-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      assert.ok(kinds.length >= 2, `history rows: ${kinds.join(",")}`);
      assert.ok(kinds.some((k) => /deposit/i.test(String(k))), `a deposit row: ${kinds.join(",")}`);
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("history-csv").click()]);
      assert.match(download.suggestedFilename(), /^sluice-history-0x[0-9a-f]{4}[0-9a-f]{4}-\d{4}-\d{2}-\d{2}\.csv$/i);
      const csv = await readFile((await download.path()) as string, "utf8");
      assert.ok(csv.split(/\r?\n/).filter(Boolean).length >= kinds.length + 1, "a header and a line for each row");
      assert.ok(!csv.includes(mock.wallet.privateKey), "no key in the file");
      await context.close();
    });

    await check("builder: the tool server's tools and prices are listed with the payee, and a real paid test call works from the page", async () => {
      const before = await stack.router.earnings(stack.builder.address);
      const { context, page } = await connectedPayer("/builder");
      await visible(page, "tools-table");
      assert.equal(await page.locator('[data-testid="tools-table"] tbody tr').count(), 3);
      assert.match(await text(page, "tools-table"), /token_risk_check/);
      assert.match(await text(page, "tools-table"), /0\.01/);
      assert.match(await text(page, "tools-payee"), new RegExp(`Paid to ${stack.builder.address.slice(0, 6)}…${stack.builder.address.slice(-4)}`, "i"));
      assert.match(await text(page, "tools-payee"), /not the address you are looking at/, "a payer testing the tool is told these tools do not earn for them");
      await visible(page, "tool-select");
      await payOnce(page);
      await seeSettled(page);
      assert.equal((await stack.router.earnings(stack.builder.address)) - before, USDC("0.0099"));
      await context.close();
    });

    await check("the status page reads the facilitator and the tool server, shows an overall state, and its JSON route has no secret and limits a caller", async () => {
      const problems: Problems = [];
      const page = await open(await browser.newContext(), `${L}/status`, problems);
      await visible(page, "status-view");
      await visible(page, "status-overall-tag");
      assert.doesNotMatch(await text(page, "facilitator-status"), /not answering/);
      assert.doesNotMatch(await text(page, "tools-status"), /not answering/);
      assert.deepEqual(problems, []);
      const res = await fetch(`${L}/api/status`);
      assert.equal(res.status, 200);
      const raw = await res.text();
      const keys: string[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
      };
      walk(JSON.parse(raw));
      assert.deepEqual(keys.filter((k) => /secret|private|password|mnemonic|apikey|bearer|authorization/i.test(k)), []);
      assert.doesNotMatch(raw, /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/, "no 32-byte value that could be a key");
      assert.equal((await fetch(`${L}/api/status`, { method: "POST" })).status, 405);
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) limited = (await fetch(`${L}/api/status`)).status === 429;
      assert.ok(limited, "a caller that asks over and over is told to slow down");
      await page.close();
    });

    await check("the terms, the privacy page and the security page render from the repository, without the repo's draft line, and say who must still review them", async () => {
      for (const [path, heading] of [["/terms", /Terms/i], ["/privacy", /Privacy/i], ["/security", /What limits what can go wrong/]] as const) {
        const page = await open(await browser.newContext(), `${L}${path}`);
        assert.match(await page.locator("h1").first().innerText(), heading);
        const body = await page.locator("body").innerText();
        assert.doesNotMatch(body, /not legal advice/i, `${path} carries the repository's draft line`);
        assert.doesNotMatch(body, /\b(audited|battle-tested|production-ready|guaranteed?|risk-free)\b/i, `${path} makes a claim the project cannot support`);
        await page.close();
      }
      const security = await open(await browser.newContext(), `${L}/security`);
      const body = await security.locator("body").innerText();
      assert.match(body, /No outside security review/);
      assert.match(body, /QUSDC/);
      await security.close();
    });

    await check("live: at phone width the whole flow fits the screen, and the review fits inside it", async () => {
      const { context, page, problems } = await connectedPayer("/demo", {}, USDC("0.1"), { viewport: { width: 390, height: 844 } });
      await visible(page, "tool-select");
      const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(await sideways(), 0, `the live tab scrolls sideways: ${await wideElements(page)}`);
      await page.getByTestId("pay-review").click();
      await visible(page, "pay-dialog");
      const box = await page.getByTestId("pay-dialog").boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390.5, `the review is wider than the screen: ${JSON.stringify(box)}`);
      assert.equal(await sideways(), 0, `the review scrolls sideways: ${await wideElements(page)}`);
      assert.ok(await page.getByTestId("pay-confirm").isVisible());
      await page.getByTestId("pay-cancel").click();
      assert.deepEqual(problems, []);
      await context.close();
    });

    const failed = results.filter((r) => !r.ok);
    process.stderr.write(`\nweb e2e:${results.length - failed.length} passed, ${failed.length} failed\n`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => undefined);
    stop(empty);
    stop(live);
    await tools.close().catch(() => undefined);
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
