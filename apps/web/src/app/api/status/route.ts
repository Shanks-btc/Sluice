// GET /api/status: the same readings as the /status page, as JSON. Read-only, rate-limited, and free of secrets. The logic is in
// src/lib/service-status.ts.
import { makeStatusHandler } from "../../../lib/service-status";
import { readStatusCached } from "../../../lib/service-status-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Built once per server instance, so the limiter's counts persist between requests.
const handler = makeStatusHandler({ read: readStatusCached });

export const GET = (request: Request): Promise<Response> => handler(request);

export const POST = (request: Request): Promise<Response> => handler(request);
