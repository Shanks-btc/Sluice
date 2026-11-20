// A repository document, rendered. The sidebar lists every document; the right-hand list holds the headings of this one, as anchors.
// The Markdown is rendered by src/lib/markdown.ts, which escapes everything, so the HTML below is the renderer's own output.
import Link from "next/link";
import { DOC_SOURCES } from "../lib/content-types";
import type { DocGroup } from "../lib/content-types";
import type { Heading } from "../lib/markdown";

const GROUPS: DocGroup[] = ["Start", "Reference", "Packages"];

export function DocsSidebar({ current }: { current?: string }) {
  return (
    <nav className="docs-nav" aria-label="Documents">
      <details className="docs-nav-details" open>
        <summary>Documents</summary>
        {GROUPS.map((group) => (
          <div key={group} className="docs-group">
            <p className="eye">{group}</p>
            <ul>
              {DOC_SOURCES.filter((d) => d.group === group).map((d) => (
                <li key={d.slug}>
                  <Link href={`/docs/${d.slug}`} aria-current={current === d.slug ? "page" : undefined}>
                    {d.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="docs-group">
          <p className="eye">Also</p>
          <ul>
            <li>
              <Link href="/evidence">Evidence</Link>
            </li>
          </ul>
        </div>
      </details>
    </nav>
  );
}

export function Toc({ headings }: { headings: Heading[] }) {
  const items = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (items.length === 0) return null;
  return (
    <aside className="docs-toc" aria-label="On this page">
      <p className="eye">On this page</p>
      <ul>
        {items.map((h) => (
          <li key={h.id} className={h.depth === 3 ? "toc-sub" : undefined}>
            <a href={`#${h.id}`}>{h.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function Prose({ html, source }: { html: string; source: string }) {
  return <article className="prose" data-source={source} dangerouslySetInnerHTML={{ __html: html }} />;
}
