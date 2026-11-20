// POST /api/risk: the read-only token risk check for the demo page. All the guards live in src/lib/risk-handler.ts.
import { depsFromEnv, makeRiskHandler } from "../../../lib/risk-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Built once per server instance, so the rate limiter's counts persist between requests.
const handler = makeRiskHandler({ deps: () => depsFromEnv() });

export const POST = (request: Request): Promise<Response> => handler(request);

export const GET = (request: Request): Promise<Response> => handler(request);
