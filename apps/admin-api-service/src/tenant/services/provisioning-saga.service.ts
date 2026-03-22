import { Logger } from '@nestjs/common';

/**
 * Describes a single step in the provisioning saga.
 */
export interface SagaStep {
  /** Human-readable step name for logging and reporting */
  name: string;
  /** Status after saga execution */
  status: 'pending' | 'completed' | 'failed' | 'compensated' | 'compensation_failed';
  /** Execution duration in milliseconds */
  duration?: number;
  /** Error message if step failed */
  error?: string;
}

/**
 * Result returned after saga execution.
 */
export interface SagaResult {
  /** Whether all steps completed successfully */
  success: boolean;
  /** Names of steps that completed successfully before any failure */
  completedSteps: string[];
  /** Detailed step information */
  steps: SagaStep[];
  /** Name of the step that failed (if any) */
  failedStep?: string;
  /** Error message from the failed step */
  error?: string;
  /** Errors encountered during compensation (best-effort reporting) */
  compensationErrors: Array<{ step: string; error: string }>;
}

interface InternalStep {
  name: string;
  execute: () => Promise<void>;
  compensate?: () => Promise<void>;
}

/**
 * Generic saga orchestrator for multi-step provisioning flows.
 *
 * Usage:
 * ```typescript
 * const saga = new ProvisioningSagaService();
 * saga.addStep('create_schema', createFn, dropSchemaFn);
 * saga.addStep('setup_roles', setupFn, deleteRolesFn);
 * saga.addStep('create_admin', createAdminFn, deleteUserFn);
 * const result = await saga.run();
 * ```
 *
 * On failure, completed steps are compensated in reverse order.
 * Compensation errors are collected but never thrown, since the saga
 * is already on an error path and we want maximum rollback coverage.
 *
 * Each saga instance is single-use: calling run() twice will throw.
 */
export class ProvisioningSagaService {
  private readonly logger = new Logger(ProvisioningSagaService.name);
  private readonly steps: InternalStep[] = [];
  private executed = false;

  /**
   * Register a step in the saga.
   *
   * @param name - Unique step identifier for logging/reporting
   * @param execute - Forward action (must be idempotent if possible)
   * @param compensate - Reverse action to undo the execute (optional)
   */
  addStep(
    name: string,
    execute: () => Promise<void>,
    compensate?: () => Promise<void>,
  ): void {
    this.steps.push({ name, execute, compensate });
  }

  /**
   * Execute all registered steps in order.
   *
   * If any step fails:
   * 1. The failed step is recorded.
   * 2. All previously completed steps are compensated in reverse order.
   * 3. Compensation errors are collected (not thrown).
   * 4. The result reports overall failure with details.
   */
  async run(): Promise<SagaResult> {
    if (this.executed) {
      throw new Error('This saga has already been executed. Create a new instance for each run.');
    }
    this.executed = true;

    const completedSteps: string[] = [];
    const stepDetails: SagaStep[] = [];
    const compensationErrors: Array<{ step: string; error: string }> = [];

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const detail: SagaStep = {
        name: step.name,
        status: 'pending',
      };
      stepDetails.push(detail);

      const startTime = Date.now();
      try {
        this.logger.log(`Saga step [${step.name}] starting...`);
        detail.status = 'completed'; // optimistic -- will be overwritten on error
        await step.execute();
        detail.duration = Date.now() - startTime;
        completedSteps.push(step.name);
        this.logger.log(`Saga step [${step.name}] completed in ${detail.duration}ms`);
      } catch (error) {
        detail.status = 'failed';
        detail.duration = Date.now() - startTime;
        detail.error = (error as Error).message;

        this.logger.error(
          `Saga step [${step.name}] failed: ${detail.error}`,
          (error as Error).stack,
        );

        // Compensate completed steps in reverse order
        await this.compensateSteps(
          completedSteps,
          stepDetails,
          compensationErrors,
        );

        return {
          success: false,
          completedSteps,
          steps: stepDetails,
          failedStep: step.name,
          error: detail.error,
          compensationErrors,
        };
      }
    }

    return {
      success: true,
      completedSteps,
      steps: stepDetails,
      compensationErrors: [],
    };
  }

  /**
   * Compensate completed steps in reverse order.
   * Errors are collected but never thrown.
   */
  private async compensateSteps(
    completedSteps: string[],
    stepDetails: SagaStep[],
    compensationErrors: Array<{ step: string; error: string }>,
  ): Promise<void> {
    // Iterate completed steps in reverse
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      const stepName = completedSteps[i];
      const internalStep = this.steps.find((s) => s.name === stepName);
      const detail = stepDetails.find((d) => d.name === stepName);

      if (!internalStep?.compensate) {
        // No compensate function provided -- mark as compensated (nothing to undo)
        if (detail) {
          detail.status = 'compensated';
        }
        this.logger.debug(
          `Saga step [${stepName}] has no compensate function, skipping`,
        );
        continue;
      }

      try {
        this.logger.warn(`Compensating saga step [${stepName}]...`);
        await internalStep.compensate();
        if (detail) {
          detail.status = 'compensated';
        }
        this.logger.warn(`Saga step [${stepName}] compensated successfully`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        compensationErrors.push({ step: stepName, error: errorMessage });
        if (detail) {
          detail.status = 'compensation_failed';
        }
        this.logger.error(
          `Failed to compensate saga step [${stepName}]: ${errorMessage}`,
          (error as Error).stack,
        );
        // Continue compensating remaining steps -- don't throw
      }
    }
  }
}
