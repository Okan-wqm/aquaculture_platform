import {
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_SCHEDULED_JOB_IDS,
  FEEDING_UTC_TIMEZONE,
  compileFeedingTimezone,
  feedingJobDefinition,
  type FeedingSchedulerCutV1,
  type ScheduledFeedingJobId,
} from '@aquaculture/feeding-contracts';
import { canonicalJsonSha256, createCanonicalJsonDocumentV1 } from '@aquaculture/shared-contracts';
import { Injectable, type ClassProvider } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  FEEDING_OPERATION_TARGET_COMPILER_PORT,
  type CompiledFeedingOperationTask,
  type CompiledFeedingSchedulerJobProjection,
  type CompiledFeedingSchedulerCut,
  type FeedingOperationTargetCompilerPort,
} from './feeding-operation-target-compiler.port';

interface CompiledTargetRow {
  readonly rowKind: string;
  readonly catalogJob: string | null;
  readonly jobTargetCount: number | null;
  readonly jobTargetRoot: string | null;
  readonly tenantId: string | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly timezone: string | null;
  readonly authorityGeneration: string | null;
  readonly catalogDigest: string;
  readonly catalogAdmissionGeneration: string;
  readonly timezoneSource: string | null;
  readonly targetSetDigest: string | null;
  readonly observedAt: Date;
  readonly cutDigest: string;
}

class FeedingOperationTargetCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedingOperationTargetCompilerError';
  }
}

/** Read-only projection through the scheduler role's exact compiler function. */
@Injectable()
export class FeedingOperationTargetCompilerService implements FeedingOperationTargetCompilerPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async compileCut(observedAt: Date): Promise<CompiledFeedingSchedulerCut> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const rows: CompiledTargetRow[] = await manager.query(
        `SELECT "rowKind", "catalogJob", "jobTargetCount", "jobTargetRoot",
                "tenantId"::text AS "tenantId", "targetKind",
                "targetId"::text AS "targetId", timezone,
                "authorityGeneration"::text AS "authorityGeneration",
                "catalogDigest",
                "catalogAdmissionGeneration"::text AS "catalogAdmissionGeneration",
                "timezoneSource", "targetSetDigest", "observedAt", "cutDigest"
           FROM farm.compile_feeding_scheduler_cut(
             $1::varchar, $2::varchar, $3::timestamptz
           )
          ORDER BY CASE "rowKind" WHEN 'job_projection' THEN 0 ELSE 1 END,
                   "catalogJob", "tenantId", "targetKind", "targetId" NULLS FIRST`,
        [FEEDING_JOB_CATALOG_REVISION, FEEDING_JOB_CATALOG_DIGEST, observedAt],
      );
      if (rows.length === 0) {
        throw new FeedingOperationTargetCompilerError(
          'Scheduler authority returned neither metadata nor targets',
        );
      }
      const cutDigests = new Set(rows.map((row) => row.cutDigest));
      if (cutDigests.size !== 1) {
        throw new FeedingOperationTargetCompilerError('Scheduler cut returned mixed root digests');
      }
      const projectionRows = rows.filter((row) => row.rowKind === 'job_projection');
      const taskRows = rows.filter(
        (
          row,
        ): row is CompiledTargetRow & {
          readonly catalogJob: string;
          readonly tenantId: string;
          readonly targetKind: string;
          readonly timezone: string;
          readonly authorityGeneration: string;
          readonly timezoneSource: string;
          readonly targetSetDigest: string;
        } =>
          row.rowKind === 'task' &&
          row.catalogJob !== null &&
          row.tenantId !== null &&
          row.targetKind !== null &&
          row.timezone !== null &&
          row.authorityGeneration !== null &&
          row.timezoneSource !== null &&
          row.targetSetDigest !== null,
      );
      if (taskRows.length + projectionRows.length !== rows.length) {
        throw new FeedingOperationTargetCompilerError(
          'Scheduler authority returned an unsupported cut row kind',
        );
      }
      const identities = new Set<string>();
      const taskCoordinates: Array<{
        catalogJob: string;
        tenantId: string;
        targetKind: string;
        targetId: string | null;
        timezone: string;
        authorityGeneration: number;
        catalogAdmissionGeneration: number;
        timezoneSource: string;
        targetSetDigest: string;
      }> = [];
      const tasks = taskRows.map((row): CompiledFeedingOperationTask => {
        const jobId = FEEDING_SCHEDULED_JOB_IDS.find(
          (candidate): candidate is ScheduledFeedingJobId => candidate === row.catalogJob,
        );
        if (!jobId) {
          throw new FeedingOperationTargetCompilerError(
            `Scheduler cut returned unknown job ${row.catalogJob}`,
          );
        }
        const definition = feedingJobDefinition(jobId);
        const timezone = compileFeedingTimezone(row.timezone);
        const authorityGeneration = Number.parseInt(row.authorityGeneration, 10);
        const catalogAdmissionGeneration = Number.parseInt(row.catalogAdmissionGeneration, 10);
        const identity = `${jobId}:${row.tenantId}:${row.targetKind}:${row.targetId ?? ''}`;
        if (
          identities.has(identity) ||
          !Number.isSafeInteger(authorityGeneration) ||
          authorityGeneration < 1 ||
          !Number.isSafeInteger(catalogAdmissionGeneration) ||
          catalogAdmissionGeneration < 1 ||
          row.catalogDigest !== FEEDING_JOB_CATALOG_DIGEST ||
          row.timezoneSource !== definition.timezoneSource ||
          !/^[0-9a-f]{64}$/.test(row.targetSetDigest) ||
          row.observedAt.toISOString() !== observedAt.toISOString()
        ) {
          throw new FeedingOperationTargetCompilerError(
            `Target ${identity} is duplicated or outside the requested authority cut`,
          );
        }
        identities.add(identity);
        taskCoordinates.push({
          catalogJob: jobId,
          tenantId: row.tenantId,
          targetKind: row.targetKind,
          targetId: row.targetId,
          timezone,
          authorityGeneration,
          catalogAdmissionGeneration,
          timezoneSource: row.timezoneSource,
          targetSetDigest: row.targetSetDigest,
        });
        const schedulerCut: FeedingSchedulerCutV1 = Object.freeze({
          schemaVersion: 'feeding-scheduler-cut/v1',
          observedAt,
          catalogRevision: FEEDING_JOB_CATALOG_REVISION,
          catalogDigest: row.catalogDigest,
          catalogAdmissionGeneration,
          authorityGeneration,
          timezoneSource: definition.timezoneSource,
          timezone,
          targetSetDigest: row.targetSetDigest,
          cutDigest: row.cutDigest,
        });
        if (definition.targetCardinality === 'tenant') {
          if (
            row.targetKind !== 'tenant' ||
            row.targetId !== null ||
            timezone !== FEEDING_UTC_TIMEZONE
          ) {
            throw new FeedingOperationTargetCompilerError(
              `Tenant job ${jobId} received malformed target ${identity}`,
            );
          }
          return Object.freeze({
            jobId,
            target: Object.freeze({
              tenantId: row.tenantId,
              targetKind: 'tenant' as const,
              targetId: null,
              timezone: FEEDING_UTC_TIMEZONE,
              schedulerCut,
            }),
          });
        }
        if (row.targetKind !== 'site' || !row.targetId || !row.timezone) {
          throw new FeedingOperationTargetCompilerError(
            `Site job ${jobId} received malformed target ${identity}`,
          );
        }
        return Object.freeze({
          jobId,
          target: Object.freeze({
            tenantId: row.tenantId,
            targetKind: 'site' as const,
            targetId: row.targetId,
              timezone,
            schedulerCut,
          }),
        });
      });
      const jobProjections = projectionRows.map((row): CompiledFeedingSchedulerJobProjection => {
        const jobId = FEEDING_SCHEDULED_JOB_IDS.find(
          (candidate): candidate is ScheduledFeedingJobId => candidate === row.catalogJob,
        );
        const catalogAdmissionGeneration = Number.parseInt(row.catalogAdmissionGeneration, 10);
        if (
          !jobId ||
          !Number.isSafeInteger(row.jobTargetCount) ||
          (row.jobTargetCount ?? -1) < 0 ||
          !row.jobTargetRoot ||
          !/^[0-9a-f]{64}$/.test(row.jobTargetRoot) ||
          row.tenantId !== null ||
          row.targetKind !== null ||
          row.targetId !== null ||
          row.timezone !== null ||
          row.authorityGeneration !== null ||
          row.timezoneSource !== null ||
          row.targetSetDigest !== null ||
          row.catalogDigest !== FEEDING_JOB_CATALOG_DIGEST ||
          !Number.isSafeInteger(catalogAdmissionGeneration) ||
          catalogAdmissionGeneration < 1 ||
          row.observedAt.toISOString() !== observedAt.toISOString()
        ) {
          throw new FeedingOperationTargetCompilerError(
            'Scheduler authority returned a malformed per-job target projection',
          );
        }
        const coordinates = taskCoordinates.filter((coordinate) => coordinate.catalogJob === jobId);
        const expectedRoot = canonicalJsonSha256(
          {
            domain: 'aquaculture.feeding-scheduler-job-target-projection',
            schemaVersion: 'feeding-scheduler-job-target-projection/v1',
          },
          createCanonicalJsonDocumentV1({ catalogJob: jobId, targets: coordinates }),
        );
        if (row.jobTargetCount !== coordinates.length || row.jobTargetRoot !== expectedRoot) {
          throw new FeedingOperationTargetCompilerError(
            `Scheduled job ${jobId} target projection disagrees with its immutable task set`,
          );
        }
        return Object.freeze({
          jobId,
          targetCount: row.jobTargetCount,
          targetRoot: row.jobTargetRoot,
        });
      });
      const expectedProjectionJobs = [...FEEDING_SCHEDULED_JOB_IDS].sort();
      if (
        jobProjections.length !== expectedProjectionJobs.length ||
        jobProjections.some(
          (projection, index) => projection.jobId !== expectedProjectionJobs[index],
        )
      ) {
        throw new FeedingOperationTargetCompilerError(
          'Scheduler per-job target projections are not set-equal to the scheduled catalog',
        );
      }
      const cutDigest = rows[0]?.cutDigest;
      if (
        !cutDigest ||
        cutDigest !==
          canonicalJsonSha256(
            {
              domain: 'aquaculture.feeding-scheduler-target-cut',
              schemaVersion: 'feeding-scheduler-target-cut/v1',
            },
            createCanonicalJsonDocumentV1({
              schemaVersion: 'feeding-scheduler-target-cut/v1',
              catalogRevision: FEEDING_JOB_CATALOG_REVISION,
              catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
              observedAt: observedAt.toISOString(),
              jobProjections: jobProjections.map((projection) => ({
                catalogJob: projection.jobId,
                jobTargetCount: projection.targetCount,
                jobTargetRoot: projection.targetRoot,
              })),
              tasks: taskCoordinates,
            }),
          )
      ) {
        throw new FeedingOperationTargetCompilerError(
          'Scheduler cut root digest does not match canonical task coordinates',
        );
      }
      return Object.freeze({
        schemaVersion: 'feeding-scheduler-target-cut/v1',
        observedAt,
        cutDigest,
        jobProjections: Object.freeze(jobProjections),
        tasks: Object.freeze(tasks),
      });
    });
  }
}

export const FEEDING_OPERATION_TARGET_COMPILER_PROVIDER: ClassProvider = {
  provide: FEEDING_OPERATION_TARGET_COMPILER_PORT,
  useClass: FeedingOperationTargetCompilerService,
};
