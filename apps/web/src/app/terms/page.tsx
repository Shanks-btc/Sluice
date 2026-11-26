import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalDoc } from "../../components/legal-doc";
import { loadConfigFromProcess } from "../../lib/config";
import { docBySlug } from "../../lib/content";

export const metadata: Metadata = {
  title: "Terms",
  description: "What Sluice is, what you can count on, and what you are responsible for.",
};

export default function TermsPage() {
  if (!docBySlug("terms")) notFound();
  return <LegalDoc slug="terms" repoUrl={loadConfigFromProcess().repoUrl} />;
}
