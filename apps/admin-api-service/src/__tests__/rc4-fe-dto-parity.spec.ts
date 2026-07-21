/**
 * Phase-1 RC-4 gate — "FE sends a payload/param the backend does not accept, so
 * the write 400s / 404s / silently no-ops".
 *
 * With the global ValidationPipe (whitelist + forbidNonWhitelisted + transform)
 * engaged post-RC-2, any body key the DTO does not whitelist is a hard 400.
 * This spec locks the FE↔DTO contract for every RC-4 endpoint so the class
 * cannot silently recur:
 *
 *   Part A (write-body DTOs, real ValidationPipe):
 *     APA-049  POST /users/invite            InviteUserRequestDto
 *     APA-266  POST /system/settings/maintenance   CreateMaintenanceDto
 *     APA-261  PUT  /system/settings/feature-toggles/:id  UpdateFeatureToggleDto
 *     APA-314  POST /database/backups         CreateBackupDto
 *   For each: the EXACT key set the admin-panel api-layer sends is accepted
 *   (no forbidNonWhitelisted 400), and the previously-broken/actor field is
 *   still rejected (so it can never be re-whitelisted).
 *
 *   Part B (query-param / route-param drifts, FE source):
 *     APA-271  GET /system/performance/*      start/end → startDate/endDate
 *     APA-290  POST /impersonation/permissions/:superAdminId/revoke
 *   These are not body-whitelist failures, so they are pinned by asserting the
 *   admin-panel api-layer emits the canonical identifiers the backend reads.
 *
 * The FE key sets below are read verbatim from web/modules/admin-panel/src (the
 * handlers cited in each assertion) — the same source the RC-4 fix touched.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { INVITABLE_ROLE_CODES } from '@platform/event-contracts';

import { CreateBackupDto } from '../database-management/controllers/backup.controller';
import { FeatureToggleScope } from '../system-management/entities/feature-toggle.entity';
import {
  MaintenanceScope,
  MaintenanceType,
} from '../system-management/entities/maintenance-mode.entity';
import {
  CreateMaintenanceDto,
  UpdateFeatureToggleDto,
} from '../system-management/controllers/global-settings.controller';
import { InviteUserRequestDto } from '../users/users.controller';

// Mirrors libs/backend-common/src/bootstrap/create-service-app.ts configureValidationPipe.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const bodyMeta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
  data: '',
});

const ADMIN_PANEL_SRC = resolve(__dirname, '../../../../web/modules/admin-panel/src');
const readFe = (relPath: string): string =>
  readFileSync(resolve(ADMIN_PANEL_SRC, relPath), 'utf-8');

describe('RC-4 — FE payload/param ↔ backend contract parity', () => {
  describe('APA-049 — InviteUserRequestDto (POST /users/invite)', () => {
    // UserManagementPage.handleInviteUser → usersApi.invite sends exactly:
    const feInvitePayload = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      email: 'new.user@example.com',
      firstName: 'New',
      lastName: 'User',
      role: INVITABLE_ROLE_CODES[0],
      message: 'Welcome aboard',
    };

    it('accepts the exact FE invite payload (no createdBy/invitedBy)', async () => {
      const result = await pipe.transform(feInvitePayload, bodyMeta(InviteUserRequestDto));
      expect(result).toBeInstanceOf(InviteUserRequestDto);
    });

    it('rejects a client-asserted invitedBy actor field (locks it out of the DTO)', async () => {
      await expect(
        pipe.transform(
          { ...feInvitePayload, invitedBy: 'system' },
          bodyMeta(InviteUserRequestDto),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('APA-266 — CreateMaintenanceDto (POST /system/settings/maintenance)', () => {
    // MaintenancePage.handleCreate → createMaintenanceWindow sends exactly:
    const feMaintenancePayload = {
      title: 'Nightly patch',
      description: 'Rolling security patch',
      scope: MaintenanceScope.GLOBAL,
      type: MaintenanceType.SCHEDULED,
      scheduledStart: '2026-08-01T02:00:00.000Z',
      scheduledEnd: '2026-08-01T03:00:00.000Z',
      userMessage: 'Back soon',
      allowReadOnlyAccess: false,
      bypassForSuperAdmins: true,
      affectedServices: [],
    };

    it('accepts the exact FE maintenance payload (no createdBy)', async () => {
      const result = await pipe.transform(feMaintenancePayload, bodyMeta(CreateMaintenanceDto));
      expect(result).toBeInstanceOf(CreateMaintenanceDto);
    });

    it('rejects a client-asserted createdBy actor field (locks it out of the DTO)', async () => {
      await expect(
        pipe.transform(
          { ...feMaintenancePayload, createdBy: 'admin' },
          bodyMeta(CreateMaintenanceDto),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('APA-261 — UpdateFeatureToggleDto (PUT /system/settings/feature-toggles/:id)', () => {
    // FeatureTogglesPage.handleUpdate → updateFeatureToggle sends exactly:
    const feUpdatePayload = {
      name: 'Experimental widget',
      description: 'Ships behind a flag',
      scope: FeatureToggleScope.GLOBAL,
      category: 'ui',
      rolloutPercentage: 25,
      isExperimental: true,
    };

    it('accepts the exact FE edit payload incl. scope + isExperimental (was 400)', async () => {
      const result = await pipe.transform(feUpdatePayload, bodyMeta(UpdateFeatureToggleDto));
      expect(result).toBeInstanceOf(UpdateFeatureToggleDto);
    });

    it('keeps the whitelist strict — rejects an unknown field', async () => {
      await expect(
        pipe.transform({ ...feUpdatePayload, bogus: true }, bodyMeta(UpdateFeatureToggleDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps scope enum-bound — rejects an out-of-vocabulary scope', async () => {
      await expect(
        pipe.transform({ ...feUpdatePayload, scope: 'galaxy' }, bodyMeta(UpdateFeatureToggleDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('APA-314 — CreateBackupDto (POST /database/backups)', () => {
    // DatabaseManagementPage.handleCreateBackup → databaseApi.createBackup sends:
    const feBackupPayload = {
      backupType: 'full',
      compress: true,
      retentionDays: 30,
    };

    it('accepts the exact FE backup payload (no encrypt)', async () => {
      const result = await pipe.transform(feBackupPayload, bodyMeta(CreateBackupDto));
      expect(result).toBeInstanceOf(CreateBackupDto);
    });

    it('rejects an encrypt field — encryption is a mandatory server invariant', async () => {
      await expect(
        pipe.transform({ ...feBackupPayload, encrypt: false }, bodyMeta(CreateBackupDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('APA-271 — performance time-range emits the backend param names', () => {
    const settingsApi = readFe('services/api/settings.ts');

    it('getPerformanceDashboard/Metrics send startDate/endDate, not a bare start/end spread', () => {
      expect(settingsApi).toContain('startDate: timeRange?.start');
      expect(settingsApi).toContain('endDate: timeRange?.end');
      // the old silent-no-op spread (?start=&end=) must be gone
      expect(settingsApi).not.toContain('...timeRange');
    });
  });

  describe('APA-290 — revoke permission targets superAdminId, not the row id', () => {
    const impersonationPage = readFe('pages/system/ImpersonationPage.tsx');

    it('the revoke_permission action carries permission.superAdminId', () => {
      expect(impersonationPage).toContain('id: permission.superAdminId');
    });
  });
});
