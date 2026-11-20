// A small Markdown renderer for the repository's own documents (the spec, the risks, the READMEs). It covers what those files use:
// headings, paragraphs, lists, tables, fenced code, block quotes, rules, and inline code, links, bold and italic.
//
// Raw HTML is never passed through: every character of the source is escaped, so a document cannot put a tag, a script or an event
// handler on the page. A link is kept only if it is http, https, mailto, a path or an anchor. Links between documents are rewritten
// to the site's own pages by `resolveHref`, so the site and the repository stay one set of documents.
import { PAGE_FOR_SOURCE } from "./content-types";

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type Heading = { depth: number; text: string; id: string };

export type RenderOptions = {
  /** The repository path of the document being rendered, for resolving relative links. */
  source: string;
  /** The project's GitHub address, when set. Without it a link to a file with no page on the site is shown as plain text. */
  repoUrl?: string | null;
};

export type Rendered = { html: string; headings: Heading[] };

/** GitHub's heading id: lower case, punctuation removed, spaces to hyphens. Matches the anchors the documents link to. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replace(/ /g, "-");

/** The text of an inline run with its formatting taken off: for ids and the table of contents. */
export function plainText(inline: string): string {
  return inline
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(^|[^\w])[*_]([^*_]+)[*_](?=[^\w]|$)/g, "$1$2")
    .trim();
}

// -------------------------------------------------------------------------------------------------- links

const SAFE = /^(https?:|mailto:)/i;

/** Where a link in a document should point on the site, or undefined if it should not be a link at all. */
export function resolveHref(href: string, options: RenderOptions): string | undefined {
  const raw = href.trim();
  if (raw === "") return undefined;
  if (raw.startsWith("#")) return raw;
  if (SAFE.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return undefined; // javascript:, data: and the rest
  const [pathPart, hash] = raw.split("#") as [string, string | undefined];
  const parts = options.source.split("/").slice(0, -1);
  for (const seg of pathPart.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const path = parts.join("/");
  const page = PAGE_FOR_SOURCE[path];
  if (page) return hash ? `${page}#${hash}` : page;
  if (path === "" || path === "README.md") return options.repoUrl ? options.repoUrl : undefined;
  if (options.repoUrl) return `${options.repoUrl}/blob/main/${path}${hash ? `#${hash}` : ""}`;
  return undefined;
}

const isExternal = (href: string): boolean => /^https?:/i.test(href);

// -------------------------------------------------------------------------------------------------- inline

/** Inline Markdown to HTML. The source is escaped first, so nothing in it can become markup. */
export function renderInline(source: string, options: RenderOptions): string {
  // Code spans first, held aside so nothing inside them is formatted.
  const codes: string[] = [];
  let text = source.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, body: string) => {
    codes.push(`<code>${escapeHtml(body.trim())}</code>`);
    return `${codes.length - 1}`;
  });
  text = escapeHtml(text);

  // Links and images: [label](target "title"). The label may hold one level of brackets.
  const links: string[] = [];
  text = text.replace(/(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, bang: string, label: string, target: string) => {
    const href = resolveHref(target.replace(/&amp;/g, "&"), options);
    const inner = bang ? label : formatRuns(label);
    if (!href) {
      links.push(inner);
    } else if (bang) {
      links.push(inner);
    } else {
      const rel = isExternal(href) ? ' rel="noopener noreferrer" target="_blank"' : "";
      links.push(`<a href="${escapeHtml(href)}"${rel}>${inner}</a>`);
    }
    return `${links.length - 1}`;
  });

  // Autolinks and bare addresses.
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;|(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, (_m, angled: string | undefined, lead: string | undefined, bare: string | undefined) => {
    const url = (angled ?? bare ?? "").replace(/&amp;/g, "&");
    links.push(`<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(url)}</a>`);
    return `${lead ?? ""}${links.length - 1}`;
  });

  text = formatRuns(text);
  return text
    .replace(/(\d+)/g, (_m, i: string) => links[Number(i)] ?? "")
    .replace(/(\d+)/g, (_m, i: string) => codes[Number(i)] ?? "");
}

/** Bold, italic and strikethrough on text that is already escaped. */
function formatRuns(text: string): string {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__([^_\n]+?)__(?=[^\w]|$)/g, "$1<strong>$2</strong>")
    .replace(/~~([^~\n]+?)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?=[^*\w]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?=[^\w]|$)/g, "$1<em>$2</em>");
}

// ---------------------------------------------------------------------------------------------------- blocks

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

const isBlockStart = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || BULLET.test(line) || ORDERED.test(line) || /^\s*>/.test(line);

function dedent(lines: string[], by: number): string[] {
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(by, l.length - l.trimStart().length))));
}

export function renderMarkdown(markdown: string, options: RenderOptions): Rendered {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const idFor = (text: string): string => {
    const base = slugify(plainText(text)) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  function blocks(lines: string[]): string {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (line.trim() === "") {
        i += 1;
        continue;
      }
      // Fenced code
      const fence = FENCE.exec(line);
      if (fence) {
        const mark = (fence[2] as string)[0] as string;
        const size = (fence[2] as string).length;
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !new RegExp(`^\\s*${mark}{${size},}\\s*$`).test(lines[i] as string)) {
          body.push((lines[i] as string).slice(Math.min((fence[1] as string).length, (lines[i] as string).length - (lines[i] as string).trimStart().length)));
          i += 1;
        }
        i += 1;
        const lang = fence[3] ? ` data-lang="${escapeHtml(fence[3])}"` : "";
        out.push(`<pre class="code"><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const depth = (heading[1] as string).length;
        const text = heading[2] as string;
        const id = idFor(text);
        headings.push({ depth, text: plainText(text), id });
        out.push(`<h${depth} id="${id}">${renderInline(text, options)}</h${depth}>`);
        i += 1;
        continue;
      }
      if (RULE.test(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote: string[] = [];
        while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
          quote.push((lines[i] as string).replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${blocks(quote)}</blockquote>`);
        continue;
      }
      // Table: a row of cells, then a separator row
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1] as string) && (lines[i + 1] as string).includes("-")) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1] as string).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim() !== "") {
          rows.push(splitRow(lines[i] as string));
          i += 1;
        }
        const cell = (tag: string, text: string, col: number) => `<${tag}${aligns[col] && aligns[col] !== "left" ? ` class="align-${aligns[col]}"` : ""}>${renderInline(text, options)}</${tag}>`;
        out.push(
          `<div class="table-scroll"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`)
            .join("")}</tbody></table></div>`,
        );
        continue;
      }
      // Lists, nested by indentation
      const bullet = BULLET.exec(line);
      const ordered = ORDERED.exec(line);
      if (bullet || ordered) {
        const isOrdered = !bullet;
        const indent = ((bullet ?? ordered) as RegExpExecArray)[1]!.length;
        const items: string[][] = [];
        while (i < lines.length) {
          const l = lines[i] as string;
          const m = isOrdered ? ORDERED.exec(l) : BULLET.exec(l);
          if (m && m[1]!.length === indent) {
            items.push([(isOrdered ? m[3] : m[3]) as string]);
            i += 1;
            continue;
          }
          if (m && m[1]!.length > indent && items.length) {
            items[items.length - 1]!.push(l);
            i += 1;
            continue;
          }
          if (l.trim() === "") {
            // A blank line stays in the list only if the next line continues an item.
            const next = lines[i + 1];
            if (next !== undefined && next.trim() !== "" && (next.length - next.trimStart().length > indent || (isOrdered ? ORDERED : BULLET).test(next) && ((isOrdered ? ORDERED : BULLET).exec(next) as RegExpExecArray)[1]!.length === indent)) {
              if (items.length) items[items.length - 1]!.push("");
              i += 1;
              continue;
            }
            break;
          }
          if (l.length - l.trimStart().length > indent && items.length) {
            items[items.length - 1]!.push(l);
            i += 1;
            continue;
          }
          if (!isBlockStart(l) && items.length && lines[i - 1] !== undefined && (lines[i - 1] as string).trim() !== "") {
            items[items.length - 1]!.push(l); // a line that carries on the item's text
            i += 1;
            continue;
          }
          break;
        }
        const tag = isOrdered ? "ol" : "ul";
        const html = items
          .map((item) => {
            const [first, ...rest] = item as [string, ...string[]];
            const body = rest.length ? blocks([first, ...dedent(rest, indent + 2)]) : null;
            if (body === null) return `<li>${renderInline(first, options)}</li>`;
            // An item's own text is not wrapped in a paragraph, whether or not a nested list or a code block follows it.
            const lead = /^<p>([\s\S]*?)<\/p>\n?/.exec(body);
            const tight = lead ? `${lead[1]}${body.slice(lead[0].length)}` : body;
            return `<li>${tight}</li>`;
          })
          .join("");
        out.push(`<${tag}>${html}</${tag}>`);
        continue;
      }
      // Paragraph
      const para: string[] = [];
      while (i < lines.length && (lines[i] as string).trim() !== "" && (para.length === 0 || !isBlockStart(lines[i] as string))) {
        para.push((lines[i] as string).trim());
        i += 1;
      }
      out.push(`<p>${renderInline(para.join(" "), options)}</p>`);
    }
    return out.join("\n");
  }

  const html = blocks(markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n"));
  return { html, headings };
}
