// The generated content (apps/web/src/generated/content.json, written by `pnpm web:content`) and the fork sample, typed.
import generated from "../generated/content.json";
import forkSample from "../content/fork-sample.json";
import type { ForkSample } from "../components/proof-strip";
import type { DocEntry, WebContent } from "./content-types";

export const content = generated as unknown as WebContent;

/** A sample written by the fork tests, or null. The proof strip shows it only with its "not mainnet" label. */
export const fork: ForkSample | null = forkSample as unknown as ForkSample | null;

export const docBySlug = (slug: string): DocEntry | undefined => content.docs.find((d) => d.slug === slug);
