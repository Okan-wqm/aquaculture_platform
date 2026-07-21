/**
 * Behavioural proof for Phase-1 RC-2: the global ValidationPipe now actually
 * runs on request bodies/queries that were previously interface-typed (metatype
 * Object → pipe skipped). Each case drives the SAME ValidationPipe options the
 * platform installs and asserts a malformed / unknown-field payload is rejected
 * (would surface as HTTP 400) where it previously flowed through unchecked, and
 * that a valid payload passes and transforms.
 *
 * Complements the static gate controller-dto-validation.architecture.spec.ts.
 */

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { RecordPaymentDto } from '../billing/dto/billing.dto';
import { CreateLegalHoldDto } from '../messaging/dto/create-legal-hold.dto';
import { AssignModuleDto } from '../modules/dto/module.dto';
import { QueryActivitiesDto } from '../security/controllers/activity-log.controller';
import { QueryAuditTrailDto } from '../security/controllers/audit-trail.controller';

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

const queryMeta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'query',
  metatype,
  data: '',
});

describe('RC-2 — global ValidationPipe engages on converted DTOs', () => {
  describe('AssignModuleDto (modules, APA-067/076)', () => {
    const valid = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      moduleId: '22222222-2222-4222-8222-222222222222',
      expiresAt: '2026-12-31T00:00:00.000Z',
    };

    it('accepts a valid body and keeps expiresAt an ISO string (no Date coercion)', async () => {
      const result = await pipe.transform(valid, bodyMeta(AssignModuleDto));
      expect(result).toBeInstanceOf(AssignModuleDto);
      expect(result.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    });

    it('rejects a non-UUID tenantId (was silently accepted as an interface DTO)', async () => {
      await expect(
        pipe.transform({ ...valid, tenantId: 'not-a-uuid' }, bodyMeta(AssignModuleDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown body field via forbidNonWhitelisted (e.g. spoofed assignedBy)', async () => {
      await expect(
        pipe.transform({ ...valid, assignedBy: 'attacker' }, bodyMeta(AssignModuleDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('RecordPaymentDto (billing, APA-094)', () => {
    const valid = {
      invoiceId: '33333333-3333-4333-8333-333333333333',
      amount: 100,
      paymentMethod: 'card',
    };

    it('accepts a valid body', async () => {
      const result = await pipe.transform(valid, bodyMeta(RecordPaymentDto));
      expect(result).toBeInstanceOf(RecordPaymentDto);
    });

    it('rejects a non-numeric amount', async () => {
      await expect(
        pipe.transform({ ...valid, amount: 'lots' }, bodyMeta(RecordPaymentDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown extra field', async () => {
      await expect(
        pipe.transform({ ...valid, actorId: 'spoof' }, bodyMeta(RecordPaymentDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CreateLegalHoldDto (messaging-admin, APA-179)', () => {
    const valid = {
      tenantId: '44444444-4444-4444-8444-444444444444',
      reason: 'Litigation hold for matter X',
      legalMatterId: 'MATTER-001',
    };

    it('accepts a valid body', async () => {
      const result = await pipe.transform(valid, bodyMeta(CreateLegalHoldDto));
      expect(result).toBeInstanceOf(CreateLegalHoldDto);
    });

    it('rejects a body missing the required reason', async () => {
      const { reason: _reason, ...withoutReason } = valid;
      await expect(
        pipe.transform(withoutReason, bodyMeta(CreateLegalHoldDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('sortBy ORDER-BY allowlist (security, APA-220/249)', () => {
    it('QueryActivitiesDto rejects an arbitrary sortBy column (SQL ORDER BY guard)', async () => {
      await expect(
        pipe.transform({ sortBy: 'id; DROP TABLE activity_logs' }, queryMeta(QueryActivitiesDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform({ sortBy: 'password' }, queryMeta(QueryActivitiesDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('QueryActivitiesDto accepts an allowlisted sortBy column', async () => {
      const result = await pipe.transform({ sortBy: 'createdAt' }, queryMeta(QueryActivitiesDto));
      expect(result.sortBy).toBe('createdAt');
    });

    it('QueryAuditTrailDto rejects an arbitrary sortBy column', async () => {
      await expect(
        pipe.transform({ sortBy: 'bogus' }, queryMeta(QueryAuditTrailDto)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('QueryAuditTrailDto accepts an allowlisted sortBy column', async () => {
      const result = await pipe.transform({ sortBy: 'severity' }, queryMeta(QueryAuditTrailDto));
      expect(result.sortBy).toBe('severity');
    });
  });
});
