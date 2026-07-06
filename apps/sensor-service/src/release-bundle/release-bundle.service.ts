import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import {
  ReleaseBundle,
  ReleaseBundleManifest,
  ReleaseBundleStatus,
} from './entities/release-bundle.entity';

/**
 * The ONLY legal state-machine edges (enterprise plan Faz 5). Every
 * status write in this service goes through `assertTransition`, so an
 * illegal edge (e.g. FAILED → CONFIRMED, or CONFIRMED → STAGED after a
 * duplicate ack) is structurally unreachable — pinned by
 * `__tests__/release-bundle-transitions.spec.ts`.
 */
const LEGAL_TRANSITIONS: Readonly<Record<ReleaseBundleStatus, readonly ReleaseBundleStatus[]>> = {
  [ReleaseBundleStatus.PENDING]: [ReleaseBundleStatus.STAGED, ReleaseBundleStatus.FAILED],
  [ReleaseBundleStatus.STAGED]: [ReleaseBundleStatus.CONFIRMED, ReleaseBundleStatus.FAILED],
  [ReleaseBundleStatus.CONFIRMED]: [ReleaseBundleStatus.ROLLED_BACK],
  [ReleaseBundleStatus.FAILED]: [],
  [ReleaseBundleStatus.ROLLED_BACK]: [],
};

export function isLegalBundleTransition(
  from: ReleaseBundleStatus,
  to: ReleaseBundleStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface CreateBundleInput {
  /** Row id — MUST equal manifest.bundleId (the signed value names the row). */
  bundleId: string;
  deviceId: string;
  commandId: string;
  manifest: ReleaseBundleManifest;
  manifestSha256: string;
  signature?: string;
  previousBundleId?: string;
  createdBy?: string;
}

@Injectable()
export class ReleaseBundleService {
  private readonly logger = new Logger(ReleaseBundleService.name);

  constructor(
    @InjectRepository(ReleaseBundle)
    private readonly bundleRepository: Repository<ReleaseBundle>,
  ) {}

  /**
   * Insert the PENDING bundle row. MUST be called with the transaction
   * manager that also enqueues the outbox event — a crash between the
   * two cannot leave a bundle without its dispatch event (or vice
   * versa).
   */
  async createPending(
    tenantId: string,
    input: CreateBundleInput,
    manager: EntityManager,
  ): Promise<ReleaseBundle> {
    if (input.manifest.bundleId !== input.bundleId) {
      throw new BadRequestException(
        `Manifest bundleId ${input.manifest.bundleId} does not name the bundle row ${input.bundleId}`,
      );
    }
    const bundle = manager.create(ReleaseBundle, {
      id: input.bundleId,
      tenantId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      signature: input.signature,
      previousBundleId: input.previousBundleId,
      createdBy: input.createdBy,
      status: ReleaseBundleStatus.PENDING,
    });
    return manager.save(bundle);
  }

  async getById(tenantId: string, id: string): Promise<ReleaseBundle> {
    const bundle = await this.bundleRepository.findOne({ where: { id, tenantId } });
    if (!bundle) throw new NotFoundException(`Release bundle ${id} not found`);
    return bundle;
  }

  async findByCommandId(tenantId: string, commandId: string): Promise<ReleaseBundle | null> {
    return this.bundleRepository.findOne({ where: { tenantId, commandId } });
  }

  /** The device's most recent CONFIRMED bundle (rollback anchor for the next build). */
  async findLastConfirmed(tenantId: string, deviceId: string): Promise<ReleaseBundle | null> {
    return this.bundleRepository.findOne({
      where: { tenantId, deviceId, status: ReleaseBundleStatus.CONFIRMED },
      order: { confirmedAt: 'DESC' },
    });
  }

  async markStaged(tenantId: string, commandId: string): Promise<ReleaseBundle> {
    return this.transition(tenantId, commandId, ReleaseBundleStatus.STAGED, (bundle) => {
      bundle.stagedAt = new Date();
    });
  }

  async markConfirmed(tenantId: string, commandId: string): Promise<ReleaseBundle> {
    return this.transition(tenantId, commandId, ReleaseBundleStatus.CONFIRMED, (bundle) => {
      bundle.confirmedAt = new Date();
    });
  }

  async markFailed(
    tenantId: string,
    commandId: string,
    errorMessage?: string,
  ): Promise<ReleaseBundle> {
    return this.transition(tenantId, commandId, ReleaseBundleStatus.FAILED, (bundle) => {
      bundle.failedAt = new Date();
      bundle.errorMessage = errorMessage;
    });
  }

  /** Called when a LATER bundle supersedes this one via rollback republish. */
  async markRolledBack(tenantId: string, bundleId: string): Promise<ReleaseBundle> {
    const bundle = await this.getById(tenantId, bundleId);
    this.assertTransition(bundle, ReleaseBundleStatus.ROLLED_BACK);
    bundle.status = ReleaseBundleStatus.ROLLED_BACK;
    return this.bundleRepository.save(bundle);
  }

  private async transition(
    tenantId: string,
    commandId: string,
    to: ReleaseBundleStatus,
    apply: (bundle: ReleaseBundle) => void,
  ): Promise<ReleaseBundle> {
    const bundle = await this.findByCommandId(tenantId, commandId);
    if (!bundle) {
      throw new NotFoundException(`No release bundle for command ${commandId}`);
    }
    this.assertTransition(bundle, to);
    bundle.status = to;
    apply(bundle);
    const saved = await this.bundleRepository.save(bundle);
    this.logger.log(
      `Release bundle ${bundle.id} (device ${bundle.deviceId}) → ${to}` +
        (saved.errorMessage ? `: ${saved.errorMessage}` : ''),
    );
    return saved;
  }

  private assertTransition(bundle: ReleaseBundle, to: ReleaseBundleStatus): void {
    if (!isLegalBundleTransition(bundle.status, to)) {
      throw new BadRequestException(
        `Illegal release-bundle transition ${bundle.status} → ${to} (bundle ${bundle.id})`,
      );
    }
  }
}
