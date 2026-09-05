// Action-class gates — the approval policy, asked on every mutating request.
//
// WHY: `arias/legal/config/approval-policy.json` names which human role owns
// which action class. MEASURED 2026-09-04: the console parsed those gates at
// startup and consulted none of them; the one thing it enforced was a boolean,
// `allow_actions`, and the shipped legal manifest set it false — so a lawyer's
// instance could not open a case, upload a document or run an inventory under
// any environment, while the policy that should have decided sat unread.
//
// WHAT: `requireGate` refuses a request unless the policy allows the principal
// to perform the class; `permissionsFor` answers the same question for every
// class at once so the SPA can show only the controls a principal can use.
// The boolean survives for exactly one class, kernel control, where it belongs.

import { KERNEL_CONTROL_ACTION_CLASS } from '../../shared/api-contract.ts';
import { LEGAL_ACTION_CLASSES } from '../../shared/legal-contract.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { decideGate } from './instance-policy.ts';
import type { Principal } from './principal.ts';

export type ConsoleActionClass = typeof KERNEL_CONTROL_ACTION_CLASS | (typeof LEGAL_ACTION_CLASSES)[number];

/**
 * Whether the principal may perform the class, with the reason when it may not.
 *
 * Kernel control answers from the environment-and-manifest switch. A case class
 * answers from the policy when the instance declares one; a console with no
 * instance manifest has no policy to ask, so it falls back to the same
 * environment switch the whole console used before the policy existed.
 */
export function decideAction(config: ServerConfig, principal: Principal, actionClass: ConsoleActionClass): { readonly allowed: true } | { readonly allowed: false; readonly code: string; readonly detail: string } {
  if (actionClass === KERNEL_CONTROL_ACTION_CLASS) {
    if (config.allowActions) return { allowed: true };
    return {
      allowed: false,
      code: 'actions_disabled',
      detail:
        config.instancePolicy !== null && !config.instancePolicy.allowActions
          ? `the instance manifest ${config.instancePolicy.instanceId} sets runtime.allow_actions false`
          : 'set ARIA_UI_ALLOW_ACTIONS=1 to enable kernel control',
    };
  }
  if (config.instancePolicy === null) {
    if (config.allowActions) return { allowed: true };
    return { allowed: false, code: 'actions_disabled', detail: `no instance manifest governs ${actionClass}; set ARIA_UI_ALLOW_ACTIONS=1 to enable it` };
  }
  const decision = decideGate(config.instancePolicy, principal.role, actionClass);
  if (decision.allowed) return { allowed: true };
  if (decision.reason === 'action_class_ungoverned') {
    return { allowed: false, code: 'action_class_ungoverned', detail: `${actionClass} is not named by ${config.instancePolicy.approvalPolicyPath ?? 'the approval policy'}` };
  }
  return {
    allowed: false,
    code: 'action_class_refused',
    detail: `${actionClass} requires role ${decision.requiredRole}; ${principal.id} holds role ${principal.role}`,
  };
}

/** Throws 403 naming the class and the role it needs. */
export function requireGate(config: ServerConfig, principal: Principal, actionClass: ConsoleActionClass): void {
  const decision = decideAction(config, principal, actionClass);
  if (!decision.allowed) throw new HttpError(403, decision.code, decision.detail);
}

/** Every class the console knows, decided for this principal. */
export function permissionsFor(config: ServerConfig, principal: Principal): Record<string, boolean> {
  const permissions: Record<string, boolean> = {};
  permissions[KERNEL_CONTROL_ACTION_CLASS] = decideAction(config, principal, KERNEL_CONTROL_ACTION_CLASS).allowed;
  for (const actionClass of LEGAL_ACTION_CLASSES) {
    permissions[actionClass] = decideAction(config, principal, actionClass).allowed;
  }
  return permissions;
}
