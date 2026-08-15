#!/usr/bin/env ts-node

import {
  SOURCE_INVENTORY_FULL_EXECUTION_INTENT_V1,
  runCapabilitySourceInventoryCli,
} from './capability-source-inventory';

/**
 * Closed full-inventory entrypoint. This wrapper declares full-execution intent; it cannot attest
 * itself. The compiler independently proves that the checkout is clean and its Git common-dir is
 * outside every governed source common-dir before any execution ref may be excluded. This file
 * carries no mutation, cleanup, or retirement API.
 */
async function main(): Promise<void> {
  process.env.CAPABILITY_INVENTORY_FULL_EXECUTION_INTENT =
    SOURCE_INVENTORY_FULL_EXECUTION_INTENT_V1;
  await runCapabilitySourceInventoryCli(process.argv.slice(2));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`source-inventory-runner: unexpected failure: ${message}\n`);
    process.exit(1);
  });
}
