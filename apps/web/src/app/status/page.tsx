import type { Metadata } from "next";
import { PageHead } from "../../components/page-head";
import { StatusView } from "../../components/status-view";
import { readStatusCached } from "../../lib/service-status-server";

export const metadata: Metadata = {
  title: "Status",
  description: "Whether the facilitator, the tool server and the QIE nodes this site depends on are working, read from the services themselves.",
};

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const status = await readStatusCached();
  return (
    <>
      <PageHead eyebrow="Status" title="Is it working?">
        <p>
          Read from the facilitator, the tool server and QIE&apos;s nodes when you open the page. It shows what they report, including when the kill switch is on or the relayer is running low on QIE. The same readings are at <a className="link" href="/api/status">/api/status</a>.
        </p>
      </PageHead>
      <div className="wrap stack gap-xl">
        <StatusView status={status} />
      </div>
    </>
  );
}
