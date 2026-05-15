export interface InformationSchemaColumnShape {
  readonly data_type: string;
  readonly udt_name?: string | null;
}

export interface EntityColumnTypeShape {
  readonly type: unknown;
  readonly isArray?: boolean;
}

const UDT_TYPE_ALIASES = new Map<string, string>([
  ['bool', 'boolean'],
  ['bpchar', 'character'],
  ['float4', 'real'],
  ['float8', 'double precision'],
  ['int2', 'smallint'],
  ['int4', 'integer'],
  ['int8', 'bigint'],
  ['time', 'time without time zone'],
  ['timetz', 'time with time zone'],
  ['timestamp', 'timestamp without time zone'],
  ['timestamptz', 'timestamp with time zone'],
  ['varchar', 'character varying'],
]);

function normalizeUdtName(udtName: string | null | undefined): string | null {
  if (!udtName) return null;
  const baseName = udtName.startsWith('_') ? udtName.slice(1) : udtName;
  return UDT_TYPE_ALIASES.get(baseName) ?? baseName;
}

/**
 * information_schema reports every Postgres array as data_type='ARRAY'.
 * udt_name carries the element type (`_uuid`, `_text`, `_my_enum`), so use
 * it when comparing drift-sensitive signatures.
 */
export function normalizeInformationSchemaType(
  column: InformationSchemaColumnShape,
): string {
  if (column.data_type === 'ARRAY') {
    const elementType = normalizeUdtName(column.udt_name);
    return elementType ? `${elementType}[]` : column.data_type;
  }

  return column.data_type;
}

export function expectedEntityDbType(column: EntityColumnTypeShape): string {
  const entityType = typeof column.type === 'string' ? column.type : '';
  if (!entityType) return '';
  return column.isArray === true ? `${entityType}[]` : entityType;
}

export function isUuidTypeDrift(
  column: EntityColumnTypeShape,
  dbColumn: InformationSchemaColumnShape,
): boolean {
  const expected = expectedEntityDbType(column);
  if (expected !== 'uuid' && expected !== 'uuid[]') return false;
  return normalizeInformationSchemaType(dbColumn) !== expected;
}
