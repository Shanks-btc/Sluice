"use client";
// The last resort, for a failure in the root layout itself. It brings its own page frame and links to the site's stylesheet files only.
import "../design/fonts.css";
import "../design/tokens.css";
import "../styles/base.css";
import "../styles/ui.css";
import "../styles/site.css";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap-narrow state-page" data-testid="global-error">
          <p className="eye">Something went wrong</p>
          <h1>The site could not be shown</h1>
          <p className="muted">Nothing was sent from your wallet. Try again in a moment.</p>
          <div className="row">
            <button type="button" className="btn btn-dark" onClick={reset}>
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
