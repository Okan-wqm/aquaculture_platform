import { Logger } from '@nestjs/common';

import {
  ProvisioningSagaService,
  SagaResult,
  SagaStep,
} from './provisioning-saga.service';

describe('ProvisioningSagaService', () => {
  let saga: ProvisioningSagaService;

  beforeEach(() => {
    saga = new ProvisioningSagaService();
    // Suppress log output during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // SUCCESS PATH
  // =========================================================================

  describe('success path', () => {
    it('should execute all steps in order and return success', async () => {
      const executionOrder: string[] = [];

      saga.addStep(
        'step_1',
        async () => { executionOrder.push('execute_1'); },
        async () => { executionOrder.push('compensate_1'); },
      );
      saga.addStep(
        'step_2',
        async () => { executionOrder.push('execute_2'); },
        async () => { executionOrder.push('compensate_2'); },
      );
      saga.addStep(
        'step_3',
        async () => { executionOrder.push('execute_3'); },
        async () => { executionOrder.push('compensate_3'); },
      );

      const result = await saga.run();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.completedSteps).toEqual(['step_1', 'step_2', 'step_3']);
      expect(result.compensationErrors).toEqual([]);
      expect(executionOrder).toEqual(['execute_1', 'execute_2', 'execute_3']);
    });

    it('should record duration for each step', async () => {
      saga.addStep(
        'fast_step',
        async () => { /* instant */ },
        async () => {},
      );

      const result = await saga.run();

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(1);
      // `!` is safe after toHaveLength(1) narrows the array — but
      // strict-tsc with noUncheckedIndexedAccess can't follow the
      // narrowing through the matcher boundary.
      expect(result.steps[0]!.name).toBe('fast_step');
      expect(result.steps[0]!.status).toBe('completed');
      expect(result.steps[0]!.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return success when no steps are added', async () => {
      const result = await saga.run();

      expect(result.success).toBe(true);
      expect(result.completedSteps).toEqual([]);
      expect(result.steps).toEqual([]);
    });
  });

  // =========================================================================
  // FAILURE WITH COMPENSATION
  // =========================================================================

  describe('failure with compensation', () => {
    it('should compensate completed steps in reverse order on failure', async () => {
      const executionOrder: string[] = [];

      saga.addStep(
        'step_1',
        async () => { executionOrder.push('execute_1'); },
        async () => { executionOrder.push('compensate_1'); },
      );
      saga.addStep(
        'step_2',
        async () => { executionOrder.push('execute_2'); },
        async () => { executionOrder.push('compensate_2'); },
      );
      saga.addStep(
        'step_3',
        async () => { throw new Error('Step 3 failed'); },
        async () => { executionOrder.push('compensate_3'); },
      );

      const result = await saga.run();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Step 3 failed');
      expect(result.failedStep).toBe('step_3');
      expect(result.completedSteps).toEqual(['step_1', 'step_2']);
      // Compensation should happen in REVERSE order and only for completed steps
      // step_3 was never completed, so only step_2 and step_1 get compensated
      expect(executionOrder).toEqual([
        'execute_1',
        'execute_2',
        'compensate_2',
        'compensate_1',
      ]);
    });

    it('should not compensate any steps when the first step fails', async () => {
      const executionOrder: string[] = [];

      saga.addStep(
        'step_1',
        async () => { throw new Error('First step failed'); },
        async () => { executionOrder.push('compensate_1'); },
      );
      saga.addStep(
        'step_2',
        async () => { executionOrder.push('execute_2'); },
        async () => { executionOrder.push('compensate_2'); },
      );

      const result = await saga.run();

      expect(result.success).toBe(false);
      expect(result.error).toBe('First step failed');
      expect(result.completedSteps).toEqual([]);
      // No steps completed, so no compensation
      expect(executionOrder).toEqual([]);
    });

    it('should mark the failed step status as "failed" in step details', async () => {
      saga.addStep(
        'step_1',
        async () => {},
        async () => {},
      );
      saga.addStep(
        'failing_step',
        async () => { throw new Error('boom'); },
        async () => {},
      );

      const result = await saga.run();

      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]!.status).toBe('compensated');
      expect(result.steps[1]!.name).toBe('failing_step');
      expect(result.steps[1]!.status).toBe('failed');
      expect(result.steps[1]!.error).toBe('boom');
    });
  });

  // =========================================================================
  // COMPENSATION FAILURE REPORTING
  // =========================================================================

  describe('compensation failure reporting', () => {
    it('should report compensation errors without throwing', async () => {
      saga.addStep(
        'step_1',
        async () => {},
        async () => { throw new Error('Compensation 1 failed'); },
      );
      saga.addStep(
        'step_2',
        async () => {},
        async () => { throw new Error('Compensation 2 failed'); },
      );
      saga.addStep(
        'step_3',
        async () => { throw new Error('Execute 3 failed'); },
        async () => {},
      );

      const result = await saga.run();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Execute 3 failed');
      expect(result.compensationErrors).toHaveLength(2);
      expect(result.compensationErrors[0]).toEqual({
        step: 'step_2',
        error: 'Compensation 2 failed',
      });
      expect(result.compensationErrors[1]).toEqual({
        step: 'step_1',
        error: 'Compensation 1 failed',
      });
    });

    it('should continue compensating remaining steps even if one compensation fails', async () => {
      const executionOrder: string[] = [];

      saga.addStep(
        'step_1',
        async () => {},
        async () => { executionOrder.push('compensate_1'); },
      );
      saga.addStep(
        'step_2',
        async () => {},
        async () => { throw new Error('Compensation 2 failed'); },
      );
      saga.addStep(
        'step_3',
        async () => {},
        async () => { executionOrder.push('compensate_3'); },
      );
      saga.addStep(
        'step_4',
        async () => { throw new Error('Execute 4 failed'); },
        async () => {},
      );

      const result = await saga.run();

      expect(result.success).toBe(false);
      // step_2 compensation failed but step_1 and step_3 should still have run
      expect(executionOrder).toEqual([
        'compensate_3',
        'compensate_1',
      ]);
      expect(result.compensationErrors).toHaveLength(1);
      expect(result.compensationErrors[0]!.step).toBe('step_2');
    });

    it('should mark steps with failed compensation as "compensation_failed"', async () => {
      saga.addStep(
        'step_1',
        async () => {},
        async () => { throw new Error('cannot undo'); },
      );
      saga.addStep(
        'step_2',
        async () => { throw new Error('boom'); },
        async () => {},
      );

      const result = await saga.run();

      expect(result.steps[0]!.status).toBe('compensation_failed');
      expect(result.steps[1]!.status).toBe('failed');
    });
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================

  describe('edge cases', () => {
    it('should handle steps without compensate function', async () => {
      saga.addStep(
        'no_compensate_step',
        async () => {},
      );
      saga.addStep(
        'failing_step',
        async () => { throw new Error('fail'); },
        async () => {},
      );

      const result = await saga.run();

      expect(result.success).toBe(false);
      // Should not error when compensating a step with no compensate fn
      expect(result.compensationErrors).toEqual([]);
    });

    it('should not be reusable after run', async () => {
      saga.addStep('step_1', async () => {}, async () => {});

      await saga.run();

      // Second run should throw
      await expect(saga.run()).rejects.toThrow('already been executed');
    });
  });
});
