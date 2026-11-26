import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalDoc } from "../../components/legal-doc";
import { loadConfigFromProcess } from "../../lib/config";
import { docBySlug } from "../../lib/content";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What the site and the services behind it collect, what stays in your browser, and what is public by nature.",
};

export default function PrivacyPage() {
  if (!docBySlug("privacy")) notFound();
  return <LegalDoc slug="privacy" repoUrl={loadConfigFromProcess().repoUrl} />;
}
