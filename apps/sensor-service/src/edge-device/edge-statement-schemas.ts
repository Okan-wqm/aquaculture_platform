import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

import commonSchema from '../../../../contracts/suderra-edge/v1/schemas/common.schema.json';
import dsseSchema from '../../../../contracts/suderra-edge/v1/schemas/dsse-envelope.schema.json';
import edgeUpdateSchema from '../../../../contracts/suderra-edge/v1/schemas/edge-update.schema.json';
import osUpdateSchema from '../../../../contracts/suderra-edge/v1/schemas/os-update.schema.json';
import siteBundleSchema from '../../../../contracts/suderra-edge/v1/schemas/site-bundle.schema.json';
import siteConfigSchema from '../../../../contracts/suderra-edge/v1/schemas/site-config.schema.json';
import siteNetpolicySchema from '../../../../contracts/suderra-edge/v1/schemas/site-netpolicy.schema.json';

/**
 * The contract's own JSON Schemas for the statements and documents the cloud
 * PRODUCES on the update channel (ADR-048 DEC-25), compiled once. A producer
 * validates the body it built against the schema before it signs it, so the
 * cloud cannot sign a statement the contract's schema refuses — an out-of-range
 * outage budget, a window the schema cannot read, a `blockers_override` without
 * its local approval — whatever a caller passed. The schemas are the contract's,
 * not copies: a bound changes in `contracts/suderra-edge/v1/schemas/` and here
 * at once.
 *
 * Validation is a floor, not the verifier: acceptance is decided by the root
 * installer and the agent against the device's own state (statements.json).
 */

const SCHEMAS = {
  'edge-update': edgeUpdateSchema,
  'os-update': osUpdateSchema,
  'site-config': siteConfigSchema,
  'site-netpolicy': siteNetpolicySchema,
  'site-bundle': siteBundleSchema,
} as const;

export type ProducedSchemaName = keyof typeof SCHEMAS;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
ajv.addSchema(commonSchema);
ajv.addSchema(dsseSchema);
for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);

const validators = new Map<ProducedSchemaName, ValidateFunction>(
  (
    Object.entries(SCHEMAS) as Array<[ProducedSchemaName, (typeof SCHEMAS)[ProducedSchemaName]]>
  ).map(([name, schema]) => {
    const compiled = ajv.getSchema(schema.$id);
    if (compiled === undefined) throw new Error(`${name}.schema.json did not compile`);
    return [name, compiled];
  }),
);

/** A body the contract's schema refuses; nothing was signed. */
export class ContractSchemaError extends Error {
  constructor(
    readonly schema: ProducedSchemaName,
    readonly reasons: readonly string[],
  ) {
    super(`the ${schema} body does not satisfy the contract schema: ${reasons.join('; ')}`);
    this.name = 'ContractSchemaError';
  }
}

/** Throws {@link ContractSchemaError} unless `body` satisfies the contract schema `name`. */
export function assertContractSchema(name: ProducedSchemaName, body: unknown): void {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`no validator for ${name}`);
  if (!validate(body)) {
    throw new ContractSchemaError(
      name,
      (validate.errors ?? []).map(
        (e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'is invalid'}`,
      ),
    );
  }
}
