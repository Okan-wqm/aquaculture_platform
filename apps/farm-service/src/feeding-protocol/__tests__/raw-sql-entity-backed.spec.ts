/**
 * P-30 kural spec'i (FARM-MEDIUM-230 + FARM-LOW-274, tier-3 make-it-detectable):
 * feeding yüzeyindeki (feeding-protocol / feeding / storage) HAM SQL'in ve
 * QueryBuilder ham şartlarının referans verdiği her kolon, ilgili TypeORM
 * entity tanımında VAR olmalıdır.
 *
 * P-30'un bug sınıfı: v1 motoru `feeding_protocols."isDeleted"` kolonunu
 * filtreliyordu — kolon ne migration'da ne entity'de vardı; her çağrı yutulan
 * exception üretiyordu. FARM-CRITICAL-237 aynı sınıfın QueryBuilder ayağıydı:
 * `'loc.id = inv."storageLocationId"'` — TypeORM TIRNAKLI referansı
 * property-eşlemesine sokmaz, SQL'e birebir geçirir; gerçek kolon
 * `storage_location_id` olduğu için site-kapsamlı HER yem düşümü
 * `42703 column inv.storageLocationId does not exist` ile patlıyordu ve tüm
 * testler mock repo kullandığı için yeşildi.
 *
 * Kapı üç yüzeyi birden tarar:
 *
 *  1. `.query(` çağrılarına geçen backtick SQL'ler — FROM/JOIN alias'ları
 *     tabloya bağlanır; `alias."Col"` / `alias.col` referansları,
 *     `UPDATE "tablo" SET "col"` ve `INSERT INTO "tablo" (kolon listesi)`
 *     kolonları çıkarılır;
 *  2. QueryBuilder ham şartlarındaki TIRNAKLI `alias."Col"` referansları —
 *     alias `createQueryBuilder(Entity, 'a')` / `tenantManagerRepo(m, Entity,
 *     t).createQueryBuilder('a')` / `innerJoin(Entity, 'a', …)` biçimlerinden
 *     çözülür ve kolon adı entity'nin GERÇEK DB kolon adına (`options.name ??
 *     propertyName`) karşı doğrulanır. Alias çözülemiyorsa test FAIL eder:
 *     tırnaklı referans yerine property sözdizimi kullanılmalıdır (eşleme
 *     sorumluluğu ORM'de kalsın);
 *  3. Tenant-scoped tablolara yazan ham `UPDATE`/`DELETE` ifadelerinde
 *     `tenantId` predikatı zorunludur (search_path'e güvenen sessiz
 *     çapraz-tenant yazımı kapanır).
 *
 * Kolon evreni entity metadata'sından (getMetadataArgsStorage — kalıtım
 * zinciri dahil) gelir; SQL'de görülen ama kayıtlı olmayan TABLO da fail
 * eder (yeni tablo → aşağıdaki registry'ye entity'siyle eklenir).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { getMetadataArgsStorage } from 'typeorm';

import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingMeal } from '../entities/feeding-meal.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import { FeedingForecastSnapshot } from '../entities/feeding-forecast-snapshot.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Department } from '../../department/entities/department.entity';
import { Site } from '../../site/entities/site.entity';
import { StockMovement } from '../../storage/entities/stock-movement.entity';
import { StorageInventory } from '../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { FarmMobileCommandReceipt } from '../../mobile-command/entities/farm-mobile-command-receipt.entity';
import { DailyFeedingExecution } from '../../feeding/entities/daily-feeding-execution.entity';
import { FeedingProgram } from '../../feeding/entities/feeding-program.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { StorageLotMix } from '../../storage/entities/storage-lot-mix.entity';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
/**
 * Tarama kapsamı: yem düşümünün uçtan uca geçtiği üç dizin. FARM-CRITICAL-237
 * `storage/` içindeydi ve yalnız `feeding-protocol/` tarandığı için kapıya
 * hiç görünmedi — kapsam, bug'ın yaşayabileceği yüzeyle aynı olmalı.
 */
const SCAN_DIRS = [
  'apps/farm-service/src/feeding-protocol',
  'apps/farm-service/src/feeding',
  'apps/farm-service/src/storage',
];

/** TypeORM entity sınıfı referansı (metadata target karşılaştırması için). */
type EntityClass = new (...args: never[]) => object;

/**
 * Tablo → entity kaydı. SQL'de görülen her tablo BURADA olmak zorunda —
 * eksikse test, hangi tablonun ekleneceğini söyleyerek fail eder (kapı
 * büyür, sessiz boşluk bırakmaz).
 */
const TABLE_ENTITY_REGISTRY: Record<string, EntityClass> = {
  feeding_day_plans: FeedingDayPlan,
  feeding_meals: FeedingMeal,
  feeding_protocols_v2: FeedingProtocolV2,
  feeding_protocol_assignments: ProtocolAssignment,
  feeding_forecast_snapshots: FeedingForecastSnapshot,
  tank_batches: TankBatch,
  batches_v2: Batch,
  equipment: Equipment,
  departments: Department,
  sites: Site,
  stock_movements: StockMovement,
  storage_inventory: StorageInventory,
  storage_locations: StorageLocation,
  feeding_records: FeedingRecord,
  farm_mobile_command_receipts: FarmMobileCommandReceipt,
  daily_feeding_executions: DailyFeedingExecution,
  feeding_programs: FeedingProgram,
  feeds: Feed,
  tanks: Tank,
  storage_lot_mixes: StorageLotMix,
};

/** Entity SINIF ADI → sınıf (QueryBuilder alias çözümü için). */
const ENTITY_BY_CLASS_NAME = new Map<string, EntityClass>(
  Object.values(TABLE_ENTITY_REGISTRY).map((entity) => [entity.name, entity]),
);

/**
 * Tenant-scoped feeding tabloları: ham `UPDATE`/`DELETE` ifadeleri `tenantId`
 * predikatı taşımak ZORUNDA (search_path tek başına çapraz-tenant yazımı
 * engellemez — id listesi başka bir tenant'tan gelirse sessizce yazar).
 */
const TENANT_WRITE_GUARDED_TABLES = new Set([
  'feeding_day_plans',
  'feeding_meals',
  'feeding_protocol_assignments',
  'feeding_protocols_v2',
  'feeding_records',
  'tank_batches',
]);

function columnNamesFor(entity: EntityClass): Set<string> {
  const storage = getMetadataArgsStorage();
  const names = new Set<string>();
  // Kalıtım zinciri: kolonlar üst sınıf target'ında kayıtlı olabilir.
  const chain: unknown[] = [];
  let current: unknown = entity;
  while (typeof current === 'function') {
    chain.push(current);
    current = Object.getPrototypeOf(current);
  }
  for (const column of storage.columns) {
    if (chain.includes(column.target)) {
      names.add((column.options.name ?? column.propertyName).toLowerCase());
    }
  }
  return names;
}

interface SqlRef {
  file: string;
  table: string;
  column: string;
  context: string;
}

function extractSqlLiterals(source: string): string[] {
  const literals: string[] = [];
  // .query( çağrısına geçen backtick literal — interpolasyonlar maskeleyerek.
  const queryCall = /\.query\(\s*`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = queryCall.exec(source)) !== null) {
    literals.push(match[1]!.replace(/\$\{[^}]*\}/g, ' __interp__ '));
  }
  return literals;
}

function collectRefs(file: string, sql: string): { refs: SqlRef[]; tables: Set<string> } {
  const refs: SqlRef[] = [];
  const tables = new Set<string>();

  // alias → tablo (FROM/JOIN "tablo" [AS] alias).
  const aliasMap = new Map<string, string>();
  const aliasRe = /(?:FROM|JOIN)\s+"([a-z_]+)"\s+(?:AS\s+)?([a-zA-Z_]\w*)/gi;
  let match: RegExpExecArray | null;
  while ((match = aliasRe.exec(sql)) !== null) {
    const [, table, alias] = match;
    if (/^(WHERE|SET|ON|USING|LEFT|RIGHT|INNER|ORDER|GROUP|JOIN)$/i.test(alias!)) {
      tables.add(table!);
      continue;
    }
    aliasMap.set(alias!, table!);
    tables.add(table!);
  }
  // Alias'sız FROM/UPDATE/INSERT hedefleri.
  const bareTableRe = /(?:FROM|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"([a-z_]+)"/gi;
  while ((match = bareTableRe.exec(sql)) !== null) {
    tables.add(match[1]!);
  }

  // alias."Kolon" ve alias.kolon referansları (yalnız bilinen alias'lar —
  // jsonb fonksiyon alias'ları vb. gürültü olarak elenir).
  const refRe = /\b([a-zA-Z_]\w*)\.(?:"([A-Za-z_]\w*)"|([a-z_]\w*))/g;
  while ((match = refRe.exec(sql)) !== null) {
    const [, alias, quoted, unquoted] = match;
    const table = aliasMap.get(alias!);
    if (!table) continue;
    const column = (quoted ?? unquoted)!;
    if (column === '__interp__') continue;
    refs.push({ file, table, column: column.toLowerCase(), context: match[0]! });
  }

  // INSERT INTO "tablo" (kolon listesi) — 18 kolonluk day-plan INSERT'i dahil
  // (T-2: bu yüzey daha önce tamamen kapsam dışıydı; entity'de olmayan bir
  // kolon eklense kapı yeşil kalır, 06:00 üretimi her tenant'ta patlardı).
  const insertRe = /INSERT\s+INTO\s+"?([a-z_]+)"?\s*\(([^)]*)\)/gi;
  while ((match = insertRe.exec(sql)) !== null) {
    const [, table, columnList] = match;
    tables.add(table!);
    for (const raw of columnList!.split(',')) {
      const column = raw.trim().replace(/^"|"$/g, '');
      // Fonksiyon/ifade içeren girdiler kolon listesi değildir (VALUES vb.).
      if (!/^[A-Za-z_]\w*$/.test(column)) continue;
      refs.push({
        file,
        table: table!,
        column: column.toLowerCase(),
        context: `INSERT INTO ${table} (… ${column} …)`,
      });
    }
  }

  // UPDATE "tablo" SET "a" = ..., "b" = ... kolonları.
  const updateRe = /UPDATE\s+"([a-z_]+)"\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/gi;
  while ((match = updateRe.exec(sql)) !== null) {
    const [, table, setClause] = match;
    tables.add(table!);
    const setCol = /"([A-Za-z_]\w*)"\s*=/g;
    let setMatch: RegExpExecArray | null;
    while ((setMatch = setCol.exec(setClause!)) !== null) {
      refs.push({
        file,
        table: table!,
        column: setMatch[1]!.toLowerCase(),
        context: `UPDATE ${table} SET ${setMatch[1]}`,
      });
    }
  }

  return { refs, tables };
}

/**
 * Tenant-scoped tabloya yazan ham `UPDATE`/`DELETE` ifadesinde `tenantId`
 * predikatı arar. Yoksa yazım yalnız search_path'e güveniyordur: id listesi
 * başka bir tenant'tan gelirse satır sessizce güncellenir.
 */
function findTenantUnguardedWrites(file: string, sql: string): string[] {
  const offenders: string[] = [];
  const writeRe = /\b(UPDATE|DELETE\s+FROM)\s+"?([a-z_]+)"?([\s\S]*?)(?=;|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = writeRe.exec(sql)) !== null) {
    const [, verb, table, body] = match;
    if (!TENANT_WRITE_GUARDED_TABLES.has(table!)) continue;
    if (/"?tenantId"?\s*=/i.test(body!)) continue;
    offenders.push(`${file}: ${verb!.toUpperCase()} ${table} — tenantId predikatı yok`);
  }
  return offenders;
}

/** Yorum satırlarını maskeler — docblock'taki örnek SQL kapıyı tetiklemesin. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** `.query(` backtick literal'lerini maskeler (onlar ham-SQL yolunda taranır). */
function maskRawQueryLiterals(source: string): string {
  return source.replace(/\.query\(\s*`[^`]*`/g, '.query(` `');
}

interface QueryBuilderRef {
  file: string;
  alias: string;
  column: string;
  entity?: EntityClass;
  context: string;
}

/**
 * QueryBuilder ham şartlarındaki TIRNAKLI `alias."Col"` referanslarını çıkarır
 * ve alias'ı entity'sine bağlar. TypeORM tırnaklı ifadeyi property-eşlemesine
 * SOKMAZ; dolayısıyla yazılan ad GERÇEK DB kolon adı olmak zorundadır
 * (FARM-CRITICAL-237'nin bug sınıfı).
 */
function collectQueryBuilderRefs(file: string, rawSource: string): QueryBuilderRef[] {
  const source = maskRawQueryLiterals(stripComments(rawSource));
  const aliasEntity = new Map<string, EntityClass | undefined>();

  // createQueryBuilder(Entity, 'alias') | createQueryBuilder('alias')
  const createRe = /createQueryBuilder\(\s*(?:([A-Z]\w*)\s*,\s*)?['"]([A-Za-z_]\w*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(source)) !== null) {
    const [, explicitEntity, alias] = match;
    if (explicitEntity) {
      aliasEntity.set(alias!, ENTITY_BY_CLASS_NAME.get(explicitEntity));
      continue;
    }
    // Repo formu: `tenantManagerRepo(manager, StorageInventory, tenantId)
    //   .createQueryBuilder('inv')` — entity adı hemen öncesindeki çağrıda.
    const window = source.slice(Math.max(0, match.index - 240), match.index);
    const candidates = [...window.matchAll(/\b([A-Z]\w*)\b/g)]
      .map((m) => m[1]!)
      .filter((name) => ENTITY_BY_CLASS_NAME.has(name));
    aliasEntity.set(alias!, ENTITY_BY_CLASS_NAME.get(candidates[candidates.length - 1] ?? ''));
  }

  // innerJoin(Entity, 'alias', 'şart') ve leftJoin varyantları.
  const joinRe =
    /(?:innerJoin|leftJoin|innerJoinAndSelect|leftJoinAndSelect|innerJoinAndMapOne|leftJoinAndMapOne)\(\s*([A-Z]\w*)\s*,\s*['"]([A-Za-z_]\w*)['"]/g;
  while ((match = joinRe.exec(source)) !== null) {
    const [, entityName, alias] = match;
    aliasEntity.set(alias!, ENTITY_BY_CLASS_NAME.get(entityName!));
  }

  if (aliasEntity.size === 0) return [];

  const refs: QueryBuilderRef[] = [];
  const quotedRe = /\b([a-zA-Z_]\w*)\."([A-Za-z_]\w*)"/g;
  while ((match = quotedRe.exec(source)) !== null) {
    const [, alias, column] = match;
    if (!aliasEntity.has(alias!)) continue;
    refs.push({
      file,
      alias: alias!,
      column: column!,
      entity: aliasEntity.get(alias!),
      context: match[0]!,
    });
  }
  return refs;
}

/** Entity'nin GERÇEK DB kolon adları (`options.name ?? propertyName`, ham hâl). */
function dbColumnNamesFor(entity: EntityClass): Set<string> {
  const storage = getMetadataArgsStorage();
  const names = new Set<string>();
  const chain: unknown[] = [];
  let current: unknown = entity;
  while (typeof current === 'function') {
    chain.push(current);
    current = Object.getPrototypeOf(current);
  }
  for (const column of storage.columns) {
    if (chain.includes(column.target)) {
      names.add(column.options.name ?? column.propertyName);
    }
  }
  return names;
}

describe('P-30 kuralı: feeding yüzeyi ham SQL kolonları entity-destekli', () => {
  const files = execFileSync('git', ['ls-files', ...SCAN_DIRS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => /\.ts$/.test(file) && !/\.spec\.ts$/.test(file) && !/__tests__/.test(file));

  const allRefs: SqlRef[] = [];
  const allTables = new Set<string>();
  const allQbRefs: QueryBuilderRef[] = [];
  const tenantUnguardedWrites: string[] = [];

  beforeAll(() => {
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const sql of extractSqlLiterals(source)) {
        const { refs, tables } = collectRefs(file, sql);
        allRefs.push(...refs);
        for (const table of tables) allTables.add(table);
        tenantUnguardedWrites.push(...findTenantUnguardedWrites(file, sql));
      }
      allQbRefs.push(...collectQueryBuilderRefs(file, source));
    }
  });

  it('tarama gerçekten SQL buluyor (kapı sessizce boşa dönemez)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(allRefs.length).toBeGreaterThan(10);
  });

  it("SQL'de görülen her tablo registry'de entity'siyle kayıtlı", () => {
    const unknown = [...allTables].filter((table) => !TABLE_ENTITY_REGISTRY[table]);
    expect(
      unknown.length === 0
        ? ''
        : `Registry'de olmayan tablo(lar): ${unknown.join(', ')} — TABLE_ENTITY_REGISTRY'ye entity'siyle ekleyin`,
    ).toBe('');
  });

  it("öz-doğrulama: P-30 fixture'ı (var olmayan kolon) yakalanıyor", () => {
    // v1 bug'ının birebir şekli: SQL entity'de olmayan kolonu filtreliyor.
    const { refs } = collectRefs(
      'fixture.ts',
      'SELECT p."isDeleted" FROM "feeding_protocol_assignments" p WHERE p."bogusColumn" = 1',
    );
    const columns = columnNamesFor(TABLE_ENTITY_REGISTRY['feeding_protocol_assignments']!);
    const offenders = refs.filter((ref) => !columns.has(ref.column));
    expect(offenders.map((ref) => ref.column)).toContain('boguscolumn');
  });

  it('her kolon referansı entity tanımında var (P-30 bug sınıfı yapısal ölü)', () => {
    const columnsByTable = new Map<string, Set<string>>(
      Object.entries(TABLE_ENTITY_REGISTRY).map(([table, entity]) => [
        table,
        columnNamesFor(entity),
      ]),
    );
    const offenders = allRefs.filter((ref) => {
      const columns = columnsByTable.get(ref.table);
      return columns !== undefined && !columns.has(ref.column);
    });
    const report = offenders
      .map((ref) => `  ${ref.file}: ${ref.table}.${ref.column} (${ref.context})`)
      .join('\n');
    expect(
      offenders.length === 0
        ? ''
        : `Entity'de olmayan kolona SQL referansı (P-30 sınıfı):\n${report}`,
    ).toBe('');
  });

  it("öz-doğrulama: QueryBuilder tırnaklı-alias fixture'ı (FARM-CRITICAL-237) yakalanıyor", () => {
    // Bug'ın birebir şekli: entity kolonu `storage_location_id` iken şart
    // `inv."storageLocationId"` yazıyor; TypeORM bunu ÇEVİRMEZ.
    const fixture = `
      const q = tenantManagerRepo(manager, StorageInventory, tenantId).createQueryBuilder('inv');
      q.innerJoin(StorageLocation, 'loc', 'loc.id = inv."storageLocationId" AND loc."siteId" = :s');
    `;
    const refs = collectQueryBuilderRefs('fixture.ts', fixture);
    const offenders = refs.filter(
      (ref) => ref.entity !== undefined && !dbColumnNamesFor(ref.entity).has(ref.column),
    );
    expect(offenders.map((ref) => ref.context).sort()).toEqual([
      'inv."storageLocationId"',
      'loc."siteId"',
    ]);
  });

  it('QueryBuilder tırnaklı kolon referansları GERÇEK DB kolon adıyla eşleşiyor', () => {
    const unresolved = allQbRefs.filter((ref) => ref.entity === undefined);
    const mismatched = allQbRefs.filter(
      (ref) => ref.entity !== undefined && !dbColumnNamesFor(ref.entity).has(ref.column),
    );
    const report = [
      ...unresolved.map(
        (ref) =>
          `  ${ref.file}: ${ref.context} — alias '${ref.alias}' entity'ye bağlanamadı;` +
          ` tırnaklı referans yerine property sözdizimi kullanın (${ref.alias}.${ref.column})`,
      ),
      ...mismatched.map(
        (ref) =>
          `  ${ref.file}: ${ref.context} — gerçek kolon adı değil;` +
          ` property sözdizimi (${ref.alias}.${ref.column}) TypeORM'e çevirtir`,
      ),
    ].join('\n');
    expect(
      report === ''
        ? ''
        : `QueryBuilder ham şartında çevrilmeyen kolon referansı (FARM-CRITICAL-237 sınıfı):\n${report}`,
    ).toBe('');
  });

  it('tenant-scoped tablolara ham UPDATE/DELETE tenantId predikatı taşıyor', () => {
    expect(
      tenantUnguardedWrites.length === 0
        ? ''
        : `search_path'e güvenen tenant-korumasız yazım:\n${tenantUnguardedWrites.join('\n')}`,
    ).toBe('');
  });
});
