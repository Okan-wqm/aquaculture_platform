// Permission lookups over the /me answer — pure, so the rule is testable alone.
//
// WHY: a control the server will refuse must not be shown, and a control the
// server allows must not be hidden behind the wrong switch. Until 2026-09-04
// every legal control hung off `actionsEnabled`, the kernel-control switch,
// which the shipped legal manifest turns off — so a lawyer saw a read-only
// console while the policy that actually governed their actions was never
// consulted. The SPA now asks the same question the server answers: may THIS
// principal perform THIS action class.
// WHAT: `canPerform` reads one class out of the permissions map; absent or
// not-yet-loaded means no.

import type { WhoAmIResponse } from '../../../shared/api-contract.ts';

export function canPerform(me: WhoAmIResponse | null, actionClass: string): boolean {
  if (me === null) return false;
  return me.permissions[actionClass] === true;
}
