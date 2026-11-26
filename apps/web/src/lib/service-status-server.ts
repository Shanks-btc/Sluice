// The status reader the /status page and the /api/status route share, built once per server instance so that its held answer is shared.
// Server code only: it reads the services from the server and keeps the answer for a few seconds.
import { loadConfigFromProcess } from "./config";
import { cachedStatusReader, readServiceStatus } from "./service-status";

export const readStatusCached = cachedStatusReader(() => readServiceStatus(loadConfigFromProcess()), 10_000);
