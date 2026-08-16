/**
 * Unit tests for tools/gates/expand-contract-ast.ts. Exercises the
 * inspectFile + validateInspections entry points with synthetic
 * migration source fixtures via a temp directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface DecoratorInspection {
  readonly className: string;
  readonly filePath: string;
  readonly hasDecorator: boolean;
  readonly phase?: 'expand' | 'contract';
  readonly dependsOn?: string;
  readonly hasBreakingDdl: boolean;
}

interface ExpandContractAstModule {
  readonly inspectFile: (path: string) => readonly DecoratorInspection[];
  readonly validateInspections: (inspections: readonly DecoratorInspection[]) => ReadonlyArray<{
    readonly kind: string;
    readonly severity: 'error' | 'warn';
    readonly className: string;
    readonly filePath: string;
    readonly details: string;
  }>;
  readonly main: (argv: readonly string[]) => number;
}

const {
  inspectFile,
  validateInspections,
  main: astMain,
} = jest.requireActual<ExpandContractAstModule>(
  resolve(__dirname, '../../../../../../tools/gates/expand-contract-ast'),
);

describe('expand-contract-ast inspectFile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ec-ast-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeMig = (name: string, src: string): string => {
    const path = join(tmp, name);
    writeFileSync(path, src);
    return path;
  };

  it('detects @ExpandContract(phase=expand) and preserves no dependsOn', () => {
    const path = writeMig(
      '1700000000000-AddFoo.ts',
      `
import { MigrationInterface } from 'typeorm';
import { ExpandContract } from '@aquaculture/backend-common/database';

@ExpandContract({ phase: 'expand' })
export class AddFoo1700000000000 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}
`,
    );
    const results = inspectFile(path);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      className: 'AddFoo1700000000000',
      hasDecorator: true,
      phase: 'expand',
    });
    expect(results[0]?.dependsOn).toBeUndefined();
  });

  it('detects phase=contract with dependsOn', () => {
    const path = writeMig(
      '1700000000001-DropLegacyFoo.ts',
      `
import { MigrationInterface } from 'typeorm';
import { ExpandContract } from '@aquaculture/backend-common/database';

@ExpandContract({ phase: 'contract', dependsOn: 'AddFoo1700000000000' })
export class DropLegacyFoo1700000000001 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}
`,
    );
    expect(inspectFile(path)[0]).toMatchObject({
      phase: 'contract',
      dependsOn: 'AddFoo1700000000000',
      hasDecorator: true,
    });
  });

  it('reports no decorator when bare class', () => {
    const path = writeMig(
      '1700000000002-Bare.ts',
      `
import { MigrationInterface } from 'typeorm';
export class Bare1700000000002 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}
`,
    );
    expect(inspectFile(path)[0]?.hasDecorator).toBe(false);
  });

  it('breaking DDL in up() flags hasBreakingDdl=true', () => {
    const path = writeMig(
      '1700000000003-BreakingUp.ts',
      `
import { MigrationInterface, QueryRunner } from 'typeorm';
export class BreakingUp implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(\`ALTER TABLE t DROP COLUMN x\`);
  }
  async down(): Promise<void> {}
}
`,
    );
    expect(inspectFile(path)[0]?.hasBreakingDdl).toBe(true);
  });

  it('breaking DDL ONLY in down() does NOT flag hasBreakingDdl', () => {
    const path = writeMig(
      '1700000000004-SafeUp.ts',
      `
import { MigrationInterface, QueryRunner } from 'typeorm';
export class SafeUp implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(\`CREATE TABLE t (id uuid PRIMARY KEY)\`);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(\`DROP TABLE t\`);
  }
}
`,
    );
    expect(inspectFile(path)[0]?.hasBreakingDdl).toBe(false);
  });
});

describe('expand-contract-ast validateInspections', () => {
  it('contract phase without dependsOn → error', () => {
    const result = validateInspections([
      {
        className: 'BadContract',
        filePath: '/fake/path.ts',
        hasDecorator: true,
        phase: 'contract',
        hasBreakingDdl: true,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('contract_missing_dependsOn');
    expect(result[0]?.severity).toBe('error');
  });

  it('contract phase with unresolved dependsOn → error', () => {
    const result = validateInspections([
      {
        className: 'Good',
        filePath: '/fake/1.ts',
        hasDecorator: true,
        phase: 'contract',
        dependsOn: 'NonexistentMig',
        hasBreakingDdl: false,
      },
    ]);
    expect(result[0]?.kind).toBe('dependsOn_unresolved');
    expect(result[0]?.severity).toBe('error');
  });

  it('contract phase with resolvable dependsOn via file name → clean', () => {
    const result = validateInspections([
      {
        className: 'ExpandMig',
        filePath: '/fake/1700000000000-ExpandMig.ts',
        hasDecorator: true,
        phase: 'expand',
        hasBreakingDdl: false,
      },
      {
        className: 'ContractMig',
        filePath: '/fake/1700000000001-ContractMig.ts',
        hasDecorator: true,
        phase: 'contract',
        dependsOn: 'ExpandMig',
        hasBreakingDdl: true,
      },
    ]);
    // Only the expand-phase SHOULD emit nothing; the contract is clean
    // because ExpandMig is known. hasBreakingDdl on ContractMig is
    // fine — it has the decorator.
    expect(result).toEqual([]);
  });

  it('breaking DDL without decorator → warn (not block)', () => {
    const result = validateInspections([
      {
        className: 'LegacyDrop',
        filePath: '/fake/1700000000005-LegacyDrop.ts',
        hasDecorator: false,
        hasBreakingDdl: true,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('breaking_ddl_without_decorator');
    expect(result[0]?.severity).toBe('warn');
  });

  it('clean migration → no violations', () => {
    const result = validateInspections([
      {
        className: 'CleanAdd',
        filePath: '/fake/1700000000006-CleanAdd.ts',
        hasDecorator: true,
        phase: 'expand',
        hasBreakingDdl: false,
      },
    ]);
    expect(result).toEqual([]);
  });
});

describe('expand-contract-ast main exits', () => {
  let stdoutSpy: jest.SpyInstance;
  const chunks: string[] = [];
  beforeEach(() => {
    chunks.length = 0;
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(c.toString());
      return true;
    });
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('current repo passes (exit 0) — historical migrations may emit warnings but not errors', () => {
    const code = astMain([]);
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('scanned');
  });
});
