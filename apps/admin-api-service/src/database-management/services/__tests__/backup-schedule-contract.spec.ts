/**
 * APA-321 contract guard: GET /database/backups/schedule returns the
 * BackupScheduleStatus SSoT shape (daily/weekly enabled + next/last per cadence).
 * The admin-panel had hand-mirrored an unrelated `{ enabled, schedule, lastRun,
 * nextRun }` literal — none of those keys exist on the wire — so the Backup
 * Schedule card always rendered "Not configured" + a "suspended" badge. This
 * freezes the backend key set so a future rename fails CI instead of silently
 * re-drifting the FE mirror.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/database-mgmt.md#APA-321
 */
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  RetiredSchemaBackup,
  SchemaBackup,
  SchemaRestore,
  TenantSchema,
} from '../../entities/database-management.entity';
import { BackupRestoreService } from '../backup-restore.service';

describe('BackupRestoreService.getBackupScheduleStatus contract (APA-321)', () => {
  it('returns the daily/weekly wire shape and no legacy enabled/schedule/lastRun/nextRun keys', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupRestoreService,
        { provide: getRepositoryToken(TenantSchema), useValue: {} },
        {
          provide: getRepositoryToken(SchemaBackup),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(RetiredSchemaBackup), useValue: {} },
        { provide: getRepositoryToken(SchemaRestore), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    const service = moduleRef.get(BackupRestoreService);
    const result = await service.getBackupScheduleStatus();

    expect(Object.keys(result).sort()).toEqual([
      'dailyBackupEnabled',
      'lastDailyBackup',
      'lastWeeklyBackup',
      'nextDailyBackup',
      'nextWeeklyBackup',
      'weeklyBackupEnabled',
    ]);
    for (const legacyKey of ['enabled', 'schedule', 'lastRun', 'nextRun']) {
      expect(Object.keys(result)).not.toContain(legacyKey);
    }
  });
});
