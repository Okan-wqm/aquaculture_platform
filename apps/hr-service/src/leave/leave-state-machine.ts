import { BadRequestException } from '@nestjs/common';
import { LeaveRequestStatus } from './entities/leave-request.entity';

/**
 * Centralized finite state machine for leave request lifecycle.
 *
 * HR-HIGH-008: Replaces scattered ad-hoc if/else status checks with a
 * single source of truth for ALL valid transitions. Invalid transitions
 * are STRUCTURALLY IMPOSSIBLE — the Map defines the complete set of
 * allowed (fromStatus, toStatus) pairs. Any transition not in the Map
 * throws immediately.
 *
 * Usage:
 * ```typescript
 * LeaveStateMachine.transition(currentStatus, targetStatus);
 * // throws BadRequestException if transition is invalid
 * ```
 */
export class LeaveStateMachine {
  /**
   * Complete transition table for the leave request lifecycle.
   *
   * Key: current status
   * Value: set of statuses that can be transitioned TO from the key status
   *
   * State diagram:
   *   DRAFT → PENDING → APPROVED → CANCELLED
   *                   → REJECTED
   *                   → CANCELLED
   *         → CANCELLED
   *         → WITHDRAWN
   *   APPROVED → CANCELLED (only if leave hasn't started)
   *
   * Terminal states (no outgoing transitions): REJECTED, WITHDRAWN
   */
  private static readonly TRANSITIONS: ReadonlyMap<LeaveRequestStatus, ReadonlySet<LeaveRequestStatus>> = new Map([
    [
      LeaveRequestStatus.DRAFT,
      new Set([
        LeaveRequestStatus.PENDING,
        LeaveRequestStatus.CANCELLED,
        LeaveRequestStatus.WITHDRAWN,
      ]),
    ],
    [
      LeaveRequestStatus.PENDING,
      new Set([
        LeaveRequestStatus.APPROVED,
        LeaveRequestStatus.REJECTED,
        LeaveRequestStatus.CANCELLED,
        LeaveRequestStatus.WITHDRAWN,
      ]),
    ],
    [
      LeaveRequestStatus.APPROVED,
      new Set([
        LeaveRequestStatus.CANCELLED,
      ]),
    ],
    // Terminal states — no transitions allowed out
    [LeaveRequestStatus.REJECTED, new Set<LeaveRequestStatus>()],
    [LeaveRequestStatus.CANCELLED, new Set<LeaveRequestStatus>()],
    [LeaveRequestStatus.WITHDRAWN, new Set<LeaveRequestStatus>()],
  ]);

  /**
   * Validate and execute a status transition.
   *
   * @param current - Current leave request status
   * @param target - Desired target status
   * @throws BadRequestException if the transition is not allowed
   */
  static transition(current: LeaveRequestStatus, target: LeaveRequestStatus): void {
    const allowedTargets = LeaveStateMachine.TRANSITIONS.get(current);

    if (!allowedTargets) {
      throw new BadRequestException(
        `Leave request status "${current}" is not a recognized state`,
      );
    }

    if (!allowedTargets.has(target)) {
      const allowed = allowedTargets.size > 0
        ? Array.from(allowedTargets).join(', ')
        : 'none (terminal state)';
      throw new BadRequestException(
        `Invalid leave request transition: ${current} → ${target}. ` +
        `Allowed transitions from ${current}: ${allowed}`,
      );
    }
  }

  /**
   * Check if a transition is valid without throwing.
   *
   * @param current - Current leave request status
   * @param target - Desired target status
   * @returns true if the transition is allowed
   */
  static canTransition(current: LeaveRequestStatus, target: LeaveRequestStatus): boolean {
    const allowedTargets = LeaveStateMachine.TRANSITIONS.get(current);
    return allowedTargets?.has(target) ?? false;
  }

  /**
   * Get all valid target states from the given status.
   *
   * @param current - Current leave request status
   * @returns Array of valid target statuses
   */
  static getValidTransitions(current: LeaveRequestStatus): LeaveRequestStatus[] {
    const allowedTargets = LeaveStateMachine.TRANSITIONS.get(current);
    return allowedTargets ? Array.from(allowedTargets) : [];
  }
}
