"use client";
// Connect, and the state of the connection: which account, which network, and what to do when the wallet is on the wrong one.
import { shortAddress } from "../lib/format";
import { useConfig, useWallet } from "./providers";

export function NetworkBadge() {
  const { network } = useConfig();
  return (
    <span className={network.realFunds ? "tag tag-warn" : "tag tag-info"} data-testid="network-badge">
      {network.label} · chain {network.chainId}
      {network.realFunds ? " · real funds" : " · no real funds"}
    </span>
  );
}

export function WalletBar() {
  const config = useConfig();
  const wallet = useWallet();
  return (
    <div className="wallet-bar card card-solid card-sm" data-testid="wallet-bar">
      <div className="row wallet-line">
        <NetworkBadge />
        {wallet.status === "connected" && wallet.account ? (
          <span className="address" data-testid="account">
            {shortAddress(wallet.account)}
          </span>
        ) : null}
        <span className="spacer" />
        {wallet.status === "unavailable" ? (
          <p className="muted" data-testid="no-wallet">
            No wallet found in this browser. Install QIE Wallet or MetaMask, then reload.
          </p>
        ) : wallet.status === "connected" ? (
          <span className="tag tag-success">Connected</span>
        ) : (
          <button type="button" className="btn btn-dark btn-sm" onClick={() => void wallet.connect()} disabled={wallet.status === "connecting"} data-testid="connect">
            {wallet.status === "connecting" ? "Waiting for your wallet…" : "Connect wallet"}
          </button>
        )}
      </div>
      {wallet.status === "connected" && wallet.network === "wrong" ? (
        <div className="wrong-network" role="alert" data-testid="wrong-network">
          <p>
            <strong>Wrong network.</strong> Your wallet is on chain {wallet.chainId}. This page reads and sends on {config.network.label} (chain {config.chainId}).
          </p>
          <button type="button" className="btn btn-soft btn-sm" onClick={() => void wallet.switchNetwork()} data-testid="switch-network">
            Switch to {config.network.label}
          </button>
          <p className="muted">If your wallet does not know the network, it will ask to add it with QIE&apos;s published settings.</p>
        </div>
      ) : null}
      {wallet.error ? (
        <p className="field-error-text" role="alert" data-testid="wallet-error">
          {wallet.error}
        </p>
      ) : null}
    </div>
  );
}
