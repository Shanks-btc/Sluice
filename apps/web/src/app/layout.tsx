import "../design/fonts.css";
import "../design/tokens.css";
import "../styles/base.css";
import "../styles/ui.css";
import "../styles/site.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { connection } from "next/server";
import { ConfigProvider } from "../components/providers";
import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import { SITE_DESCRIPTION, SITE_TITLE } from "../content/copy";
import { loadConfigFromProcess } from "../lib/config";
import { content } from "../lib/content";

export async function generateMetadata(): Promise<Metadata> {
  const { siteUrl } = loadConfigFromProcess();
  return {
    ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
    title: { default: SITE_TITLE, template: `%s · ${SITE_TITLE}` },
    description: SITE_DESCRIPTION,
    openGraph: { title: SITE_TITLE, description: SITE_DESCRIPTION, type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Sluice" }] },
    twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION, images: ["/og.png"] },
    icons: { icon: "/icon.svg" },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e8f4fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0a121c" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request, because the Content Security Policy carries a fresh nonce (src/proxy.ts).
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const config = loadConfigFromProcess();
  return (
    <html lang="en">
      <head>
        <script src="/theme-init.js" nonce={nonce} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to the content
        </a>
        <ConfigProvider config={config}>
          <Nav />
          <main id="main">{children}</main>
          <Footer repoUrl={config.repoUrl} deployed={content.evidence.rows.some((r) => r.network === "mainnet" && r.event === "Deployed")} />
        </ConfigProvider>
      </body>
    </html>
  );
}
