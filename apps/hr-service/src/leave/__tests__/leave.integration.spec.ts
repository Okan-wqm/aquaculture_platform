/**
 * Leave Management Integration Tests
 *
 * End-to-end style tests for the leave request workflow.
 * Tests cover the complete lifecycle: draft -> submit -> approve/reject -> cancel
 * Includes event publishing verification and balance management.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventBus } from '@nestjs/cqrs';
import { Repository } from 'typeorm';

import { SubmitLeaveRequestHandler } from '../handlers/submit-leave-request.handler';
import { ApproveLeaveRequestHandler } from '../handlers/approve-leave-request.handler';
import { RejectLeaveRequestHandler } from '../handlers/reject-leave-request.handler';
import { CancelLeaveRequestHandler } from '../handlers/cancel-leave-request.handler';
import { SubmitLeaveRequestCommand } from '../commands/submit-leave-request.command';
import { ApproveLeaveRequestCommand } from '../commands/approve-leave-request.command';
import { RejectLeaveRequestCommand } from '../commands/reject-leave-request.command';
import { CancelLeaveRequestCommand } from '../commands/cancel-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import {
  LeaveRequestSubmittedEvent,
  LeaveApprovedEvent,
  LeaveRejectedEvent,
  LeaveCancelledEvent,
} from '../events/leave.events';

// ============================================================================
// Mock Factories
// ============================================================================

const createMockLeaveRequest = (overrides: Partial<LeaveRequest> = {}): LeaveRequest => {
  const request = new LeaveRequest();
  Object.assign(request, {
    id: 'leave-request-uuid-123',
    tenantId: 'tenant-uuid-456',
    requestNumber: 'LR-2025-00001',
    employeeId: 'employee-uuid-789',
    leaveTypeId: 'leave-type-annual',
    startDate: new Date('2025-02-01'),
    endDate: new Date('2025-02-05'),
    totalDays: 5,
    status: LeaveRequestStatus.DRAFT,
    reason: 'Annual vacation',
    approvalHistory: [],
    currentApprovalLevel: 1,
    createdBy: 'employee-uuid-789',
    updatedBy: 'employee-uuid-789',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    isDeleted: false,
    isHalfDayStart: false,
    isHalfDayEnd: false,
    ...overrides,
  });
  return request;
};

const createMockLeaveBalance = (overrides: Partial<LeaveBalance> = {}): LeaveBalance => {
  const balance = new LeaveBalance();
  Object.assign(balance, {
    id: 'balance-uuid-123',
    tenantId: 'tenant-uuid-456',
    employeeId: 'employee-uuid-789',
    leaveTypeId: 'leave-type-annual',
    year: 2025,
    entitled: 20,
    used: 5,
    pending: 0,
    remaining: 15,
    carryOver: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDeleted: false,
    ...overrides,
  });
  return balance;
};

const createMockRepository = <T>() => ({
  findOne: jest.fn(),
  find: jest.fn(),
  save: jest.fn((entity: T) => Promise.resolve(entity)),
  create: jest.fn((entity: Partial<T>) => entity as T),
  update: jest.fn(),
  delete: jest.fn(),
});

// ============================================================================
// Test Suite
// ============================================================================

describe('Leave Management Integration Tests', () => {
  let submitHandler: SubmitLeaveRequestHandler;
  let approveHandler: ApproveLeaveRequestHandler;
  let rejectHandler: RejectLeaveRequestHandler;
  let cancelHandler: CancelLeaveRequestHandler;

  let leaveRequestRepository: jest.Mocked<Repository<LeaveRequest>>;
  let leaveBalanceRepository: jest.Mocked<Repository<LeaveBalance>>;
  let eventBus: jest.Mocked<EventBus>;

  const tenantId = 'tenant-uuid-456';
  const employeeId = 'employee-uuid-789';
  const managerId = 'manager-uuid-111';

  beforeEach(async () => {
    leaveRequestRepository = createMockRepository<LeaveRequest>() as jest.Mocked<Repository<LeaveRequest>>;
    leaveBalanceRepository = createMockRepository<LeaveBalance>() as jest.Mocked<Repository<LeaveBalance>>;
    eventBus = {
      publish: jest.fn(),
    } as unknown as jest.Mocked<EventBus>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubmitLeaveRequestHandler,
        ApproveLeaveRequestHandler,
        RejectLeaveRequestHandler,
        CancelLeaveRequestHandler,
        {
          provide: getRepositoryToken(LeaveRequest),
          useValue: leaveRequestRepository,
        },
        {
          provide: getRepositoryToken(LeaveBalance),
          useValue: leaveBalanceRepository,
        },
        {
          provide: EventBus,
          useValue: eventBus,
        },
      ],
    }).compile();

    submitHandler = module.get<SubmitLeaveRequestHandler>(SubmitLeaveRequestHandler);
    approveHandler = module.get<ApproveLeaveRequestHandler>(ApproveLeaveRequestHandler);
    rejectHandler = module.get<RejectLeaveRequestHandler>(RejectLeaveRequestHandler);
    cancelHandler = module.get<CancelLeaveRequestHandler>(CancelLeaveRequestHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // Submit Leave Request Tests
  // ============================================================================

  describe('Submit Leave Request', () => {
    it('should successfully submit a draft leave request', async () => {
      const draftRequest = createMockLeaveRequest({ status: LeaveRequestStatus.DRAFT });
      const balance = createMockLeaveBalance();

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);
      leaveRequestRepository.save.mockImplementation((entity) =>
        Promise.resolve({ ...entity, status: LeaveRequestStatus.PENDING } as LeaveRequest)
      );
      leaveBalanceRepository.save.mockImplementation((entity) => Promise.resolve(entity));

      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      const result = await submitHandler.execute(command);

      expect(result.status).toBe(LeaveRequestStatus.PENDING);
      expect(leaveBalanceRepository.save).toHaveBeenCalled();
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(LeaveRequestSubmittedEvent));
    });

    it('should update pending balance when submitting', async () => {
      const draftRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.DRAFT,
        totalDays: 3,
      });
      const balance = createMockLeaveBalance({ pending: 0 });

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let savedBalance: LeaveBalance | null = null;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        savedBalance = entity as LeaveBalance;
        return Promise.resolve(entity);
      });

      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      await submitHandler.execute(command);

      expect(savedBalance).not.toBeNull();
      expect(savedBalance!.pending).toBe(3); // 0 + 3 days
    });

    it('should reject submission of non-draft request', async () => {
      const pendingRequest = createMockLeaveRequest({ status: LeaveRequestStatus.PENDING });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);

      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, pendingRequest.id);

      await expect(submitHandler.execute(command)).rejects.toThrow(
        /Cannot submit leave request with status/
      );
    });

    it('should reject submission by non-owner', async () => {
      const draftRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.DRAFT,
        employeeId: 'other-employee',
        createdBy: 'other-employee',
      });

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);

      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);

      await expect(submitHandler.execute(command)).rejects.toThrow(
        /You can only submit your own leave requests/
      );
    });

    it('should add approval history entry on submit', async () => {
      const draftRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.DRAFT,
        approvalHistory: [],
      });
      const balance = createMockLeaveBalance();

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let savedRequest: LeaveRequest | null = null;
      leaveRequestRepository.save.mockImplementation((entity) => {
        savedRequest = entity as LeaveRequest;
        return Promise.resolve(entity);
      });

      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      await submitHandler.execute(command);

      expect(savedRequest).not.toBeNull();
      expect(savedRequest!.approvalHistory).toHaveLength(1);
      expect(savedRequest!.approvalHistory![0].action).toBe('submitted');
      expect(savedRequest!.approvalHistory![0].actorId).toBe(employeeId);
    });
  });

  // ============================================================================
  // Approve Leave Request Tests
  // ============================================================================

  describe('Approve Leave Request', () => {
    it('should successfully approve a pending leave request', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ pending: 5, used: 0 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      const command = new ApproveLeaveRequestCommand(
        tenantId,
        managerId,
        pendingRequest.id,
        'Approved for annual leave'
      );
      const result = await approveHandler.execute(command);

      expect(result.status).toBe(LeaveRequestStatus.APPROVED);
      expect(result.approvedBy).toBe(managerId);
      expect(result.approvedAt).toBeDefined();
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(LeaveApprovedEvent));
    });

    it('should move pending balance to used on approval', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ pending: 5, used: 3 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let savedBalance: LeaveBalance | null = null;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        savedBalance = entity as LeaveBalance;
        return Promise.resolve(entity);
      });

      const command = new ApproveLeaveRequestCommand(tenantId, managerId, pendingRequest.id);
      await approveHandler.execute(command);

      expect(savedBalance).not.toBeNull();
      expect(savedBalance!.pending).toBe(0); // 5 - 5
      expect(savedBalance!.used).toBe(8); // 3 + 5
    });

    it('should reject self-approval', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        employeeId: managerId, // Same as approver
      });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);

      const command = new ApproveLeaveRequestCommand(tenantId, managerId, pendingRequest.id);

      await expect(approveHandler.execute(command)).rejects.toThrow(
        /You cannot approve your own leave request/
      );
    });

    it('should reject approval of non-pending request', async () => {
      const draftRequest = createMockLeaveRequest({ status: LeaveRequestStatus.DRAFT });

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);

      const command = new ApproveLeaveRequestCommand(tenantId, managerId, draftRequest.id);

      await expect(approveHandler.execute(command)).rejects.toThrow(
        /Cannot approve leave request with status/
      );
    });

    it('should add approval notes to history', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        approvalHistory: [{ action: 'submitted', actorId: employeeId, timestamp: new Date() }],
      });
      const balance = createMockLeaveBalance({ pending: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let savedRequest: LeaveRequest | null = null;
      leaveRequestRepository.save.mockImplementation((entity) => {
        savedRequest = entity as LeaveRequest;
        return Promise.resolve(entity);
      });

      const command = new ApproveLeaveRequestCommand(
        tenantId,
        managerId,
        pendingRequest.id,
        'Approved with conditions'
      );
      await approveHandler.execute(command);

      expect(savedRequest).not.toBeNull();
      expect(savedRequest!.approvalHistory).toHaveLength(2);
      expect(savedRequest!.approvalHistory![1].action).toBe('approved');
      expect(savedRequest!.approvalHistory![1].notes).toBe('Approved with conditions');
    });
  });

  // ============================================================================
  // Reject Leave Request Tests
  // ============================================================================

  describe('Reject Leave Request', () => {
    it('should successfully reject a pending leave request', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ pending: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      const command = new RejectLeaveRequestCommand(
        tenantId,
        managerId,
        pendingRequest.id,
        'Insufficient staffing during this period'
      );
      const result = await rejectHandler.execute(command);

      expect(result.status).toBe(LeaveRequestStatus.REJECTED);
      expect(result.rejectedBy).toBe(managerId);
      expect(result.rejectedAt).toBeDefined();
      expect(result.rejectionReason).toBe('Insufficient staffing during this period');
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(LeaveRejectedEvent));
    });

    it('should restore pending balance on rejection', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ pending: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let savedBalance: LeaveBalance | null = null;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        savedBalance = entity as LeaveBalance;
        return Promise.resolve(entity);
      });

      const command = new RejectLeaveRequestCommand(
        tenantId,
        managerId,
        pendingRequest.id,
        'Rejected'
      );
      await rejectHandler.execute(command);

      expect(savedBalance).not.toBeNull();
      expect(savedBalance!.pending).toBe(0); // 5 - 5 = 0
    });

    it('should reject self-rejection', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        employeeId: managerId,
      });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);

      const command = new RejectLeaveRequestCommand(
        tenantId,
        managerId,
        pendingRequest.id,
        'Rejected'
      );

      await expect(rejectHandler.execute(command)).rejects.toThrow(
        /You cannot reject your own leave request/
      );
    });
  });

  // ============================================================================
  // Cancel Leave Request Tests
  // ============================================================================

  describe('Cancel Leave Request', () => {
    it('should cancel a pending leave request', async () => {
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ pending: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      const command = new CancelLeaveRequestCommand(
        tenantId,
        employeeId,
        pendingRequest.id,
        'Plans changed'
      );
      const result = await cancelHandler.execute(command);

      expect(result.status).toBe(LeaveRequestStatus.CANCELLED);
      expect(result.cancelledBy).toBe(employeeId);
      expect(result.cancelledAt).toBeDefined();
      expect(result.cancellationReason).toBe('Plans changed');
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(LeaveCancelledEvent));
    });

    it('should cancel an approved leave request before start date', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 10); // 10 days in future

      const approvedRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.APPROVED,
        startDate: futureDate,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ used: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(approvedRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      const command = new CancelLeaveRequestCommand(
        tenantId,
        employeeId,
        approvedRequest.id,
        'Emergency'
      );
      const result = await cancelHandler.execute(command);

      expect(result.status).toBe(LeaveRequestStatus.CANCELLED);
    });

    it('should restore balance based on previous status', async () => {
      // Test cancelling pending request
      const pendingRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.PENDING,
        totalDays: 3,
      });
      const balance = createMockLeaveBalance({ pending: 3, used: 0 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let savedBalance: LeaveBalance | null = null;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        savedBalance = entity as LeaveBalance;
        return Promise.resolve(entity);
      });

      const command = new CancelLeaveRequestCommand(tenantId, employeeId, pendingRequest.id);
      await cancelHandler.execute(command);

      expect(savedBalance!.pending).toBe(0); // Restored from pending
    });

    it('should reject cancellation of already cancelled request', async () => {
      const cancelledRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.CANCELLED,
      });

      leaveRequestRepository.findOne.mockResolvedValue(cancelledRequest);

      const command = new CancelLeaveRequestCommand(tenantId, employeeId, cancelledRequest.id);

      await expect(cancelHandler.execute(command)).rejects.toThrow(
        /Cannot cancel leave request with status/
      );
    });

    it('should reject cancellation of started leave', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1); // Yesterday

      const approvedRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.APPROVED,
        startDate: pastDate,
      });

      leaveRequestRepository.findOne.mockResolvedValue(approvedRequest);

      const command = new CancelLeaveRequestCommand(tenantId, employeeId, approvedRequest.id);

      await expect(cancelHandler.execute(command)).rejects.toThrow(
        /Cannot cancel leave request that has already started/
      );
    });
  });

  // ============================================================================
  // E2E Workflow Tests
  // ============================================================================

  describe('E2E Leave Request Workflow', () => {
    it('should handle complete happy path: draft -> submit -> approve', async () => {
      // Step 1: Submit draft request
      const draftRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.DRAFT,
        totalDays: 5,
      });
      const balance = createMockLeaveBalance({ pending: 0, used: 0 });

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let currentRequest = draftRequest;
      leaveRequestRepository.save.mockImplementation((entity) => {
        currentRequest = { ...currentRequest, ...entity } as LeaveRequest;
        return Promise.resolve(currentRequest);
      });

      let currentBalance = balance;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        currentBalance = { ...currentBalance, ...entity } as LeaveBalance;
        return Promise.resolve(currentBalance);
      });

      // Submit
      const submitCommand = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      await submitHandler.execute(submitCommand);

      expect(currentRequest.status).toBe(LeaveRequestStatus.PENDING);
      expect(currentBalance.pending).toBe(5);
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(LeaveRequestSubmittedEvent));

      // Step 2: Approve the request
      leaveRequestRepository.findOne.mockResolvedValue(currentRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(currentBalance);

      const approveCommand = new ApproveLeaveRequestCommand(
        tenantId,
        managerId,
        currentRequest.id,
        'Approved'
      );
      await approveHandler.execute(approveCommand);

      expect(currentRequest.status).toBe(LeaveRequestStatus.APPROVED);
      expect(currentBalance.pending).toBe(0);
      expect(currentBalance.used).toBe(5);
      expect(eventBus.publish).toHaveBeenCalledWith(expect.any(LeaveApprovedEvent));
    });

    it('should handle rejection path: draft -> submit -> reject', async () => {
      const draftRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.DRAFT,
        totalDays: 3,
      });
      const balance = createMockLeaveBalance({ pending: 0, used: 0 });

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let currentRequest = draftRequest;
      leaveRequestRepository.save.mockImplementation((entity) => {
        currentRequest = { ...currentRequest, ...entity } as LeaveRequest;
        return Promise.resolve(currentRequest);
      });

      let currentBalance = balance;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        currentBalance = { ...currentBalance, ...entity } as LeaveBalance;
        return Promise.resolve(currentBalance);
      });

      // Submit
      await submitHandler.execute(
        new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id)
      );

      expect(currentBalance.pending).toBe(3);

      // Reject
      leaveRequestRepository.findOne.mockResolvedValue(currentRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(currentBalance);

      await rejectHandler.execute(
        new RejectLeaveRequestCommand(tenantId, managerId, currentRequest.id, 'Busy period')
      );

      expect(currentRequest.status).toBe(LeaveRequestStatus.REJECTED);
      expect(currentBalance.pending).toBe(0); // Balance restored
      expect(currentBalance.used).toBe(0);
    });

    it('should handle cancellation of approved request', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);

      const approvedRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.APPROVED,
        startDate: futureDate,
        totalDays: 5,
        approvedBy: managerId,
        approvedAt: new Date(),
      });
      const balance = createMockLeaveBalance({ pending: 0, used: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(approvedRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      let currentBalance = balance;
      leaveBalanceRepository.save.mockImplementation((entity) => {
        currentBalance = { ...currentBalance, ...entity } as LeaveBalance;
        return Promise.resolve(currentBalance);
      });

      // Cancel approved request
      await cancelHandler.execute(
        new CancelLeaveRequestCommand(tenantId, employeeId, approvedRequest.id, 'Plans changed')
      );

      // Used balance should be restored
      expect(currentBalance.used).toBe(0);
    });
  });

  // ============================================================================
  // Event Publishing Verification
  // ============================================================================

  describe('Event Publishing', () => {
    it('should publish correct event data on submit', async () => {
      const draftRequest = createMockLeaveRequest({ status: LeaveRequestStatus.DRAFT });
      const balance = createMockLeaveBalance();

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      await submitHandler.execute(
        new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id)
      );

      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      const publishedEvent = (eventBus.publish as jest.Mock).mock.calls[0][0];

      expect(publishedEvent).toBeInstanceOf(LeaveRequestSubmittedEvent);
      expect(publishedEvent.tenantId).toBe(tenantId);
      expect(publishedEvent.employeeId).toBe(employeeId);
      expect(publishedEvent.requestId).toBe(draftRequest.id);
    });

    it('should include approver info in approve event', async () => {
      const pendingRequest = createMockLeaveRequest({ status: LeaveRequestStatus.PENDING });
      const balance = createMockLeaveBalance({ pending: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      await approveHandler.execute(
        new ApproveLeaveRequestCommand(tenantId, managerId, pendingRequest.id)
      );

      const publishedEvent = (eventBus.publish as jest.Mock).mock.calls[0][0] as LeaveApprovedEvent;

      expect(publishedEvent).toBeInstanceOf(LeaveApprovedEvent);
      expect(publishedEvent.approvedBy).toBe(managerId);
    });

    it('should include rejection reason in reject event', async () => {
      const pendingRequest = createMockLeaveRequest({ status: LeaveRequestStatus.PENDING });
      const balance = createMockLeaveBalance({ pending: 5 });

      leaveRequestRepository.findOne.mockResolvedValue(pendingRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      const reason = 'Critical project deadline';
      await rejectHandler.execute(
        new RejectLeaveRequestCommand(tenantId, managerId, pendingRequest.id, reason)
      );

      const publishedEvent = (eventBus.publish as jest.Mock).mock.calls[0][0] as LeaveRejectedEvent;

      expect(publishedEvent).toBeInstanceOf(LeaveRejectedEvent);
      expect(publishedEvent.rejectionReason).toBe(reason);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle request not found', async () => {
      leaveRequestRepository.findOne.mockResolvedValue(null);

      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, 'non-existent-id');

      await expect(submitHandler.execute(command)).rejects.toThrow(/not found/);
    });

    it('should handle missing balance record gracefully', async () => {
      const draftRequest = createMockLeaveRequest({ status: LeaveRequestStatus.DRAFT });

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(null);

      // Should not throw, just skip balance update
      const command = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      await expect(submitHandler.execute(command)).resolves.toBeDefined();
    });

    it('should handle concurrent modifications', async () => {
      const draftRequest = createMockLeaveRequest({
        status: LeaveRequestStatus.DRAFT,
        version: 1,
      });
      const balance = createMockLeaveBalance();

      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);
      leaveBalanceRepository.findOne.mockResolvedValue(balance);

      // First submission succeeds
      const command1 = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      await submitHandler.execute(command1);

      // Simulate request is now PENDING
      draftRequest.status = LeaveRequestStatus.PENDING;
      leaveRequestRepository.findOne.mockResolvedValue(draftRequest);

      // Second submission should fail
      const command2 = new SubmitLeaveRequestCommand(tenantId, employeeId, draftRequest.id);
      await expect(submitHandler.execute(command2)).rejects.toThrow(
        /Cannot submit leave request with status/
      );
    });
  });
});
