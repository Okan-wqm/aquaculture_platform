/**
 * Process-wide registry of `@ScheduledJob` names, filled at class-definition
 * time by the decorator and read at boot by `ScheduledJobRunner` to declare
 * every job's heartbeat before it has ever run (ADMIN-HIGH-013).
 *
 * Names are code constants and must be unique within a process: two methods
 * sharing a name would share one advisory lock and one heartbeat series, and
 * one of them would then read as "never ran". Re-decorating the same method
 * (a module re-evaluated under a test runner) is idempotent.
 */
const NAME_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

const registry = new Map<string, string>();

export function registerScheduledJobName(name: string, owner: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `@ScheduledJob name '${name}' on ${owner} must be lower-case words joined by '-' or '.'`,
    );
  }
  const existing = registry.get(name);
  if (existing !== undefined && existing !== owner) {
    throw new Error(`@ScheduledJob name '${name}' is declared by both ${existing} and ${owner}`);
  }
  registry.set(name, owner);
}

export function registeredScheduledJobNames(): readonly string[] {
  return [...registry.keys()].sort();
}

/** Tests only — a spec that declares fixture classes must not leak names into the next spec. */
export function clearScheduledJobRegistry(): void {
  registry.clear();
}
