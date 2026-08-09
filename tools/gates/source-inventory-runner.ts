#!/usr/bin/env ts-node

import {
  SOURCE_INVENTORY_RUNNER_PROFILE,
  runCapabilitySourceInventoryCli,
} from './capability-source-inventory';

/**
 * Closed full-inventory entrypoint. The compiler independently proves that this checkout is a
 * clean commit and that its Git common-dir is not one of the governed source common-dirs before
 * any execution ref may be excluded. This file carries no mutation, cleanup, or retirement API.
 */
async function main(): Promise<void> {
  process.env.CAPABILITY_INVENTORY_RUNNER_PROFILE = SOURCE_INVENTORY_RUNNER_PROFILE;
  await runCapabilitySourceInventoryCli(process.argv.slice(2));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`source-inventory-runner: unexpected failure: ${message}\n`);
    process.exit(1);
  });
}
