// Renders React elements to HTML for the component tests, without a browser. Interactions are covered by the browser tests; this
// covers what each state of a component shows.
import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigProvider, WalletProvider } from "../src/components/providers";
import { readConfig } from "../src/lib/config";
import type { AppConfig } from "../src/lib/config";

/** createElement, so a test file need not import React itself. */
export const h = createElement;

export const html = (element: ReactElement): string => renderToStaticMarkup(element);

/** The words in the markup, with the tags taken out. */
export const textOf = (element: ReactElement): string =>
  html(element)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

export function withApp(children: ReactNode, config: AppConfig = readConfig({})): ReactElement {
  return (
    <ConfigProvider config={config}>
      <WalletProvider>{children}</WalletProvider>
    </ConfigProvider>
  );
}
