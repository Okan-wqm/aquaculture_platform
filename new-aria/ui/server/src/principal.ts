// The principal a request acts as.
//
// WHY: every custody record the console writes names who wrote it, and every
// lawyer-owned gate in the instance's approval policy asks which role is asking.
// Until 2026-09-04 the answer to both was a request header the caller typed
// (`x-aria-actor`), copied into the receipt as fact. A name nobody verified is
// not an author; a role nobody verified cannot pass a gate. The console now
// carries ONE principal per request, resolved by the server from the credential
// it authenticated — never from the request body or a header.
//
// WHAT: the principal shape, the role vocabulary the console can authenticate,
// and the single principal a shared bearer token resolves to. A principals file
// (per-person tokens, roles and case assignments) replaces the token holder in
// the identity phase; the shape stays.

/**
 * Roles the console can authenticate. An approval policy that names any other
 * role declares a gate nobody can ever pass, so policy loading refuses it.
 */
export const PRINCIPAL_ROLES = ['operator', 'lawyer'] as const;
export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number];

export interface Principal {
  /** Stable identifier written into receipts and decisions. */
  readonly id: string;
  readonly displayName: string;
  readonly role: PrincipalRole;
  /** Case ids this principal may see, or '*' for every case in the instance. */
  readonly cases: '*' | ReadonlyArray<string>;
}

/**
 * The principal behind the shared operator token. It is an OPERATOR: the token
 * proves possession of the instance's credential, not a lawyer's identity, so it
 * can never satisfy a lawyer-owned gate.
 */
export const TOKEN_HOLDER_PRINCIPAL: Principal = Object.freeze({
  id: 'console-token-holder',
  displayName: 'Console token holder',
  role: 'operator',
  cases: '*',
});

/** Whoever reaches a public route (health) acts as nobody: no cases, no gate can pass. */
export const ANONYMOUS_PRINCIPAL: Principal = Object.freeze({
  id: 'anonymous',
  displayName: 'Anonymous',
  role: 'operator',
  cases: [],
});

export function isPrincipalRole(value: string): value is PrincipalRole {
  return (PRINCIPAL_ROLES as ReadonlyArray<string>).includes(value);
}
