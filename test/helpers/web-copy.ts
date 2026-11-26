// Reads the web app's source and pulls out the words a visitor can read: JSX text, labels, and string literals that are not module
// names or markup plumbing. The honesty tests scan these, so a claim cannot hide in a component. Uses the TypeScript compiler's parser.
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { safeReaddir } from "../../src/secret-paths";

export const webRoot = join(__dirname, "..", "..", "apps", "web");

export function sourceFiles(dir = "src", accept: (name: string) => boolean = (n) => /\.(ts|tsx)$/.test(n)): string[] {
  return safeReaddir(join(webRoot, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === ".next" || name === "generated") return [];
    return statSync(join(webRoot, rel)).isDirectory() ? sourceFiles(rel, accept) : accept(name) ? [rel] : [];
  });
}

export type Piece = { file: string; line: number; text: string };

/** JSX attributes whose value is plumbing, not words a person reads. */
const PLUMBING = new Set(["className", "id", "key", "href", "htmlFor", "rel", "target", "type", "role", "inputMode", "autoComplete", "method", "src", "viewBox", "width", "height", "stroke", "fill", "d", "x", "y", "cx", "cy", "r", "rx", "textAnchor", "preserveAspectRatio", "xmlns", "name", "value", "dateTime", "lang", "charSet", "content", "media", "as", "crossOrigin"]);

export function extractText(file: string, source = readFileSync(join(webRoot, file), "utf8")): Piece[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Piece[] = [];
  const add = (node: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length === 0) return;
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: t });
  };
  const inPlumbing = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p) || ts.isLiteralTypeNode(p)) return true;
      if (ts.isJsxAttribute(p)) {
        const name = p.name.getText(sf);
        return PLUMBING.has(name) || name.startsWith("data-");
      }
      if (ts.isPropertyAssignment(p) && p.name === node) return true;
      if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) add(node, node.getText(sf));
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !inPlumbing(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node) && !inPlumbing(node)) {
      add(node, node.head.text + node.templateSpans.map((s) => s.literal.text).join(" "));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export const rel = (file: string) => relative(webRoot, join(webRoot, file));

/** Every piece of visible text in the app. Comments are not included: they are not shown. */
export function allText(): Piece[] {
  return sourceFiles().flatMap((f) => extractText(f));
}
