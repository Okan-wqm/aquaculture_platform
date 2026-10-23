import { Injectable } from '@nestjs/common';

import {
  contractTimestamp,
  type DeviceBinding,
  type EdgeUpdateStatement,
  type OsUpdateStatement,
  type SignedStatement,
  STATEMENT,
} from './edge-contract';
import { type BoardRow } from './edge-boards';
import {
  type AdmittedRelease,
  abiSupported,
  osVersionAtLeast,
} from './edge-release-catalog.service';
import { assertContractSchema } from './edge-statement-schemas';
import { UPDATE_CHANNEL } from './edge-update-channel';
import { ManifestSigner } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * The device-bound update statements the cloud signs (ADR-048 DEC-2.4, DEC-2.9,
 * DEC-23; contract 1.2.0): `suderra.edge-update.v1` (an agent release by statement
 * digest) and `suderra.os-update.v1` (a RAUC bundle by digest and size), signed with
 * the `edge-provisioning` key — the key of every statement that names a device's
 * binary or image. Each is bound to one tenant, one device and its committed hardware
 * binding, carries a monotonic per-device `update_seq` and a window that is the
 * maintenance window the operator chose, and states the local-approval and
 * outage-budget terms the root worker enforces.
 *
 * Producers, not verifiers. The root installer verifies each statement against its
 * own state and the agent only carries it (statements.json verified_by). What the
 * cloud adds is the floor a statement must clear before it is worth signing:
 *
 *   - the body is built from an {@link AdmittedRelease} (signature and provenance
 *     verified) or an operator-registered OS bundle, never from free-form fields;
 *   - the body satisfies the contract's own schema (edge-statement-schemas.ts), so
 *     an out-of-range outage budget or a `blockers_override` without its local
 *     approval cannot be signed;
 *   - the window can be delivered (channels.json update_channel.settlement:
 *     longer than the delivery margin, no longer than the agent keeps a spool
 *     entry) and carries whole seconds;
 *   - the release is for this device's board and arch, and the device's running OS
 *     is new enough for it — a statement root would refuse for a reason the cloud
 *     already knows is not issued.
 *
 * `update_seq` is allocated by the caller in the transaction that stores the
 * statement (the device's `edge_statement_seq`, one monotonic counter whose every
 * allocation is above every value signed before), and passed in.
 */

/** The device an update is for. */
export interface UpdateTarget {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The hardware binding committed at first activation (DEC-3.6). */
  readonly binding: DeviceBinding;
  readonly board: BoardRow;
}

/** The maintenance window the operator chose: where the statement is valid and delivered. */
export interface UpdateWindow {
  readonly notBefore: Date;
  readonly expiresAt: Date;
}

/** The terms root applies the update under (DEC-13.4). */
export interface UpdateTerms {
  /** Root applies the update only after a local operator approval. */
  readonly localApproval: boolean;
  /** An operator asked the update to ignore the gate's blockers; needs `localApproval`. */
  readonly blockersOverride: boolean;
  /** The longest outage, in seconds, from the shutdown safe-state to the first control tick. */
  readonly maxOutageSeconds: number;
}

/** A RAUC bundle an operator registered for one board's OS images. */
export interface OsBundle {
  /** The OS version the bundle installs (`/etc/os-release` VERSION_ID). */
  readonly version: string;
  /** The OS version the device's rollback floor becomes once the new slot is healthy. */
  readonly rollbackFloor: string;
  /** The running OS must be at least this version. */
  readonly minCurrentVersion: string;
  /** `MIN-MAX`: the agent ABI range the new OS publishes as SUDERRA_AGENT_ABI. */
  readonly supportedAgentAbi: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** What the cloud knows of the device's running state (its results carry `os_version`). */
export interface DeviceRunningState {
  /** The OS version the device last reported; null when it never reported one. */
  readonly osVersion: string | null;
  /** The ABI of the installed agent, when the caller resolved it; null when unknown. */
  readonly installedAgentAbi: number | null;
}

export interface EdgeUpdateInput {
  readonly target: UpdateTarget;
  readonly release: AdmittedRelease;
  readonly updateSeq: number;
  readonly window: UpdateWindow;
  readonly terms: UpdateTerms;
  readonly running: DeviceRunningState;
}

export interface OsUpdateInput {
  readonly target: UpdateTarget;
  readonly bundle: OsBundle;
  readonly updateSeq: number;
  readonly window: UpdateWindow;
  readonly terms: UpdateTerms;
  readonly running: DeviceRunningState;
}

/** An update the cloud will not sign, and why. Nothing was signed or stored. */
export class UpdateRefusedError extends Error {
  constructor(
    readonly reason: UpdateRefusal,
    detail: string,
  ) {
    super(`The update was not signed (${reason}): ${detail}`);
    this.name = 'UpdateRefusedError';
  }
}

export type UpdateRefusal =
  | 'window-invalid'
  | 'terms-invalid'
  | 'release-for-another-board'
  | 'os-version-too-old'
  | 'agent-abi-unsupported'
  | 'bundle-invalid'
  | 'policy-invalid'
  | 'files-invalid';

/** The window's rules before the statement exists (settlement.delivery_window, spool.max_entry_age). */
export function assertDeliverableWindow(window: UpdateWindow): void {
  const lengthMs = window.expiresAt.getTime() - window.notBefore.getTime();
  // contractTimestamp refuses a fractional second and an invalid instant.
  try {
    contractTimestamp(window.notBefore);
    contractTimestamp(window.expiresAt);
  } catch (error) {
    throw new UpdateRefusedError('window-invalid', (error as Error).message);
  }
  if (lengthMs <= UPDATE_CHANNEL.deliveryMarginSeconds * 1000) {
    throw new UpdateRefusedError(
      'window-invalid',
      `a window of ${lengthMs / 1000} s cannot be delivered: the cloud delivers only with ${UPDATE_CHANNEL.deliveryMarginSeconds} s left`,
    );
  }
  if (lengthMs > UPDATE_CHANNEL.maxWindowSeconds * 1000) {
    throw new UpdateRefusedError(
      'window-invalid',
      `a window of ${lengthMs / 1000} s outlives the ${UPDATE_CHANNEL.maxWindowSeconds} s the agent keeps a request`,
    );
  }
}

/** The terms' rules before the statement exists (a blockers override needs a person on site). */
export function assertUpdateTerms(terms: UpdateTerms): void {
  if (terms.blockersOverride && !terms.localApproval) {
    throw new UpdateRefusedError(
      'terms-invalid',
      'blockers_override is signed only together with local_approval: a person on site must stand behind it',
    );
  }
}

/** The update the statement describes, for an edge-update. Built, then held to the contract schema. */
export function buildEdgeUpdate(input: EdgeUpdateInput): EdgeUpdateStatement {
  const { target, release, terms, window } = input;
  assertDeliverableWindow(window);
  assertUpdateTerms(terms);
  if (release.boardProfile !== target.board.boardProfile || release.arch !== target.board.arch) {
    throw new UpdateRefusedError(
      'release-for-another-board',
      `release ${release.version} is for ${release.boardProfile}/${release.arch}, the device is ${target.board.boardProfile}/${target.board.arch}`,
    );
  }
  if (
    input.running.osVersion !== null &&
    !osVersionAtLeast(input.running.osVersion, release.minOsVersion)
  ) {
    throw new UpdateRefusedError(
      'os-version-too-old',
      `release ${release.version} needs OS ${release.minOsVersion}, the device runs ${input.running.osVersion}`,
    );
  }
  const statement: EdgeUpdateStatement = {
    _type: STATEMENT.edgeUpdate,
    tenant_id: target.tenantId,
    device_id: target.deviceId,
    device_binding: target.binding,
    board: target.board.boardProfile,
    arch: target.board.arch,
    agent_profile: target.board.agentProfile,
    version: release.version,
    security_version: release.securityVersion,
    update_seq: input.updateSeq,
    not_before: contractTimestamp(window.notBefore),
    expires_at: contractTimestamp(window.expiresAt),
    release_statement: { digest: release.digest, url: release.statementUrl },
    artifact_url: release.artifactUrl,
    local_approval: terms.localApproval,
    ...(terms.blockersOverride ? { blockers_override: true as const } : {}),
    max_outage_seconds: terms.maxOutageSeconds,
  };
  assertContractSchema('edge-update', statement);
  return statement;
}

/** The statement for an OS update: one registered bundle for one device. */
export function buildOsUpdate(input: OsUpdateInput): OsUpdateStatement {
  const { target, bundle, terms, window } = input;
  assertDeliverableWindow(window);
  assertUpdateTerms(terms);
  if (!osVersionAtLeast(bundle.version, bundle.rollbackFloor)) {
    // A floor above the installed version would forbid the very slot the update installs.
    throw new UpdateRefusedError(
      'bundle-invalid',
      `rollback_floor ${bundle.rollbackFloor} is above the version ${bundle.version} it installs`,
    );
  }
  if (
    input.running.osVersion !== null &&
    !osVersionAtLeast(input.running.osVersion, bundle.minCurrentVersion)
  ) {
    throw new UpdateRefusedError(
      'os-version-too-old',
      `the bundle needs OS ${bundle.minCurrentVersion}, the device runs ${input.running.osVersion}`,
    );
  }
  if (
    input.running.installedAgentAbi !== null &&
    !abiSupported(bundle.supportedAgentAbi, input.running.installedAgentAbi)
  ) {
    throw new UpdateRefusedError(
      'agent-abi-unsupported',
      `the installed agent's ABI ${input.running.installedAgentAbi} is outside the new OS's ${bundle.supportedAgentAbi}`,
    );
  }
  const statement: OsUpdateStatement = {
    _type: STATEMENT.osUpdate,
    tenant_id: target.tenantId,
    device_id: target.deviceId,
    device_binding: target.binding,
    version: bundle.version,
    compatible: target.board.raucCompatible,
    min_current_version: bundle.minCurrentVersion,
    rollback_floor: bundle.rollbackFloor,
    supported_agent_abi: bundle.supportedAgentAbi,
    update_seq: input.updateSeq,
    not_before: contractTimestamp(window.notBefore),
    expires_at: contractTimestamp(window.expiresAt),
    bundle: {
      url: bundle.url,
      digest: { sha256: bundle.sha256 },
      size_bytes: bundle.sizeBytes,
    },
    local_approval: terms.localApproval,
    ...(terms.blockersOverride ? { blockers_override: true as const } : {}),
    max_outage_seconds: terms.maxOutageSeconds,
  };
  assertContractSchema('os-update', statement);
  return statement;
}

@Injectable()
export class EdgeUpdateManifestService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  private signer(): ManifestSigner<'edge-provisioning'> {
    return new ManifestSigner(this.config.settings.keys.provisioning);
  }

  /** A signed agent update of one device to an admitted release. */
  signEdgeUpdate(input: EdgeUpdateInput): SignedStatement<typeof STATEMENT.edgeUpdate> {
    return this.signer().sign(STATEMENT.edgeUpdate, buildEdgeUpdate(input));
  }

  /** A signed OS update of one device to a registered bundle. */
  signOsUpdate(input: OsUpdateInput): SignedStatement<typeof STATEMENT.osUpdate> {
    return this.signer().sign(STATEMENT.osUpdate, buildOsUpdate(input));
  }
}
