import { Injectable } from '@nestjs/common';

import {
  contractTimestamp,
  type InterfaceRole,
  type OtRule,
  type SignedStatement,
  type SiteNetpolicyStatement,
  STATEMENT,
  type TimeSource,
} from './edge-contract';
import { assertContractSchema, ContractSchemaError } from './edge-statement-schemas';
import {
  assertDeliverableWindow,
  UpdateRefusedError,
  type UpdateTarget,
  type UpdateWindow,
} from './edge-update-manifest.service';
import { ManifestSigner } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * The signed per-site network policy (ADR-048 DEC-11.6, DEC-11.7): the site's OT
 * allowlist, its interface role mapping and its site NTP servers, signed with the
 * `config-integrity` key, device-bound and tenant-bound, and carried to the device on
 * the update channel under its own `update_seq` (a policy change never needs a
 * re-provisioning).
 *
 * The cloud signs only a policy root would accept as far as the cloud can know:
 *
 *   - the body satisfies the contract's own JSON Schema (limits, patterns, the `wide`
 *     flag that goes with a prefix shorter than /16, plain NTP only with its mark);
 *   - the constraints the schema cannot state, which every verifier reports as
 *     `schema-invalid`: the host bits of every `dst` are zero, every port range has
 *     `from <= to`, rule ids, time source ids and time source hosts are unique, and an
 *     interface match value appears once.
 *
 * What the cloud cannot check is whether the mapping leaves the device a `wan`
 * interface, or whether two entries match one interface (`interface-mapping-invalid`):
 * both need the device's own interface list, so root decides them and a refusal comes
 * back as a result.
 */

/** The operator's policy: the three members the contract names, in the contract's own form. */
export interface NetpolicyBody {
  readonly interfaces: readonly InterfaceRole[];
  readonly ot_rules: readonly OtRule[];
  readonly time_sources: readonly TimeSource[];
}

export interface SiteNetpolicyInput {
  readonly target: Pick<UpdateTarget, 'tenantId' | 'deviceId' | 'binding'>;
  readonly updateSeq: number;
  readonly window: UpdateWindow;
  readonly policy: NetpolicyBody;
}

const PROBE = {
  _type: STATEMENT.siteNetpolicy,
  tenant_id: '00000000-0000-4000-8000-000000000000',
  device_id: '00000000-0000-4000-8000-000000000000',
  device_binding: { method: 'tpm-ek-sha256', digest: { sha256: '0'.repeat(64) } },
  update_seq: 1,
  not_before: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-02T00:00:00Z',
} as const;

/**
 * Whether `value` is a policy body the contract's schema admits: exactly the three members
 * `interfaces`, `ot_rules` and `time_sources`, each as the schema states it (limits,
 * patterns, the `wide` flag, plain NTP only with its mark). It is how an operator's JSON,
 * or a stored recipe, becomes a {@link NetpolicyBody}: the members are checked by the
 * contract's own schema (inside a statement with placeholder identity), never cast.
 * The constraints the schema cannot state are checked when a statement is built.
 */
export function isNetpolicyBody(value: unknown): value is NetpolicyBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const members = Object.keys(value);
  if (members.length !== 3) return false;
  const probe = {
    ...PROBE,
    interfaces: Reflect.get(value, 'interfaces'),
    ot_rules: Reflect.get(value, 'ot_rules'),
    time_sources: Reflect.get(value, 'time_sources'),
  };
  try {
    assertContractSchema('site-netpolicy', probe);
    return true;
  } catch (error) {
    if (error instanceof ContractSchemaError) return false;
    throw error;
  }
}

/** A policy constraint the contract's schema cannot state and every verifier enforces. */
function refuse(detail: string): never {
  throw new UpdateRefusedError('policy-invalid', detail);
}

function ipv4(dotted: string): number {
  return dotted.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** The host bits of a CIDR are zero: 10.0.0.0/24, never 10.0.0.5/24. */
function hostBitsZero(cidr: string): boolean {
  const [address, length] = cidr.split('/');
  if (address === undefined || length === undefined) return false;
  const prefix = Number(length);
  const hostMask = prefix === 32 ? 0 : 2 ** (32 - prefix) - 1;
  return (ipv4(address) & hostMask) === 0;
}

function duplicate<T>(values: readonly T[]): T | undefined {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/** Throws {@link UpdateRefusedError} for a policy the contract's constraints refuse. */
export function assertNetpolicyConstraints(policy: NetpolicyBody): void {
  for (const rule of policy.ot_rules) {
    if (!hostBitsZero(rule.dst)) {
      refuse(`rule ${rule.id}: ${rule.dst} has host bits set`);
    }
    for (const range of rule.ports) {
      if (range.from > range.to) {
        refuse(`rule ${rule.id}: the port range ${range.from}-${range.to} is reversed`);
      }
    }
  }
  const ruleTwice = duplicate(policy.ot_rules.map((rule) => rule.id));
  if (ruleTwice !== undefined) refuse(`the rule id ${ruleTwice} is used twice`);
  const sourceTwice = duplicate(policy.time_sources.map((source) => source.id));
  if (sourceTwice !== undefined) refuse(`the time source id ${sourceTwice} is used twice`);
  const hostTwice = duplicate(policy.time_sources.map((source) => source.host));
  if (hostTwice !== undefined) refuse(`the time source host ${hostTwice} is used twice`);
  const matches = policy.interfaces.map((entry) => ('mac' in entry ? entry.mac : entry.pci_path));
  const matchedTwice = duplicate(matches);
  if (matchedTwice !== undefined) refuse(`the interface match ${matchedTwice} appears twice`);
}

/** The statement for a site policy of one device. Built, then held to the contract schema and constraints. */
export function buildSiteNetpolicy(input: SiteNetpolicyInput): SiteNetpolicyStatement {
  assertDeliverableWindow(input.window);
  assertNetpolicyConstraints(input.policy);
  const statement: SiteNetpolicyStatement = {
    _type: STATEMENT.siteNetpolicy,
    tenant_id: input.target.tenantId,
    device_id: input.target.deviceId,
    device_binding: input.target.binding,
    update_seq: input.updateSeq,
    not_before: contractTimestamp(input.window.notBefore),
    expires_at: contractTimestamp(input.window.expiresAt),
    interfaces: input.policy.interfaces,
    ot_rules: input.policy.ot_rules,
    time_sources: input.policy.time_sources,
  };
  assertContractSchema('site-netpolicy', statement);
  return statement;
}

@Injectable()
export class SiteNetpolicyManifestService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  /** A signed site policy of one device. */
  sign(input: SiteNetpolicyInput): SignedStatement<typeof STATEMENT.siteNetpolicy> {
    return new ManifestSigner(this.config.settings.keys.configIntegrity).sign(
      STATEMENT.siteNetpolicy,
      buildSiteNetpolicy(input),
    );
  }
}
