import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsSidebar, Prose, Toc } from "../../../components/doc-view";
import { docBySlug } from "../../../lib/content";
import { loadConfigFromProcess } from "../../../lib/config";
import { renderMarkdown } from "../../../lib/markdown";

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const doc = docBySlug((await params).slug);
  return doc ? { title: doc.title } : { title: "Not found" };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const doc = docBySlug((await params).slug);
  if (!doc) notFound();
  const { repoUrl } = loadConfigFromProcess();
  const { html, headings } = renderMarkdown(doc.markdown, { source: doc.source, repoUrl });
  return (
    <div className="wrap docs-layout">
      <DocsSidebar current={doc.slug} />
      <div className="docs-main">
        <p className="eye">
          {doc.group} · rendered from <span className="mono">{doc.source}</span>
        </p>
        <Prose html={html} source={doc.source} />
      </div>
      <Toc headings={headings} />
    </div>
  );
}
