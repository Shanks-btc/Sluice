// The kill switch. When it is on, the facilitator stops everything that spends QIE or sends a transaction: it queues no new
// payment, settles none, sends no zero-QIE start or top-up, and relays no signed request. Reading still works: /health, /status and
// /verify answer as usual, so an operator can look at what is going on while it is off.
//
// Two ways to turn it on, and either one is enough:
//   - SLUICE_FACILITATOR_KILL_SWITCH=1 in the environment (read when the service starts: it takes a restart to change);
//   - a file whose path is SLUICE_FACILITATOR_KILL_FILE, which is checked on every request: `New-Item` the file to stop the
//     facilitator at once without restarting it, delete the file to let it go again.

import { existsSync } from "node:fs";

export class KillSwitch {
  private engaged = false;

  constructor(
    private readonly fromEnv = false,
    private readonly file?: string,
  ) {}

  /** True if the flag was set, the file is there, or `engage` was called. */
  active(): boolean {
    if (this.fromEnv || this.engaged) return true;
    if (this.file) {
      try {
        return existsSync(this.file);
      } catch {
        return true; // a file that cannot even be looked for is not safe to run past
      }
    }
    return false;
  }

  /** Stops the facilitator from this process. Only a restart clears it. */
  engage(): void {
    this.engaged = true;
  }
}
