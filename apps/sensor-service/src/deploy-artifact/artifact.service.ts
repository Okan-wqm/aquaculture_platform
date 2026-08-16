import { createHash } from 'crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import {
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';

import { DeployArtifact, DeployArtifactType } from './entities/deploy-artifact.entity';

export interface SnapshotInput {
  artifactType: DeployArtifactType;
  content: Record<string, unknown>;
  schemaVersion?: number;
  sourceEntityId?: string;
  sourceEntityVersion?: number;
  createdBy?: string;
}

/**
 * Canonical (key-sorted, recursive) JSON serialization so that content
 * addressing is independent of property insertion order. Arrays keep their
 * order — element order is semantically meaningful in deploy payloads.
 */
export function deployArtifactCanonicalJsonV1(value: unknown): string {
  return canonicalJsonStringify(createCanonicalJsonDocumentV1(value));
}

/** sha256 (hex) of the canonical JSON of `content`. */
export function contentSha256(content: Record<string, unknown>): string {
  return createHash('sha256').update(deployArtifactCanonicalJsonV1(content)).digest('hex');
}

/**
 * Content-addressed snapshot store for deploy artifacts. Append-only:
 * `snapshot()` either returns the existing row for identical content or
 * inserts a new one — it NEVER updates. Uniqueness is enforced by the DB
 * (`unique(tenant_id, content_sha256)`), so concurrent snapshots of the
 * same content race safely to a single row.
 */
@Injectable()
export class ArtifactService {
  private readonly logger = new Logger(ArtifactService.name);

  constructor(
    @InjectRepository(DeployArtifact)
    private readonly artifactRepository: Repository<DeployArtifact>,
  ) {}

  async snapshot(tenantId: string, input: SnapshotInput): Promise<DeployArtifact> {
    const sha = contentSha256(input.content);

    const existing = await this.artifactRepository.findOne({
      where: { tenantId, contentSha256: sha },
    });
    if (existing) return existing;

    const artifact = this.artifactRepository.create({
      tenantId,
      artifactType: input.artifactType,
      contentSha256: sha,
      content: input.content,
      schemaVersion: input.schemaVersion,
      sourceEntityId: input.sourceEntityId,
      sourceEntityVersion: input.sourceEntityVersion,
      createdBy: input.createdBy,
    });

    try {
      const saved = await this.artifactRepository.save(artifact);
      this.logger.log(
        `Snapshotted ${input.artifactType} artifact ${saved.id} (sha256 ${sha.slice(0, 12)}…) for tenant ${tenantId}`,
      );
      return saved;
    } catch (error) {
      // Unique-violation race: another writer snapshotted identical content
      // between our lookup and insert — converge on their row.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === '23505'
      ) {
        const winner = await this.artifactRepository.findOne({
          where: { tenantId, contentSha256: sha },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  async getById(tenantId: string, id: string): Promise<DeployArtifact> {
    const artifact = await this.artifactRepository.findOne({ where: { id, tenantId } });
    if (!artifact) {
      throw new NotFoundException(`Deploy artifact ${id} not found`);
    }
    return artifact;
  }
}
