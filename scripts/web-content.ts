// pnpm web:content: writes apps/web/src/generated/content.json from the repository's documents.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTENT_PATH, buildContent, serialize } from "../src/web-content";

const root = join(__dirname, "..");
const content = buildContent(root);
const file = join(root, CONTENT_PATH);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, serialize(content));
process.stderr.write(`web content: ${content.docs.length} documents, ${content.evidence.rows.length} evidence rows -> ${CONTENT_PATH}\n`);
