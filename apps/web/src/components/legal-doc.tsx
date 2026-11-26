// A legal document's page body: the repository's draft, rendered, without the "Draft: not legal advice" block that is for people reading the
// repository (src/web-content.ts strips it when the content is built). A plain component, so a test can render it.
import { docBySlug } from "../lib/content";
import { renderMarkdown } from "../lib/markdown";
import { Prose } from "./doc-view";

export function LegalDoc({ slug, repoUrl }: { slug: string; repoUrl: string | null }) {
  const doc = docBySlug(slug);
  if (!doc) return null;
  const { html } = renderMarkdown(doc.markdown, { source: doc.source, repoUrl });
  return (
    <div className="wrap wrap-narrow legal">
      <Prose html={html} source={doc.source} />
    </div>
  );
}
