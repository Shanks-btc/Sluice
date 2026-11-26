import type { Metadata } from "next";
import { DemoBody } from "../../components/demo-body";

export const metadata: Metadata = {
  title: "Demo",
  description: "Pay for a real tool call with your own wallet and follow it to its settlement on chain, or run the sandbox with no funds.",
};

export default function DemoPage() {
  return <DemoBody />;
}
