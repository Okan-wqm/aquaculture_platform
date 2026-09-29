import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import {
  canonicalRegisteredNegativeControl,
  NegativeControlReasonCode,
} from '../src/kernel/negative-control-registry';
import { oracleBaselineRunContext } from '../src/kernel/oracle-baseline';
import type { OracleBaselineInput } from '../src/kernel/oracle-baseline';
import { isJsonRecord, requiredSha256, requiredText } from '../src/kernel/evidence-object';
import type { JsonValue } from '../src/kernel/strict-json';

import { verifierDossier } from './verifier-dossier-fixture';

export type { OracleBaselineInput } from '../src/kernel/oracle-baseline';

export interface OracleBaselineContext {
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly version: number;
  readonly observation_id: string;
  readonly observed_at: string;
  readonly claim: {
    readonly program_id: string;
    readonly sprint_id: string;
  };
  readonly freshness: {
    readonly observed_at: string;
    readonly valid_until: string;
  };
  readonly target: {
    readonly repository_id: string;
    readonly workspace_id: string;
    readonly base_sha: string;
    readonly head_sha: string;
  };
  readonly report: { readonly sha256: string };
  readonly artifacts: readonly object[];
  readonly verification_dossier?: Readonly<Record<string, JsonValue>>;
}

export interface NegativeControlFixture {
  readonly mutationKind: string;
  readonly reasonCode: NegativeControlReasonCode;
  readonly bytes: Uint8Array;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');

function dossierBindings(value: Readonly<Record<string, JsonValue>>) {
  const plan = value.plan;
  if (
    !isJsonRecord(plan) ||
    !isJsonRecord(plan.event_policy) ||
    !isJsonRecord(plan.freshness_policy)
  ) {
    throw new TypeError('oracle baseline verification plan is invalid');
  }
  return {
    plan,
    event_policy_sha256: requiredSha256(plan.event_policy.sha256, 'fixture event policy'),
    freshness_policy_sha256: requiredSha256(
      plan.freshness_policy.sha256,
      'fixture freshness policy',
    ),
    epoch_provider_id: requiredText(plan.epoch_provider_id, 'fixture epoch provider'),
    epoch_provider_identity_sha256: requiredSha256(
      plan.epoch_provider_identity_sha256,
      'fixture epoch provider identity',
    ),
  };
}

export function oracleBaselineInput(context: OracleBaselineContext): OracleBaselineInput {
  const dossier =
    context.verification_dossier ??
    verifierDossier({
      authority_sha256: context.authority_sha256,
      repository_id: context.target.repository_id,
      workspace_id: context.target.workspace_id,
      base_sha: context.target.base_sha,
      head_sha: context.target.head_sha,
      evidence_id: context.evidence_id,
      verification_time: context.freshness.observed_at,
      valid_until: context.freshness.valid_until,
    });
  const bindings = dossierBindings(dossier);
  const staticScope = {
    authority_sha256: context.authority_sha256,
    repository_id: context.target.repository_id,
    workspace_id: context.target.workspace_id,
    base_sha: context.target.base_sha,
    head_sha: context.target.head_sha,
    evidence_id: context.evidence_id,
    program_id: context.claim.program_id,
    sprint_id: context.claim.sprint_id,
    event_policy_sha256: bindings.event_policy_sha256,
    freshness_policy_sha256: bindings.freshness_policy_sha256,
    epoch_provider_id: bindings.epoch_provider_id,
    epoch_provider_identity_sha256: bindings.epoch_provider_identity_sha256,
    verification_plan_sha256: digest(bindings.plan),
  };
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-oracle-baseline-input-v4',
    run_context_sha256: oracleBaselineRunContext(staticScope),
    ...staticScope,
    verification_dossier: dossier,
  };
}

export const oracleBaselineBytes = (context: OracleBaselineContext): Uint8Array =>
  canonicalJsonBytes(oracleBaselineInput(context));

export function negativeControlFixture(
  id: string,
  index: number,
  baseline: OracleBaselineInput,
): NegativeControlFixture {
  const facts: Readonly<Record<string, readonly [string, NegativeControlReasonCode]>> = {
    'NC-S01-EVENT-HASH-TAMPER': ['EVENT-CONTEXT-PROBE-TAMPER', 'EVENT_CONTEXT_PROBE_MISMATCH'],
    'NC-S01-EVIDENCE-DIGEST-TAMPER': [
      'EVIDENCE-CONTEXT-PROBE-TAMPER',
      'EVIDENCE_CONTEXT_PROBE_MISMATCH',
    ],
    'NC-S01-STALE-EVIDENCE': ['STALE-EVIDENCE', 'FRESHNESS_CONTEXT_STALE'],
    'NC-S01-UNAUTHORIZED-TARGET': ['UNAUTHORIZED-TARGET', 'TARGET_HEAD_NOT_AUTHORIZED'],
  };
  const fact = facts[id];
  if (fact === undefined) {
    return {
      mutationKind: `UNREGISTERED-${(index + 1).toString()}`,
      reasonCode: 'EVENT_CONTEXT_PROBE_MISMATCH',
      bytes: Buffer.from(`${id}: unregistered mutant input\n`),
    };
  }
  const [mutationKind, reasonCode] = fact;
  return {
    mutationKind,
    reasonCode,
    bytes: canonicalRegisteredNegativeControl(index, id, mutationKind, baseline).bytes,
  };
}
