import type { Metadata } from "next";
import { PageHead } from "../../components/page-head";
import { PayerDashboard } from "../../components/payer-dashboard";
import { WalletProvider } from "../../components/providers";

export const metadata: Metadata = {
  title: "Wallet and budgets",
  description: "Balances, agent keys with their on-chain limits, and the actions to deposit, refund, authorise and revoke.",
};

export default function WalletPage() {
  return (
    <>
      <PageHead eyebrow="For agents and their owners" title="Wallet and agent budgets">
        <p>
          Fund the router, set what an agent key may spend, and take it back. Every action shows what your wallet will be asked to sign before it opens. This page never asks for a private key or a seed phrase.
        </p>
      </PageHead>
      <div className="wrap stack gap-xl">
        <WalletProvider>
          <PayerDashboard />
        </WalletProvider>
      </div>
    </>
  );
}
