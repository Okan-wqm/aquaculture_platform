import { BadRequestException } from '@nestjs/common';
import { RotationStatus } from './entities/work-rotation.entity';

/**
 * Centralized finite state machine for work rotation lifecycle.
 *
 * HR-MEDIUM-004: Replaces scattered ad-hoc if/else status checks with a
 * single source of truth for ALL valid rotation transitions. Invalid
 * transitions are STRUCTURALLY IMPOSSIBLE -- the Map defines the complete
 * set of allowed (fromStatus, toStatus) pairs. Any transition not in the
 * Map throws immediately.
 *
 * State diagram:
 *   SCHEDULED   -> IN_PROGRESS | CANCELLED
 *   IN_PROGRESS -> COMPLETED | EXTENDED | CANCELLED
 *   EXTENDED    -> COMPLETED | CANCELLED
 *   COMPLETED   (terminal)
 *   CANCELLED   (terminal)
 *
 * Usage:
 * ```typescript
 * RotationStateMachine.transition(currentStatus, targetStatus);
 * // throws BadRequestException if transition is invalid
 * ```
 */
export class RotationStateMachine {
  /**
   * Complete transition table for the work rotation lifecycle.
   *
   * Key: current status
   * Value: set of statuses that can be transitioned TO from the key status
   */
  private static readonly TRANSITIONS: ReadonlyMap<RotationStatus, ReadonlySet<RotationStatus>> = new Map([
    [
      RotationStatus.SCHEDULED,
      new Set([
        RotationStatus.IN_PROGRESS,
        RotationStatus.CANCELLED,
      ]),
    ],
    [
      RotationStatus.IN_PROGRESS,
      new Set([
        RotationStatus.COMPLETED,
        RotationStatus.EXTENDED,
        RotationStatus.CANCELLED,
      ]),
    ],
    [
      RotationStatus.EXTENDED,
      new Set([
        RotationStatus.COMPLETED,
        RotationStatus.CANCELLED,
      ]),
    ],
    // Terminal states -- no transitions allowed out
    [RotationStatus.COMPLETED, new Set<RotationStatus>()],
    [RotationStatus.CANCELLED, new Set<RotationStatus>()],
  ]);

  /**
   * Validate and execute a status transition.
   *
   * @param current - Current rotation status
   * @param target - Desired target status
   * @throws BadRequestException if the transition is not allowed
   */
  static transition(current: RotationStatus, target: RotationStatus): void {
    const allowedTargets = RotationStateMachine.TRANSITIONS.get(current);

    if (!allowedTargets) {
      throw new BadRequestException(
        `Rotation status "${current}" is not a recognized state`,
      );
    }

    if (!allowedTargets.has(target)) {
      const allowed = allowedTargets.size > 0
        ? Array.from(allowedTargets).join(', ')
        : 'none (terminal state)';
      throw new BadRequestException(
        `Invalid rotation transition: ${current} -> ${target}. ` +
        `Allowed transitions from ${current}: ${allowed}`,
      );
    }
  }

  /**
   * Check if a transition is valid without throwing.
   *
   * @param current - Current rotation status
   * @param target - Desired target status
   * @returns true if the transition is allowed
   */
  static canTransition(current: RotationStatus, target: RotationStatus): boolean {
    const allowedTargets = RotationStateMachine.TRANSITIONS.get(current);
    return allowedTargets?.has(target) ?? false;
  }

  /**
   * Get all valid target states from the given status.
   *
   * @param current - Current rotation status
   * @returns Array of valid target statuses
   */
  static getValidTransitions(current: RotationStatus): RotationStatus[] {
    const allowedTargets = RotationStateMachine.TRANSITIONS.get(current);
    return allowedTargets ? Array.from(allowedTargets) : [];
  }
}
