import type { Metadata } from "next";
import { PageHead } from "../../components/page-head";
import { SecurityView } from "../../components/security-view";
import { loadConfigFromProcess } from "../../lib/config";
import { cachedLiquidity, readQusdcLiquidity } from "../../lib/liquidity";
import { depsFromEnv } from "../../lib/risk-handler";

export const metadata: Metadata = {
  title: "Security",
  description: "The limits that apply today, what the owner can and cannot do, how deep QUSDC's market is, and what has not been reviewed.",
};

export const dynamic = "force-dynamic";

// Built once per server instance: a reading is kept for five minutes, so a page many people open makes one read.
const liquidity = cachedLiquidity(() => readQusdcLiquidity(depsFromEnv().rpc));

export default async function SecurityPage() {
  const config = loadConfigFromProcess();
  // QIEDEX's address is known on QIE mainnet. On any other chain id there is nothing to read.
  const depth = config.chainId === 1990 ? await liquidity() : undefined;
  return (
    <>
      <PageHead eyebrow="Security" title="What limits what can go wrong">
        <p>
          The limits that apply to you today, what the contracts&apos; owner can and cannot do, how much QUSDC the market holds, and what nobody has reviewed. Each limit is in code, and the tests hold this page to the code.
        </p>
      </PageHead>
      <SecurityView sessionCapUnits={config.sessionCapUnits} networkLabel={config.network.label} depth={depth} />
    </>
  );
}
