/**
 * P-30 kural spec'i (FARM-MEDIUM-230, tier-3 make-it-detectable):
 * feeding-protocol servislerindeki HAM SQL'in referans verdiği her kolon,
 * ilgili TypeORM entity tanımında VAR olmalıdır.
 *
 * P-30'un bug sınıfı: v1 motoru `feeding_protocols."isDeleted"` kolonunu
 * filtreliyordu — kolon ne migration'da ne entity'de vardı; her çağrı yutulan
 * exception üretiyordu. Bu kapı aynı sınıfın v2'de yeniden doğmasını derleme
 * zamanında (CI) yakalar:
 *
 *  - `.query(` çağrılarına geçen backtick SQL'leri taranır;
 *  - FROM/JOIN alias'ları tabloya bağlanır; `alias."Col"` / `alias.col`
 *    referansları ve `UPDATE "tablo" SET "col"` kolonları çıkarılır;
 *  - Kolon evreni entity metadata'sından (getMetadataArgsStorage — kalıtım
 *    zinciri dahil) gelir; SQL'de görülen ama kayıtlı olmayan TABLO da fail
 *    eder (yeni tablo → aşağıdaki registry'ye entity'siyle eklenir).
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

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SCAN_DIR = 'apps/farm-service/src/feeding-protocol';

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
};

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

describe('P-30 kuralı: feeding-protocol ham SQL kolonları entity-destekli', () => {
  const files = execFileSync('git', ['ls-files', SCAN_DIR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => /\.ts$/.test(file) && !/\.spec\.ts$/.test(file) && !/__tests__/.test(file));

  const allRefs: SqlRef[] = [];
  const allTables = new Set<string>();

  beforeAll(() => {
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const sql of extractSqlLiterals(source)) {
        const { refs, tables } = collectRefs(file, sql);
        allRefs.push(...refs);
        for (const table of tables) allTables.add(table);
      }
    }
  });

  it('tarama gerçekten SQL buluyor (kapı sessizce boşa dönemez)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(allRefs.length).toBeGreaterThan(10);
  });

  it('SQL\'de görülen her tablo registry\'de entity\'siyle kayıtlı', () => {
    const unknown = [...allTables].filter((table) => !TABLE_ENTITY_REGISTRY[table]);
    expect(
      unknown.length === 0
        ? ''
        : `Registry'de olmayan tablo(lar): ${unknown.join(', ')} — TABLE_ENTITY_REGISTRY'ye entity'siyle ekleyin`,
    ).toBe('');
  });

  it('öz-doğrulama: P-30 fixture\'ı (var olmayan kolon) yakalanıyor', () => {
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
});
