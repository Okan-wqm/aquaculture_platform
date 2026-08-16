/**
 * Closed SQL identifier authority for caller-selectable admin sort fields.
 *
 * Values in this catalog are TypeORM property expressions, never SQL supplied
 * by the caller. Public sort keys and persistence coordinates therefore evolve
 * together and every consumer resolves through one immutable catalog.
 */

export const SQL_IDENTIFIER_CATALOG_SCHEMA_VERSION = 'sql-identifier-catalog.v1' as const;

export interface SqlIdentifierCatalogEntryV1 {
  readonly requestField: 'sortBy';
  readonly defaultKey: string;
  readonly identifiers: Readonly<Record<string, string>>;
}

export interface SqlIdentifierCatalogV1 {
  readonly schemaVersion: typeof SQL_IDENTIFIER_CATALOG_SCHEMA_VERSION;
  readonly entries: Readonly<Record<string, SqlIdentifierCatalogEntryV1>>;
}

const TYPEORM_PROPERTY_EXPRESSION = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const PUBLIC_SORT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function mutableNullPrototypeRecord<T>(): Record<string, T> {
  const record: Record<string, T> = {};
  Object.setPrototypeOf(record, null);
  return record;
}

function defineSqlIdentifierCatalogV1<
  const TEntries extends Readonly<Record<string, SqlIdentifierCatalogEntryV1>>,
>(
  entries: TEntries,
): Readonly<{
  readonly schemaVersion: typeof SQL_IDENTIFIER_CATALOG_SCHEMA_VERSION;
  readonly entries: {
    readonly [TRoute in keyof TEntries]: Readonly<{
      readonly requestField: TEntries[TRoute]['requestField'];
      readonly defaultKey: TEntries[TRoute]['defaultKey'];
      readonly identifiers: Readonly<TEntries[TRoute]['identifiers']>;
    }>;
  };
}> {
  const frozenEntries = mutableNullPrototypeRecord<SqlIdentifierCatalogEntryV1>();
  for (const [routeId, entry] of Object.entries(entries)) {
    const identifiers = Object.entries(entry.identifiers);
    if (!/^(?:DELETE|GET|PATCH|POST|PUT) \/[^?#]*$/.test(routeId)) {
      throw new TypeError(`invalid admin SQL identifier route: ${routeId}`);
    }
    if (identifiers.length === 0) {
      throw new TypeError(`${routeId} SQL identifier catalog must not be empty`);
    }
    if (!Object.prototype.hasOwnProperty.call(entry.identifiers, entry.defaultKey)) {
      throw new TypeError(`${routeId} default SQL identifier is absent from its catalog`);
    }
    const frozenIdentifiers = mutableNullPrototypeRecord<string>();
    for (const [key, expression] of identifiers) {
      if (!PUBLIC_SORT_KEY.test(key)) {
        throw new TypeError(`${routeId} has an invalid public sort key: ${key}`);
      }
      if (!TYPEORM_PROPERTY_EXPRESSION.test(expression)) {
        throw new TypeError(`${routeId}.${key} is not a fixed TypeORM property expression`);
      }
      frozenIdentifiers[key] = expression;
    }
    frozenEntries[routeId] = Object.freeze({
      requestField: entry.requestField,
      defaultKey: entry.defaultKey,
      identifiers: Object.freeze(frozenIdentifiers),
    });
  }
  return Object.freeze({
    schemaVersion: SQL_IDENTIFIER_CATALOG_SCHEMA_VERSION,
    entries: Object.freeze(frozenEntries),
  }) as Readonly<{
    readonly schemaVersion: typeof SQL_IDENTIFIER_CATALOG_SCHEMA_VERSION;
    readonly entries: {
      readonly [TRoute in keyof TEntries]: Readonly<{
        readonly requestField: TEntries[TRoute]['requestField'];
        readonly defaultKey: TEntries[TRoute]['defaultKey'];
        readonly identifiers: Readonly<TEntries[TRoute]['identifiers']>;
      }>;
    };
  }>;
}

export const ADMIN_SQL_IDENTIFIER_CATALOG = defineSqlIdentifierCatalogV1({
  'GET /admin/tenants': {
    requestField: 'sortBy',
    defaultKey: 'createdAt',
    identifiers: {
      createdAt: 'tenant.createdAt',
      maxUsers: 'tenant.maxUsers',
      name: 'tenant.name',
      plan: 'tenant.plan',
      status: 'tenant.status',
      updatedAt: 'tenant.updatedAt',
    },
  },
  'GET /system/errors/groups': {
    requestField: 'sortBy',
    defaultKey: 'lastSeenAt',
    identifiers: {
      firstSeenAt: 'g.firstSeenAt',
      lastSeenAt: 'g.lastSeenAt',
      occurrenceCount: 'g.occurrenceCount',
      userCount: 'g.userCount',
    },
  },
} as const);

export type AdminSqlIdentifierRouteId = keyof typeof ADMIN_SQL_IDENTIFIER_CATALOG.entries;

export type AdminSqlIdentifierKey<TRoute extends AdminSqlIdentifierRouteId> =
  keyof (typeof ADMIN_SQL_IDENTIFIER_CATALOG.entries)[TRoute]['identifiers'] & string;

export function adminSqlIdentifierKeys<TRoute extends AdminSqlIdentifierRouteId>(
  routeId: TRoute,
): readonly AdminSqlIdentifierKey<TRoute>[] {
  return Object.freeze(
    Object.keys(ADMIN_SQL_IDENTIFIER_CATALOG.entries[routeId].identifiers).sort(),
  ) as readonly AdminSqlIdentifierKey<TRoute>[];
}

export function resolveAdminSqlIdentifier<TRoute extends AdminSqlIdentifierRouteId>(
  routeId: TRoute,
  key?: AdminSqlIdentifierKey<TRoute>,
): string {
  const entry: SqlIdentifierCatalogEntryV1 = ADMIN_SQL_IDENTIFIER_CATALOG.entries[routeId];
  const resolvedKey = key ?? entry.defaultKey;
  const expression = entry.identifiers[resolvedKey];
  if (expression === undefined) {
    throw new TypeError(`${routeId}.${entry.requestField} is outside SqlIdentifierCatalogV1`);
  }
  return expression;
}

export function validateSqlIdentifierCatalogV1(value: SqlIdentifierCatalogV1): void {
  defineSqlIdentifierCatalogV1(value.entries);
}
