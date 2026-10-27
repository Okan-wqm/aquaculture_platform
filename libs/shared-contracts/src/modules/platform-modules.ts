/**
 * The module dictionary — the one declaration of the platform's module codes (RBAC-MEDIUM-023;
 * ADR-051 §2, ADR-052 Decision 4).
 *
 * WHY: the codes were declared six times — auth's catalogue enum, hr's department-module enum,
 * alert-engine's alarm-module enum, the AI specialty type, the web nav union and a tenant-admin
 * list — and the copies already disagreed: none outside auth could name hr, so an HR-owned
 * organisation unit could only be stored as NULL (HR-MEDIUM-064). Every module key in the
 * platform (a token grant, a registry row, a department, an alarm, a Postgres label, a GraphQL
 * enum value) now derives from this file, and `tests/invariants/module-dictionary-ssot.spec.ts`
 * fails any copy.
 *
 * WHAT (owner decisions of 2026-10-26):
 *   - PLATFORM_MODULE: every module a tenant can hold — the codes the auth `modules` catalogue
 *     seeds, in its display order.
 *   - MODULE_DESCRIPTORS: per code, whether it is an OWNER module — one that owns module-private
 *     data and carries per-module grants — and whether its features ship. The owner modules are
 *     farm, hr, sensor and hydroponics (D4); alert and ai are tenant modules whose data is scoped
 *     by the owner module it came from, not owners themselves. Hydroponics is reserved: declared
 *     and gated, with no feature in scope (D3).
 *   - OWNER_MODULE / ACTIVE_OWNER_MODULE_CODES and the code types derived from the descriptors.
 *   - Type guards for codes that cross a trust boundary (a token claim, a stored row, a request).
 *
 * Zero-dependency (see index.ts) and no `enum` (shared-contracts-no-enum-drift.spec.ts): frozen
 * objects whose types the compiler ties to the descriptors.
 */

export const PLATFORM_MODULE = Object.freeze({
  FARM: 'farm',
  HR: 'hr',
  SENSOR: 'sensor',
  HYDROPONICS: 'hydroponics',
  ALERT: 'alert',
  AI: 'ai',
} as const);

export type PlatformModuleKey = keyof typeof PLATFORM_MODULE;
export type PlatformModuleCode = (typeof PLATFORM_MODULE)[PlatformModuleKey];

/** `reserved`: the module is declared and can be gated, but no feature of it ships (D3). */
export type ModuleLifecycle = 'active' | 'reserved';

export interface ModuleDescriptor {
  readonly code: PlatformModuleCode;
  /** Owns module-private data and carries per-module grants (D4). */
  readonly owner: boolean;
  readonly lifecycle: ModuleLifecycle;
}

/**
 * One descriptor per code, keyed by the code it describes: a missing, extra or mislabelled entry
 * does not compile.
 */
export const MODULE_DESCRIPTORS = Object.freeze({
  farm: Object.freeze({ code: 'farm', owner: true, lifecycle: 'active' }),
  hr: Object.freeze({ code: 'hr', owner: true, lifecycle: 'active' }),
  sensor: Object.freeze({ code: 'sensor', owner: true, lifecycle: 'active' }),
  hydroponics: Object.freeze({ code: 'hydroponics', owner: true, lifecycle: 'reserved' }),
  alert: Object.freeze({ code: 'alert', owner: false, lifecycle: 'active' }),
  ai: Object.freeze({ code: 'ai', owner: false, lifecycle: 'active' }),
} satisfies { readonly [C in PlatformModuleCode]: ModuleDescriptor & { readonly code: C } });

type Descriptors = typeof MODULE_DESCRIPTORS;

/** The owner modules (D4): farm, hr, sensor, hydroponics. */
export type OwnerModuleCode = {
  [C in PlatformModuleCode]: Descriptors[C]['owner'] extends true ? C : never;
}[PlatformModuleCode];

/** The owner modules whose features ship: farm, hr, sensor (hydroponics is reserved, D3). */
export type ActiveOwnerModuleCode = {
  [C in OwnerModuleCode]: Descriptors[C]['lifecycle'] extends 'active' ? C : never;
}[OwnerModuleCode];

type OwnerModuleKey = {
  [K in PlatformModuleKey]: (typeof PLATFORM_MODULE)[K] extends OwnerModuleCode ? K : never;
}[PlatformModuleKey];

/** The owner modules by key; the compiler holds it equal to the descriptors' owner set. */
export const OWNER_MODULE = Object.freeze({
  FARM: PLATFORM_MODULE.FARM,
  HR: PLATFORM_MODULE.HR,
  SENSOR: PLATFORM_MODULE.SENSOR,
  HYDROPONICS: PLATFORM_MODULE.HYDROPONICS,
} as const satisfies { readonly [K in OwnerModuleKey]: (typeof PLATFORM_MODULE)[K] });

export const PLATFORM_MODULE_CODES: readonly PlatformModuleCode[] = Object.freeze(
  Object.values(PLATFORM_MODULE),
);

export const OWNER_MODULE_CODES: readonly OwnerModuleCode[] = Object.freeze(
  Object.values(OWNER_MODULE),
);

export function isPlatformModuleCode(value: unknown): value is PlatformModuleCode {
  return PLATFORM_MODULE_CODES.some((code) => code === value);
}

/** Narrows to an owner module: alert, ai and unknown codes are not (ADR-051 §2, the token reader). */
export function isOwnerModuleCode(value: unknown): value is OwnerModuleCode {
  return OWNER_MODULE_CODES.some((code) => code === value);
}

export function isActiveOwnerModuleCode(value: unknown): value is ActiveOwnerModuleCode {
  return isOwnerModuleCode(value) && MODULE_DESCRIPTORS[value].lifecycle === 'active';
}

export const ACTIVE_OWNER_MODULE_CODES: readonly ActiveOwnerModuleCode[] = Object.freeze(
  OWNER_MODULE_CODES.filter(isActiveOwnerModuleCode),
);
