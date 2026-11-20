import type { ReactNode } from "react";

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="wrap-narrow">
        <p className="eye">{eyebrow}</p>
        <h1>{title}</h1>
        {children ? <div className="page-lede">{children}</div> : null}
      </div>
    </header>
  );
}
