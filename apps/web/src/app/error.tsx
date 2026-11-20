"use client";
// Shown when a page fails while it renders. It shows no error text: a message from the server could hold a path or an address.
import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="wrap-narrow state-page" data-testid="error-page">
      <p className="eye">Something went wrong</p>
      <h1>This page could not be shown</h1>
      <p className="muted">Nothing was sent from your wallet. Try again, or go back to the start.</p>
      <div className="row">
        <button type="button" className="btn btn-dark" onClick={reset}>
          Try again
        </button>
        <Link className="btn btn-soft" href="/">
          Back to the start
        </Link>
      </div>
    </div>
  );
}
