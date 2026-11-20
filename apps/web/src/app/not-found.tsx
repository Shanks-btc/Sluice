import Link from "next/link";
import { Wordmark } from "../components/brand";

export default function NotFound() {
  return (
    <div className="wrap-narrow state-page" data-testid="not-found">
      <Wordmark />
      <p className="eye">404</p>
      <h1>That page is not here</h1>
      <p className="muted">The address may be mistyped, or the page may have moved. These are the places to start.</p>
      <div className="row">
        <Link className="btn btn-dark" href="/">
          Back to the start
        </Link>
        <Link className="btn btn-soft" href="/docs">
          Read the docs
        </Link>
      </div>
    </div>
  );
}
