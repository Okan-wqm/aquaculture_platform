/**
 * Tenant configuration data layer (config-service backed).
 *
 * Pure mapping between config-service's effective-configuration rows and the
 * typed reads/writes the tenant configuration page performs. No React or
 * transport imports — the transport lives in hooks/useTenantConfiguration.ts —
 * so everything here is unit-testable.
 *
 * # What replaced what
 *
 * The page used to call 39 admin-api REST routes whose service was an explicit
 * "legacy adapter": every write threw 410 Gone and every read synthesized
 * `createDefaultTenantConfiguration()` — the same values for every tenant, from
 * a TypeScript constant, served as that tenant's stored configuration. The
 * backing table had been dropped on the promise that config-service owned
 * tenant configuration; it did not, because no operation could address a tenant
 * other than the caller's own.
 *
 * Now the keys come from the cross-runtime tenant-settings authority imported
 * by both config-service and this module, and the same array seeds the SYSTEM
 * tenant default rows. A key exists in exactly one place, so the page
 * cannot ask for one the store does not define and the store cannot hold one
 * the page has never heard of.
 *
 * # Why a reader instead of a snapshot object
 *
 * A flat snapshot would have to name every key twice — once in the vocabulary
 * and once in an interface — which is the duplication this file exists to
 * remove. The reader is typed BY the vocabulary instead: `flag()` accepts only
 * keys the vocabulary declares boolean, so a page that reads a number as a
 * boolean does not compile.
 */

import {
  TENANT_SETTINGS,
  TENANT_SETTINGS_SERVICE,
  type TenantSetting,
} from '@platform/tenant-settings';
import { coerceStringList, type EffectiveConfigurationRow } from './effective-configuration';

export { TENANT_SETTINGS, TENANT_SETTINGS_SERVICE };
export type { TenantSetting };

/** Every key the vocabulary defines. A key outside this union does not exist. */
export type TenantSettingKey = TenantSetting['key'];

/** The tab a key belongs to. */
export type TenantSettingSection = TenantSetting['section'];

type KeyOfValueType<T extends TenantSetting['valueType']> = Extract<
  TenantSetting,
  { valueType: T }
>['key'];

export type TenantSettingTextKey = KeyOfValueType<'string'>;
export type TenantSettingNumberKey = KeyOfValueType<'number'>;
export type TenantSettingFlagKey = KeyOfValueType<'boolean'>;
export type TenantSettingListKey = KeyOfValueType<'json'>;

/** The sections in the order the vocabulary declares them. */
export const TENANT_SETTING_SECTIONS: readonly TenantSettingSection[] = [
  ...new Set(TENANT_SETTINGS.map((setting) => setting.section)),
];

/** The keys belonging to one section, in vocabulary order. */
export function sectionKeys(section: TenantSettingSection): readonly TenantSettingKey[] {
  return TENANT_SETTINGS.filter((setting) => setting.section === section).map(
    (setting) => setting.key,
  );
}

const SETTING_BY_KEY: ReadonlyMap<string, TenantSetting> = new Map(
  TENANT_SETTINGS.map((setting) => [setting.key, setting]),
);

export class TenantSettingsProjectionError extends Error {
  constructor(message: string) {
    super(`Tenant settings projection rejected: ${message}`);
    this.name = 'TenantSettingsProjectionError';
  }
}

function canonicalStoredValue(setting: TenantSetting, value: unknown): string {
  switch (setting.valueType) {
    case 'number': {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(parsed)) {
        throw new TenantSettingsProjectionError(`${setting.key} is not a finite number`);
      }
      return String(parsed);
    }
    case 'boolean':
      if (value === true || value === 'true') return 'true';
      if (value === false || value === 'false') return 'false';
      throw new TenantSettingsProjectionError(`${setting.key} is not a canonical boolean`);
    case 'json': {
      let parsed: unknown = value;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value) as unknown;
        } catch {
          throw new TenantSettingsProjectionError(`${setting.key} is not valid JSON`);
        }
      }
      if (!Array.isArray(parsed) || parsed.some((member) => typeof member !== 'string')) {
        throw new TenantSettingsProjectionError(`${setting.key} is not a string-list JSON value`);
      }
      return JSON.stringify(parsed);
    }
    default:
      if (typeof value !== 'string') {
        throw new TenantSettingsProjectionError(`${setting.key} is not a string`);
      }
      return value;
  }
}

/**
 * Reads one tenant's effective settings, typed by the vocabulary.
 *
 * `isDefault` is the honest half: it reports whether the value came from the
 * seeded SYSTEM row or from a decision this tenant made. The retired read path
 * could not answer that question because it invented both.
 */
export interface TenantSettingsReader {
  text(key: TenantSettingTextKey): string;
  count(key: TenantSettingNumberKey): number;
  flag(key: TenantSettingFlagKey): boolean;
  list(key: TenantSettingListKey): readonly string[];
  /** True when nobody set this key for this tenant and the default answered. */
  isDefault(key: TenantSettingKey): boolean;
  /** Keys this tenant has explicitly decided, in vocabulary order. */
  overriddenKeys(): readonly TenantSettingKey[];
  /**
   * The value in the exact string form the store holds it in.
   *
   * What a form edits. Routing it through the typed readers above rather than
   * handing back the raw row means an edit round-trips: what the field shows is
   * what a save would write, so a `json` row that arrived pre-parsed and one
   * that arrived as text produce the same draft.
   */
  canonical(key: TenantSettingKey): string;
}

export function createTenantSettingsReader(
  rows: readonly EffectiveConfigurationRow[],
): TenantSettingsReader {
  const byKey = new Map<
    TenantSettingKey,
    { readonly row: EffectiveConfigurationRow; readonly canonical: string }
  >();
  for (const row of rows) {
    const setting = SETTING_BY_KEY.get(row.key);
    if (setting === undefined) {
      throw new TenantSettingsProjectionError(`unknown key ${row.key}`);
    }
    const key = setting.key as TenantSettingKey;
    if (byKey.has(key)) {
      throw new TenantSettingsProjectionError(`duplicate key ${key}`);
    }
    if (row.secretMode !== 'none') {
      throw new TenantSettingsProjectionError(`${key} unexpectedly contains a secret`);
    }
    byKey.set(key, { row, canonical: canonicalStoredValue(setting, row.value) });
  }
  const missing = TENANT_SETTINGS.filter((setting) => !byKey.has(setting.key)).map(
    (setting) => setting.key,
  );
  if (missing.length > 0) {
    throw new TenantSettingsProjectionError(`missing keys ${missing.join(',')}`);
  }

  const exact = (key: TenantSettingKey) => {
    const value = byKey.get(key);
    if (value === undefined) {
      throw new TenantSettingsProjectionError(`missing key ${key}`);
    }
    return value;
  };

  const reader: TenantSettingsReader = {
    text(key) {
      return exact(key).canonical;
    },
    count(key) {
      return Number(exact(key).canonical);
    },
    flag(key) {
      return exact(key).canonical === 'true';
    },
    list(key) {
      return JSON.parse(exact(key).canonical) as readonly string[];
    },
    isDefault(key) {
      return exact(key).row.source === 'system';
    },
    overriddenKeys() {
      return TENANT_SETTINGS.filter((setting) => exact(setting.key).row.source === 'tenant').map(
        (setting) => setting.key,
      );
    },
    canonical(key) {
      return exact(key).canonical;
    },
  };

  return reader;
}

/** The vocabulary entry for a key. */
export function settingDefinition(key: TenantSettingKey): TenantSetting {
  const setting = SETTING_BY_KEY.get(key);
  if (setting === undefined) {
    // Unreachable through the typed API — `TenantSettingKey` is the vocabulary's
    // own key union — and thrown rather than defaulted so a generated file that
    // fell out of step announces itself instead of rendering a blank field.
    throw new Error(`"${key}" is not a tenant setting`);
  }
  return setting;
}

// ============================================================================
// Write builders — values are stored in the canonical string form the seed
// used, so the store keeps each row's `value_type` on upsert.
// ============================================================================

export interface TenantSettingWrite {
  readonly key: TenantSettingKey;
  readonly value: string;
}

export interface TenantSettingWriteReceipt {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
}

export function assertTenantSettingWriteReceipt(
  write: TenantSettingWrite,
  receipt: TenantSettingWriteReceipt,
): void {
  if (receipt.key !== write.key) {
    throw new TenantSettingsProjectionError(
      `write receipt key ${receipt.key} does not match ${write.key}`,
    );
  }
  if (!Number.isSafeInteger(receipt.version) || receipt.version < 1) {
    throw new TenantSettingsProjectionError(`${write.key} write receipt has an invalid version`);
  }
  const setting = settingDefinition(write.key);
  const expected = canonicalStoredValue(setting, write.value);
  const actual = canonicalStoredValue(setting, receipt.value);
  if (actual !== expected) {
    throw new TenantSettingsProjectionError(`${write.key} write receipt value does not match`);
  }
}

export function textWrite(key: TenantSettingTextKey, value: string): TenantSettingWrite {
  return { key, value };
}

export function countWrite(key: TenantSettingNumberKey, value: number): TenantSettingWrite {
  return { key, value: String(value) };
}

export function flagWrite(key: TenantSettingFlagKey, value: boolean): TenantSettingWrite {
  return { key, value: String(value) };
}

export function listWrite(key: TenantSettingListKey, value: readonly string[]): TenantSettingWrite {
  return { key, value: JSON.stringify(value) };
}

/**
 * A write built from a form draft already held in canonical string form.
 *
 * The typed builders above are for callers that name a key in source; this one
 * is for the form, which walks the vocabulary and therefore knows its key only
 * as data. Both produce the same shape.
 */
export function draftWrite(key: TenantSettingKey, canonical: string): TenantSettingWrite {
  return { key, value: canonical };
}

/**
 * Whether a draft can be stored under its key's declared type.
 *
 * Guards the one case a typed input still lets through: a number field cleared
 * to empty. Saving that as `''` under `value_type = number` would put a row in
 * the store that reads back as `NaN` for every consumer.
 */
export function isDraftValid(key: TenantSettingKey, canonical: string): boolean {
  const setting = settingDefinition(key);
  switch (setting.valueType) {
    case 'number':
      return canonical.trim() !== '' && Number.isFinite(Number(canonical));
    case 'boolean':
      return canonical === 'true' || canonical === 'false';
    case 'json':
      return coerceStringList(canonical, NOT_A_LIST) !== NOT_A_LIST;
    default:
      return true;
  }
}

/** Sentinel identity used to tell "parsed to an empty list" from "did not parse". */
const NOT_A_LIST: readonly string[] = [];

// ============================================================================
// Labels — derived from the key, so a new setting needs no second table
// ============================================================================

/**
 * `limits.max_users` → `Max users`.
 *
 * Derived rather than tabulated on purpose. A hand-written label map is one
 * more place a key has to be spelled, and the one that silently keeps the old
 * wording after a rename.
 */
export function settingLabel(key: TenantSettingKey): string {
  const leaf = key
    .slice(key.indexOf('.') + 1)
    .split('_')
    .join(' ');
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

/** `userLimits` → `User limits`. */
export function sectionLabel(section: TenantSettingSection): string {
  const spaced = section.replace(
    /([a-z])([A-Z])/g,
    (_match, before: string, after: string) => `${before} ${after.toLowerCase()}`,
  );
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
