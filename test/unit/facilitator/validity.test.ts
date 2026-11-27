// What a signed payment's lifetime decides, shown on a local chain with the real contracts. It was looked into before choosing how a
// hosted tool server gets paid when the facilitator's first try fails: a longer lifetime would give the later tries more room. What these
// tests show is why the lifetime was left at five minutes. A longer one does not let a payment settle twice, and the contracts still hold
// each session to its limits when they settle. But the lifetime is the one thing that ends an unused signature, also across a revocation
// followed by a new authorisation of the same key, and the clients cap it at five minutes whatever a server asks for.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { parseEther } from "ethers";
import type { Wallet } from "ethers";
import { network } from "hardhat";
import { DEFAULT_TIMEOUT_SECONDS, ERRORS, PAYMENT_META_KEY, buildPaymentRequired, paymentRequiredResult, resourceFor, toolIdOf } from "@sluice/sdk";
import type { PaymentPayload } from "@sluice/sdk";
import { PaymentProxy, parseConfig } from "@sluice/proxy";
import { INTENT_LIFETIME_SECONDS } from "../../../apps/web/src/lib/paid-call";
import { USDC } from "../../helpers";
import { rejection } from "../../helpers/assert";
import { makePayment, requirementsFor, verifyBody } from "../../helpers/payments";
import { depositFor, fundWallet, startStack, throwawayWallet } from "../../helpers/stack";
import type { Stack } from "../../helpers/stack";

const LONG = 1_800;

describe("A payment's lifetime", function () {
  this.timeout(180_000);
  let s: Stack;
  let owner: Wallet;
  let builder: string;

  beforeEach(async () => {
    s = await startStack({ feeBps: 100 });
    owner = throwawayWallet();
    builder = throwawayWallet().address;
    await fundWallet(s, owner, USDC("5"), parseEther("1"));
    await depositFor(s, owner, USDC("5"));
  });
  afterEach(async () => {
    await s.stop();
  });

  const later = async (seconds: number) => {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine", []);
  };
  const settleOnChain = async (m: Awaited<ReturnType<typeof makePayment>>) => {
    const router = s.router.connect(owner.connect(s.provider)) as unknown as { settle: (intent: unknown, signature: string) => Promise<{ wait: () => Promise<unknown> }> };
    return (await router.settle(m.intent, m.signature)).wait();
  };
  const asked = (seconds: number) => requirementsFor(s, builder, USDC("0.01"), "echo", { maxTimeoutSeconds: seconds });

  it("does not let a long-lived payment settle twice, on the chain or at the facilitator", async () => {
    const m = await makePayment(s, owner, owner.address, asked(LONG), { deadline: BigInt(s.clock() + LONG) });
    expect(await s.facilitator.settle(verifyBody(m))).to.include({ success: true });
    expect(await s.facilitator.flush()).to.include({ settled: 1 });
    await later(600);
    // The same one again is the same record, already settled: nothing is queued, and a check says it was used.
    expect((await s.facilitator.settle(verifyBody(m))).extensions?.sluice?.status).to.equal("settled");
    expect(await s.facilitator.flush()).to.include({ submitted: 0 });
    expect((await s.facilitator.verify(verifyBody(m))).invalidReason).to.equal(ERRORS.intentReplayed);
    await rejection(settleOnChain(m));
    expect(await s.router.earnings(builder)).to.equal(USDC("0.01") - USDC("0.01") / 100n);
  });

  it("lets a payment signed under a session settle after the key is revoked and authorised again, for as long as it lives", async () => {
    const agent = throwawayWallet();
    const vault = s.vault.connect(owner.connect(s.provider)) as unknown as {
      authorize: (grant: unknown, tools: unknown) => Promise<{ wait: () => Promise<unknown> }>;
      revoke: (agent: string) => Promise<{ wait: () => Promise<unknown> }>;
    };
    const authorise = async () =>
      (await vault.authorize({ agent: agent.address, budget: USDC("0.5"), perCallCap: USDC("0.05"), expiry: BigInt(s.clock() + 86_400) }, [{ payee: builder, toolId: toolIdOf("echo") }])).wait();
    await authorise();
    const short = await makePayment(s, agent, owner.address, asked(DEFAULT_TIMEOUT_SECONDS), { deadline: BigInt(s.clock() + DEFAULT_TIMEOUT_SECONDS) });
    const long = await makePayment(s, agent, owner.address, asked(LONG), { deadline: BigInt(s.clock() + LONG) });
    await (await vault.revoke(agent.address)).wait();
    await rejection(settleOnChain(long)); // while revoked, nothing signed by the key settles
    await later(600); // past five minutes
    await authorise(); // the owner gives the same key a new session, with a new budget
    await rejection(settleOnChain(short)); // the five-minute signature is dead
    await settleOnChain(long); // the thirty-minute one draws on the new session
    const session = (await s.vault.getFunction("sessionOf")(owner.address, agent.address)) as { spent: bigint };
    expect(session.spent).to.equal(USDC("0.01"));
  });

  it("is capped at five minutes by the clients, whatever a server asks", async () => {
    expect(DEFAULT_TIMEOUT_SECONDS).to.equal(300);
    expect(INTENT_LIFETIME_SECONDS, "the web app").to.equal(300);
    const dir = mkdtempSync(join(tmpdir(), "sluice-validity-"));
    try {
      const config = parseConfig(
        {
          upstream: { url: "http://127.0.0.1:3402/mcp" },
          router: s.routerAddress,
          asset: s.tokenAddress,
          payer: owner.address,
          budget: { perCallCap: "0.05", totalCap: "1.00", expiresAt: new Date((s.clock() + 3_600) * 1000).toISOString(), allowedTools: [{ tool: "echo", payee: builder }] },
          logFile: "log.jsonl",
          stateFile: "state.json",
        },
        s.clock(),
        dir,
      );
      let signed: PaymentPayload | undefined;
      const proxy = new PaymentProxy({
        config,
        signer: throwawayWallet(),
        now: s.clock,
        upstream: {
          listTools: async () => ({ tools: [] }),
          callTool: async (params) => {
            const meta = params._meta?.[PAYMENT_META_KEY] as PaymentPayload | undefined;
            if (!meta) return paymentRequiredResult(buildPaymentRequired(resourceFor("echo"), [asked(LONG)]));
            signed = meta;
            return { content: [{ type: "text", text: "done" }] };
          },
        },
      });
      await proxy.callTool({ name: "echo", arguments: {} });
      expect(Number(signed?.payload.authorization.deadline) - s.clock(), "the proxy").to.be.at.most(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
