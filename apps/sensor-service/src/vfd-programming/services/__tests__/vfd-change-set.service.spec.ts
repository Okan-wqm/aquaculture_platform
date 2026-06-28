import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';

import { VfdChangeSetService } from '../vfd-change-set.service';
import { VfdParameterDefinitionService } from '../vfd-parameter-definition.service';
import { VfdDeviceService } from '../../../vfd/services/vfd-device.service';
import { RiskEvaluatorService } from '../../risk/risk-evaluator.service';
import { VfdChangeSet } from '../../entities/vfd-change-set.entity';
import { VfdChangeSetItem } from '../../entities/vfd-change-set-item.entity';
import { VfdParameterAuditLog } from '../../entities/vfd-parameter-audit-log.entity';
import { VfdParameterDefinition } from '../../entities/vfd-parameter-definition.entity';
import {
  VfdChangeSetStatus,
  VfdChangeSetItemStatus,
  VfdAuditAction,
  VfdBrand,
  VfdParameterGroup,
  RiskLevel,
} from '../../../vfd/entities/vfd.enums';
import { RiskAssessmentResult } from '../../risk/parameter-risk-rules';

// ─── MOCK FACTORIES ────────────────────────────────────────────────────

const TENANT_ID = 'tenant-001';
const DEVICE_ID = 'device-001';
const USER_MAKER = 'user-maker-001';
const USER_CHECKER = 'user-checker-002';

function createMockDefinition(
  overrides: Partial<VfdParameterDefinition> = {},
): VfdParameterDefinition {
  const def = new VfdParameterDefinition();
  def.id = overrides.id ?? 'def-001';
  def.brand = overrides.brand ?? VfdBrand.DANFOSS;
  def.parameterName = overrides.parameterName ?? 'accel_time_1';
  def.displayName = overrides.displayName ?? 'Acceleration Time 1';
  def.category = 'configuration';
  def.group = overrides.group ?? VfdParameterGroup.RAMP_TIMES;
  def.registerAddress = overrides.registerAddress ?? 3409;
  def.registerCount = 1;
  def.functionCode = 6;
  def.dataType = 'uint16';
  def.scalingFactor = 0.01;
  def.offset = 0;
  def.unit = 's';
  def.byteOrder = 'big';
  def.wordOrder = 'big';
  def.minValue = overrides.minValue ?? 0.05;
  def.maxValue = overrides.maxValue ?? 3600;
  def.defaultValue = 10;
  def.riskLevel = overrides.riskLevel ?? RiskLevel.MEDIUM;
  def.requiresMotorStop = overrides.requiresMotorStop ?? false;
  def.isReadable = true;
  def.isWritable = true;
  def.isActive = true;
  def.displayOrder = 0;
  def.createdAt = new Date();
  def.updatedAt = new Date();
  return def;
}

function createMockItem(
  overrides: Partial<VfdChangeSetItem> = {},
): VfdChangeSetItem {
  const item = new VfdChangeSetItem();
  item.id = overrides.id ?? 'item-001';
  item.changeSetId = overrides.changeSetId ?? 'cs-001';
  item.parameterDefinitionId = overrides.parameterDefinitionId ?? 'def-001';
  item.parameterName = overrides.parameterName ?? 'accel_time_1';
  item.previousValue = overrides.previousValue ?? 10;
  item.requestedValue = overrides.requestedValue ?? 5;
  item.status = overrides.status ?? VfdChangeSetItemStatus.PENDING;
  item.createdAt = new Date();
  return item;
}

function createMockChangeSet(
  overrides: Partial<VfdChangeSet> = {},
): VfdChangeSet {
  const cs = new VfdChangeSet();
  cs.id = overrides.id ?? 'cs-001';
  cs.tenantId = overrides.tenantId ?? TENANT_ID;
  cs.vfdDeviceId = overrides.vfdDeviceId ?? DEVICE_ID;
  cs.status = overrides.status ?? VfdChangeSetStatus.DRAFT;
  cs.description = overrides.description ?? 'Test change set';
  cs.createdBy = overrides.createdBy ?? USER_MAKER;
  cs.approvedBy = overrides.approvedBy;
  cs.rejectedBy = overrides.rejectedBy;
  cs.rejectionReason = overrides.rejectionReason;
  cs.scheduledAt = overrides.scheduledAt;
  cs.rollbackOfId = overrides.rollbackOfId;
  cs.metadata = overrides.metadata;
  cs.items = overrides.items ?? [];
  cs.createdAt = new Date();
  cs.updatedAt = new Date();
  return cs;
}

function createMockRiskResult(
  overrides: Partial<RiskAssessmentResult> = {},
): RiskAssessmentResult {
  return {
    riskLevel: overrides.riskLevel ?? (RiskLevel.MEDIUM as never),
    requiresMotorStop: overrides.requiresMotorStop ?? false,
    warnings: overrides.warnings ?? [],
    riskScore: overrides.riskScore ?? 40,
  };
}

// ─── REPOSITORY MOCK FACTORY ───────────────────────────────────────────

interface MockRepository {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  remove: jest.Mock;
}

function createMockRepository(): MockRepository {
  return {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
  };
}

// ─── TESTS ─────────────────────────────────────────────────────────────

describe('VfdChangeSetService', () => {
  let service: VfdChangeSetService;
  let changeSetRepo: MockRepository;
  let itemRepo: MockRepository;
  let auditRepo: MockRepository;
  let riskEvaluator: { evaluateRisk: jest.Mock; evaluateBatchRisk: jest.Mock };
  let paramDefService: {
    getDefinitionsForDevice: jest.Mock;
    findByParameterName: jest.Mock;
  };
  let deviceService: { findById: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(() => {
    changeSetRepo = createMockRepository();
    itemRepo = createMockRepository();
    auditRepo = createMockRepository();
    riskEvaluator = {
      evaluateRisk: jest.fn(),
      evaluateBatchRisk: jest.fn().mockReturnValue(createMockRiskResult()),
    };
    paramDefService = {
      getDefinitionsForDevice: jest.fn().mockResolvedValue([
        createMockDefinition(),
        createMockDefinition({
          id: 'def-002',
          parameterName: 'decel_time_1',
          displayName: 'Deceleration Time 1',
        }),
      ]),
      findByParameterName: jest.fn(),
    };
    deviceService = {
      findById: jest.fn().mockResolvedValue({
        id: DEVICE_ID,
        brand: VfdBrand.DANFOSS,
        tenantId: TENANT_ID,
      }),
    };
    eventEmitter = { emit: jest.fn() };

    service = new VfdChangeSetService(
      changeSetRepo as unknown as Repository<VfdChangeSet>,
      itemRepo as unknown as Repository<VfdChangeSetItem>,
      auditRepo as unknown as Repository<VfdParameterAuditLog>,
      riskEvaluator as unknown as RiskEvaluatorService,
      paramDefService as unknown as VfdParameterDefinitionService,
      deviceService as unknown as VfdDeviceService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  // ─── CREATE ────────────────────────────────────────────────────────

  describe('createChangeSet', () => {
    it('should create a change set in DRAFT status', async () => {
      const draft = createMockChangeSet();
      changeSetRepo.create!.mockReturnValue(draft);
      changeSetRepo.save!.mockResolvedValue(draft);

      const result = await service.createChangeSet(TENANT_ID, {
        vfdDeviceId: DEVICE_ID,
        description: 'Test change set',
      }, USER_MAKER);

      expect(result.status).toBe(VfdChangeSetStatus.DRAFT);
      expect(result.createdBy).toBe(USER_MAKER);
      expect(changeSetRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          vfdDeviceId: DEVICE_ID,
          status: VfdChangeSetStatus.DRAFT,
          createdBy: USER_MAKER,
        }),
      );
    });

    it('should create change set with initial items if provided', async () => {
      const draft = createMockChangeSet();
      const withItems = createMockChangeSet({
        items: [createMockItem()],
      });

      changeSetRepo.create!.mockReturnValue(draft);
      changeSetRepo.save!.mockResolvedValue(draft);
      // findByIdOrFail for addItems
      changeSetRepo.findOne!.mockResolvedValue(withItems);
      itemRepo.create!.mockReturnValue(createMockItem());
      itemRepo.save!.mockResolvedValue([createMockItem()]);

      const result = await service.createChangeSet(TENANT_ID, {
        vfdDeviceId: DEVICE_ID,
        description: 'Test',
        items: [{ parameterName: 'accel_time_1', requestedValue: 5 }],
      }, USER_MAKER);

      expect(result.items.length).toBe(1);
    });
  });

  // ─── ADD / REMOVE ITEMS ────────────────────────────────────────────

  describe('addItems', () => {
    it('should add items to a DRAFT change set', async () => {
      const draft = createMockChangeSet();
      const withItems = createMockChangeSet({
        items: [createMockItem()],
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(draft)  // findByIdOrFail
        .mockResolvedValueOnce(withItems); // return after save
      itemRepo.create!.mockReturnValue(createMockItem());
      itemRepo.save!.mockResolvedValue([createMockItem()]);

      const result = await service.addItems(
        'cs-001',
        [{ parameterName: 'accel_time_1', requestedValue: 5 }],
        TENANT_ID,
      );

      expect(result.items.length).toBe(1);
      expect(itemRepo.save).toHaveBeenCalled();
    });

    it('should reject adding items to non-DRAFT change set', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
      });
      changeSetRepo.findOne!.mockResolvedValue(pending);

      await expect(
        service.addItems(
          'cs-001',
          [{ parameterName: 'accel_time_1', requestedValue: 5 }],
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject unknown parameter names', async () => {
      const draft = createMockChangeSet();
      changeSetRepo.findOne!.mockResolvedValue(draft);

      // Return definitions that do not include the requested param
      paramDefService.getDefinitionsForDevice.mockResolvedValue([
        createMockDefinition({ parameterName: 'accel_time_1' }),
      ]);

      await expect(
        service.addItems(
          'cs-001',
          [{ parameterName: 'unknown_param', requestedValue: 5 }],
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject value below minimum', async () => {
      const draft = createMockChangeSet();
      changeSetRepo.findOne!.mockResolvedValue(draft);

      paramDefService.getDefinitionsForDevice.mockResolvedValue([
        createMockDefinition({ minValue: 1, maxValue: 100 }),
      ]);

      await expect(
        service.addItems(
          'cs-001',
          [{ parameterName: 'accel_time_1', requestedValue: 0.01 }],
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject value above maximum', async () => {
      const draft = createMockChangeSet();
      changeSetRepo.findOne!.mockResolvedValue(draft);

      paramDefService.getDefinitionsForDevice.mockResolvedValue([
        createMockDefinition({ minValue: 1, maxValue: 100 }),
      ]);

      await expect(
        service.addItems(
          'cs-001',
          [{ parameterName: 'accel_time_1', requestedValue: 999 }],
          TENANT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeItem', () => {
    it('should remove an item from a DRAFT change set', async () => {
      const item = createMockItem();
      const draft = createMockChangeSet({ items: [item] });
      const afterRemove = createMockChangeSet({ items: [] });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(afterRemove);
      itemRepo.findOne!.mockResolvedValue(item);
      itemRepo.remove!.mockResolvedValue(item);

      const result = await service.removeItem('cs-001', 'item-001', TENANT_ID);
      expect(result.items.length).toBe(0);
      expect(itemRepo.remove).toHaveBeenCalledWith(item);
    });

    it('should reject removing items from non-DRAFT change set', async () => {
      const applied = createMockChangeSet({
        status: VfdChangeSetStatus.APPLIED,
      });
      changeSetRepo.findOne!.mockResolvedValue(applied);

      await expect(
        service.removeItem('cs-001', 'item-001', TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── SUBMIT FOR APPROVAL ──────────────────────────────────────────

  describe('submitForApproval', () => {
    it('should submit a DRAFT change set with items', async () => {
      const draft = createMockChangeSet({
        items: [createMockItem()],
      });
      const pending = createMockChangeSet({
        ...draft,
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        items: [createMockItem()],
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(draft)  // findByIdOrFail
        .mockResolvedValueOnce(null);  // ensureNoActiveChangeSet
      changeSetRepo.save!.mockResolvedValue(pending);

      const result = await service.submitForApproval('cs-001', USER_MAKER, TENANT_ID);

      expect(result.status).toBe(VfdChangeSetStatus.PENDING_APPROVAL);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'vfd.changeset.pending',
        expect.objectContaining({
          changeSetId: 'cs-001',
          submittedBy: USER_MAKER,
        }),
      );
    });

    it('should throw when submitting with no items', async () => {
      const emptyDraft = createMockChangeSet({ items: [] });
      changeSetRepo.findOne!.mockResolvedValue(emptyDraft);

      await expect(
        service.submitForApproval('cs-001', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when submitting non-DRAFT change set', async () => {
      const approved = createMockChangeSet({
        status: VfdChangeSetStatus.APPROVED,
        items: [createMockItem()],
      });
      changeSetRepo.findOne!.mockResolvedValue(approved);

      await expect(
        service.submitForApproval('cs-001', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should include risk summary in metadata after submission', async () => {
      const riskResult = createMockRiskResult({
        riskLevel: RiskLevel.HIGH as never,
        riskScore: 70,
        warnings: ['High risk detected'],
      });
      riskEvaluator.evaluateBatchRisk.mockReturnValue(riskResult);

      const draft = createMockChangeSet({
        items: [createMockItem()],
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(null);

      let savedMetadata: Record<string, unknown> | undefined;
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => {
          savedMetadata = cs.metadata;
          return Promise.resolve(cs);
        },
      );

      await service.submitForApproval('cs-001', USER_MAKER, TENANT_ID);

      expect(savedMetadata).toHaveProperty('riskSummary');
      const summary = (savedMetadata as Record<string, Record<string, unknown>>)['riskSummary']!;
      expect(summary['riskLevel']).toBe(RiskLevel.HIGH);
      expect(summary['riskScore']).toBe(70);
    });
  });

  // ─── APPROVE (MAKER-CHECKER) ──────────────────────────────────────

  describe('approveChangeSet', () => {
    it('should approve when checker differs from maker', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
        items: [createMockItem()],
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(pending)  // findByIdOrFail
        .mockResolvedValueOnce(null);    // ensureNoActiveChangeSet
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      const result = await service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID);

      expect(result.status).toBe(VfdChangeSetStatus.APPROVED);
      expect(result.approvedBy).toBe(USER_CHECKER);
    });

    it('should throw ForbiddenException when maker === checker', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
      });
      changeSetRepo.findOne!.mockResolvedValue(pending);

      await expect(
        service.approveChangeSet('cs-001', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should emit vfd.changeset.approved when no scheduledAt', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
        scheduledAt: undefined,
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(null);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      await service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'vfd.changeset.approved',
        expect.objectContaining({
          changeSetId: 'cs-001',
          approvedBy: USER_CHECKER,
        }),
      );
    });

    it('should NOT emit approved event when scheduledAt is set', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
        scheduledAt: new Date('2026-04-01'),
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(null);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      await service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID);

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'vfd.changeset.approved',
        expect.anything(),
      );
    });

    it('should throw when approving non-PENDING_APPROVAL change set', async () => {
      const draft = createMockChangeSet({
        status: VfdChangeSetStatus.DRAFT,
      });
      changeSetRepo.findOne!.mockResolvedValue(draft);

      await expect(
        service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── CONCURRENT GUARD ─────────────────────────────────────────────

  describe('concurrent guard', () => {
    it('should throw ConflictException when another active change set exists', async () => {
      const pending = createMockChangeSet({
        id: 'cs-001',
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
        items: [createMockItem()],
      });

      const existingActive = createMockChangeSet({
        id: 'cs-other',
        status: VfdChangeSetStatus.APPROVED,
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(pending)   // findByIdOrFail
        .mockResolvedValueOnce(existingActive); // ensureNoActiveChangeSet

      await expect(
        service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('should allow approval when no other active change set exists', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(null); // no other active
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      const result = await service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID);
      expect(result.status).toBe(VfdChangeSetStatus.APPROVED);
    });
  });

  // ─── REJECT ───────────────────────────────────────────────────────

  describe('rejectChangeSet', () => {
    it('should reject a PENDING_APPROVAL change set with reason', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
      });

      changeSetRepo.findOne!.mockResolvedValue(pending);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      const result = await service.rejectChangeSet(
        'cs-001',
        USER_CHECKER,
        'Values too aggressive',
        TENANT_ID,
      );

      expect(result.status).toBe(VfdChangeSetStatus.REJECTED);
      expect(result.rejectedBy).toBe(USER_CHECKER);
      expect(result.rejectionReason).toBe('Values too aggressive');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'vfd.changeset.rejected',
        expect.objectContaining({
          changeSetId: 'cs-001',
          rejectedBy: USER_CHECKER,
          reason: 'Values too aggressive',
        }),
      );
    });

    it('should throw when rejecting non-PENDING_APPROVAL', async () => {
      const draft = createMockChangeSet({
        status: VfdChangeSetStatus.DRAFT,
      });
      changeSetRepo.findOne!.mockResolvedValue(draft);

      await expect(
        service.rejectChangeSet('cs-001', USER_CHECKER, 'reason', TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── CANCEL ───────────────────────────────────────────────────────

  describe('cancelChangeSet', () => {
    it('should cancel a DRAFT change set -> CANCELLED', async () => {
      const draft = createMockChangeSet({
        status: VfdChangeSetStatus.DRAFT,
      });

      changeSetRepo.findOne!.mockResolvedValue(draft);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      const result = await service.cancelChangeSet(
        'cs-001',
        USER_MAKER,
        TENANT_ID,
      );

      expect(result.status).toBe(VfdChangeSetStatus.CANCELLED);
      const cancellation = (result.metadata as Record<string, Record<string, unknown>>)['cancellation']!;
      expect(cancellation['cancelledBy']).toBe(USER_MAKER);
      expect(cancellation['reason']).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'vfd.changeset.cancelled',
        expect.objectContaining({
          changeSetId: 'cs-001',
          cancelledBy: USER_MAKER,
        }),
      );
    });

    it('should cancel an APPROVED change set -> CANCELLED with reason recorded', async () => {
      const approved = createMockChangeSet({
        status: VfdChangeSetStatus.APPROVED,
        approvedBy: USER_CHECKER,
        scheduledAt: new Date('2099-01-01'),
      });

      changeSetRepo.findOne!.mockResolvedValue(approved);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      const result = await service.cancelChangeSet(
        'cs-001',
        USER_CHECKER,
        TENANT_ID,
        'Schedule no longer needed',
      );

      expect(result.status).toBe(VfdChangeSetStatus.CANCELLED);
      const cancellation = (result.metadata as Record<string, Record<string, unknown>>)['cancellation']!;
      expect(cancellation['cancelledBy']).toBe(USER_CHECKER);
      expect(cancellation['reason']).toBe('Schedule no longer needed');
    });

    it('should reject cancelling a PENDING_APPROVAL change set', async () => {
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
      });
      changeSetRepo.findOne!.mockResolvedValue(pending);

      await expect(
        service.cancelChangeSet('cs-001', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject cancelling a REJECTED change set', async () => {
      const rejected = createMockChangeSet({
        status: VfdChangeSetStatus.REJECTED,
      });
      changeSetRepo.findOne!.mockResolvedValue(rejected);

      await expect(
        service.cancelChangeSet('cs-001', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject cancelling an APPLIED change set (rollback territory)', async () => {
      const applied = createMockChangeSet({
        status: VfdChangeSetStatus.APPLIED,
      });
      changeSetRepo.findOne!.mockResolvedValue(applied);

      await expect(
        service.cancelChangeSet('cs-001', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should scope the lookup to the tenant', async () => {
      const draft = createMockChangeSet({
        status: VfdChangeSetStatus.DRAFT,
      });
      changeSetRepo.findOne!.mockResolvedValue(draft);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      await service.cancelChangeSet('cs-001', USER_MAKER, TENANT_ID);

      expect(changeSetRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'cs-001', tenantId: TENANT_ID },
        relations: ['items'],
      });
    });

    it('should throw NotFoundException for a non-existent change set', async () => {
      changeSetRepo.findOne!.mockResolvedValue(null);

      await expect(
        service.cancelChangeSet('non-existent', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── ROLLBACK ─────────────────────────────────────────────────────

  describe('rollbackChangeSet', () => {
    const appliedItem = createMockItem({
      previousValue: 10,
      requestedValue: 5,
      status: VfdChangeSetItemStatus.APPLIED,
    });

    it('should create inverse change set with swapped values', async () => {
      const applied = createMockChangeSet({
        status: VfdChangeSetStatus.APPLIED,
        items: [appliedItem],
      });

      const rollbackCsWithItems = createMockChangeSet({
        id: 'cs-rollback',
        status: VfdChangeSetStatus.DRAFT,
        rollbackOfId: 'cs-001',
        items: [createMockItem({
          changeSetId: 'cs-rollback',
          previousValue: 5,
          requestedValue: 10,
        })],
      });

      const finalRollback = createMockChangeSet({
        id: 'cs-rollback',
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        rollbackOfId: 'cs-001',
        items: [createMockItem({ previousValue: 5, requestedValue: 10 })],
      });

      // Mock sequence:
      // 1. findByIdOrFail(original)
      // 2. findByIdOrFail(rollback) inside submitForApproval
      // 3. ensureNoActiveChangeSet -> findOne -> null
      // 4. findByIdOrFail(rollback) final return
      changeSetRepo.findOne!
        .mockResolvedValueOnce(applied)           // 1. original
        .mockResolvedValueOnce(rollbackCsWithItems) // 2. rollback in submitForApproval
        .mockResolvedValueOnce(null)               // 3. ensureNoActiveChangeSet
        .mockResolvedValueOnce(finalRollback);     // 4. final return

      const rollbackCs = createMockChangeSet({
        id: 'cs-rollback',
        status: VfdChangeSetStatus.DRAFT,
        rollbackOfId: 'cs-001',
      });

      changeSetRepo.create!.mockReturnValue(rollbackCs);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve({ ...cs, id: 'cs-rollback' } as VfdChangeSet),
      );

      let savedItems: VfdChangeSetItem[] = [];
      itemRepo.create!.mockImplementation(
        (data: Partial<VfdChangeSetItem>) => data as VfdChangeSetItem,
      );
      itemRepo.save!.mockImplementation(
        (items: VfdChangeSetItem[]) => {
          savedItems = items;
          return Promise.resolve(items);
        },
      );

      const result = await service.rollbackChangeSet(
        'cs-001',
        'parameter drift detected',
        USER_MAKER,
        TENANT_ID,
      );

      // Verify inverse item values
      expect(savedItems).toHaveLength(1);
      const firstItem = savedItems[0]!;
      expect(firstItem.previousValue).toBe(5);  // was requestedValue
      expect(firstItem.requestedValue).toBe(10); // was previousValue
    });

    it('should auto-approve emergency rollback', async () => {
      const applied = createMockChangeSet({
        status: VfdChangeSetStatus.APPLIED,
        items: [appliedItem],
      });

      changeSetRepo.findOne!.mockResolvedValueOnce(applied);

      const rollbackCs = createMockChangeSet({
        id: 'cs-emergency',
        status: VfdChangeSetStatus.DRAFT,
        rollbackOfId: 'cs-001',
      });

      changeSetRepo.create!.mockReturnValue(rollbackCs);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      itemRepo.create!.mockImplementation(
        (data: Partial<VfdChangeSetItem>) => data as VfdChangeSetItem,
      );
      itemRepo.save!.mockResolvedValue([]);
      auditRepo.create!.mockImplementation(
        (data: Partial<VfdParameterAuditLog>) => data as VfdParameterAuditLog,
      );
      auditRepo.save!.mockResolvedValue([]);

      // Final findByIdOrFail
      const finalRollback = createMockChangeSet({
        id: 'cs-emergency',
        status: VfdChangeSetStatus.APPROVED,
        approvedBy: USER_MAKER,
      });
      changeSetRepo.findOne!.mockResolvedValue(finalRollback);

      const result = await service.rollbackChangeSet(
        'cs-001',
        'emergency',
        USER_MAKER,
        TENANT_ID,
      );

      expect(result.status).toBe(VfdChangeSetStatus.APPROVED);
      expect(result.approvedBy).toBe(USER_MAKER);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'vfd.changeset.approved',
        expect.objectContaining({
          action: VfdAuditAction.EMERGENCY_OVERRIDE,
        }),
      );
    });

    it('should throw when rolling back non-APPLIED/VERIFIED', async () => {
      const draft = createMockChangeSet({
        status: VfdChangeSetStatus.DRAFT,
      });
      changeSetRepo.findOne!.mockResolvedValue(draft);

      await expect(
        service.rollbackChangeSet('cs-001', 'reason', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow rollback of VERIFIED change set', async () => {
      const verified = createMockChangeSet({
        status: VfdChangeSetStatus.VERIFIED,
        items: [appliedItem],
      });

      const rollbackCsWithItems = createMockChangeSet({
        id: 'cs-rollback-2',
        status: VfdChangeSetStatus.DRAFT,
        rollbackOfId: 'cs-001',
        items: [createMockItem({
          changeSetId: 'cs-rollback-2',
          previousValue: 5,
          requestedValue: 10,
        })],
      });

      const finalRollback = createMockChangeSet({
        id: 'cs-rollback-2',
        status: VfdChangeSetStatus.PENDING_APPROVAL,
      });

      // Mock sequence:
      // 1. findByIdOrFail(original) - verified
      // 2. findByIdOrFail(rollback) inside submitForApproval
      // 3. ensureNoActiveChangeSet -> null
      // 4. findByIdOrFail(rollback) final return
      changeSetRepo.findOne!
        .mockResolvedValueOnce(verified)
        .mockResolvedValueOnce(rollbackCsWithItems)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(finalRollback);

      const rollbackCs = createMockChangeSet({
        id: 'cs-rollback-2',
        status: VfdChangeSetStatus.DRAFT,
        rollbackOfId: 'cs-001',
      });

      changeSetRepo.create!.mockReturnValue(rollbackCs);
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );
      itemRepo.create!.mockImplementation(
        (data: Partial<VfdChangeSetItem>) => data as VfdChangeSetItem,
      );
      itemRepo.save!.mockResolvedValue([]);

      const result = await service.rollbackChangeSet(
        'cs-001',
        'parameter drift',
        USER_MAKER,
        TENANT_ID,
      );

      expect(changeSetRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ rollbackOfId: 'cs-001' }),
      );
    });
  });

  // ─── FULL LIFECYCLE ───────────────────────────────────────────────

  describe('full lifecycle: create -> addItems -> submit -> approve', () => {
    it('should transition through all workflow states', async () => {
      // 1. Create
      const draft = createMockChangeSet();
      changeSetRepo.create!.mockReturnValue(draft);
      changeSetRepo.save!.mockResolvedValue(draft);

      const created = await service.createChangeSet(TENANT_ID, {
        vfdDeviceId: DEVICE_ID,
        description: 'Full lifecycle test',
      }, USER_MAKER);
      expect(created.status).toBe(VfdChangeSetStatus.DRAFT);

      // 2. Add items
      const withItems = createMockChangeSet({
        items: [createMockItem()],
      });
      changeSetRepo.findOne!
        .mockResolvedValueOnce(draft)      // findByIdOrFail (addItems)
        .mockResolvedValueOnce(withItems); // return after save
      itemRepo.create!.mockReturnValue(createMockItem());
      itemRepo.save!.mockResolvedValue([createMockItem()]);

      const withItemsResult = await service.addItems(
        'cs-001',
        [{ parameterName: 'accel_time_1', requestedValue: 5 }],
        TENANT_ID,
      );
      expect(withItemsResult.items.length).toBe(1);

      // 3. Submit
      const draftWithItems = createMockChangeSet({
        items: [createMockItem()],
      });
      const pending = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        items: [createMockItem()],
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(draftWithItems) // findByIdOrFail
        .mockResolvedValueOnce(null);          // ensureNoActiveChangeSet
      changeSetRepo.save!.mockResolvedValue(pending);

      const submitted = await service.submitForApproval('cs-001', USER_MAKER, TENANT_ID);
      expect(submitted.status).toBe(VfdChangeSetStatus.PENDING_APPROVAL);

      // 4. Approve
      const pendingForApproval = createMockChangeSet({
        status: VfdChangeSetStatus.PENDING_APPROVAL,
        createdBy: USER_MAKER,
      });

      changeSetRepo.findOne!
        .mockResolvedValueOnce(pendingForApproval) // findByIdOrFail
        .mockResolvedValueOnce(null);              // ensureNoActiveChangeSet
      changeSetRepo.save!.mockImplementation(
        (cs: VfdChangeSet) => Promise.resolve(cs),
      );

      const approved = await service.approveChangeSet('cs-001', USER_CHECKER, TENANT_ID);
      expect(approved.status).toBe(VfdChangeSetStatus.APPROVED);
      expect(approved.approvedBy).toBe(USER_CHECKER);
    });
  });

  // ─── QUERIES ──────────────────────────────────────────────────────

  describe('findById', () => {
    it('should return change set with items', async () => {
      const cs = createMockChangeSet({ items: [createMockItem()] });
      changeSetRepo.findOne!.mockResolvedValue(cs);

      const result = await service.findById('cs-001', TENANT_ID);

      expect(result).toBeDefined();
      expect(result!.items.length).toBe(1);
      expect(changeSetRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'cs-001', tenantId: TENANT_ID },
        relations: ['items'],
      });
    });

    it('should return null for non-existent id', async () => {
      changeSetRepo.findOne!.mockResolvedValue(null);

      const result = await service.findById('non-existent', TENANT_ID);
      expect(result).toBeNull();
    });
  });

  describe('findByDevice', () => {
    it('should return paginated results', async () => {
      const items = [createMockChangeSet(), createMockChangeSet({ id: 'cs-002' })];
      changeSetRepo.findAndCount!.mockResolvedValue([items, 2]);

      const result = await service.findByDevice(TENANT_ID, DEVICE_ID);

      expect(result.items.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it('should filter by status when provided', async () => {
      changeSetRepo.findAndCount!.mockResolvedValue([[], 0]);

      await service.findByDevice(
        TENANT_ID,
        DEVICE_ID,
        VfdChangeSetStatus.PENDING_APPROVAL,
        10,
        0,
      );

      expect(changeSetRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: VfdChangeSetStatus.PENDING_APPROVAL,
          }),
          take: 10,
          skip: 0,
        }),
      );
    });

    it('should apply custom limit and offset', async () => {
      changeSetRepo.findAndCount!.mockResolvedValue([[], 0]);

      await service.findByDevice(TENANT_ID, DEVICE_ID, undefined, 5, 10);

      expect(changeSetRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 5,
          skip: 10,
        }),
      );
    });
  });

  describe('getPendingApprovalCount', () => {
    it('should return count of PENDING_APPROVAL change sets', async () => {
      changeSetRepo.count!.mockResolvedValue(3);

      const count = await service.getPendingApprovalCount(TENANT_ID);

      expect(count).toBe(3);
      expect(changeSetRepo.count).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          status: VfdChangeSetStatus.PENDING_APPROVAL,
        },
      });
    });
  });

  // ─── NOT FOUND ────────────────────────────────────────────────────

  describe('not found handling', () => {
    it('should throw NotFoundException for non-existent change set on approve', async () => {
      changeSetRepo.findOne!.mockResolvedValue(null);

      await expect(
        service.approveChangeSet('non-existent', USER_CHECKER, TENANT_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for non-existent change set on submit', async () => {
      changeSetRepo.findOne!.mockResolvedValue(null);

      await expect(
        service.submitForApproval('non-existent', USER_MAKER, TENANT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
