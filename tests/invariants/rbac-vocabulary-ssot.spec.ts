import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

import {
  HMI_ROLE_CODES,
  HMI_ROLE_VOCABULARY,
  INVITABLE_ROLE_CODES,
  PLATFORM_ROLE_CODES,
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_VOCABULARY,
  RETIRED_AQUAMOBIL_ROLE_CODES,
  RETIRED_AQUAMOBIL_ROLE_VOCABULARY,
  ROLE_VOCABULARY_REGISTRY,
  Role,
  isPlatformRole,
} from '../../libs/event-contracts/src/roles';
import { TENANT_PERMISSION_CODES } from '../../libs/event-contracts/src/tenant-permissions';
import { PLATFORM_SERVICE_CATALOG } from '../../platform/libs/service-catalog/src';
import { normalizeRole } from '../../web/apps/aquamobil/src/utils/normalize-role';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROLE_AUTHORITY = 'libs/event-contracts/src/roles.ts';
const PERMISSION_AUTHORITY = 'libs/event-contracts/src/tenant-permissions.ts';
const ROLES_GUARD = 'libs/backend-common/src/guards/roles.guard.ts';
const WORKSPACE_PROJECT_SEARCH_ROOTS = ['apps', 'libs', 'platform/libs', 'web'] as const;

interface WorkspaceProjectV1 {
  readonly name: string;
  readonly sourceRoot: string;
}

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = resolve(directory, entry);
    if (statSync(absolute).isDirectory()) return sourceFilesBelow(absolute);
    return /\.(?:ts|tsx)$/u.test(entry) ? [absolute] : [];
  });
}

function projectFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = resolve(directory, entry);
    if (!statSync(absolute).isDirectory()) return entry === 'project.json' ? [absolute] : [];
    return projectFilesBelow(absolute);
  });
}

function workspaceProjects(): ReadonlyMap<string, WorkspaceProjectV1> {
  const projects = new Map<string, WorkspaceProjectV1>();
  for (const searchRoot of WORKSPACE_PROJECT_SEARCH_ROOTS) {
    const absoluteRoot = resolve(REPO_ROOT, searchRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const projectFile of projectFilesBelow(absoluteRoot)) {
      const parsed: unknown = JSON.parse(readFileSync(projectFile, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Readonly<Record<string, unknown>>;
      if (typeof record.name !== 'string' || typeof record.sourceRoot !== 'string') continue;
      if (projects.has(record.name)) throw new TypeError(`Duplicate Nx project: ${record.name}`);
      projects.set(record.name, { name: record.name, sourceRoot: record.sourceRoot });
    }
  }
  return projects;
}

function runtimeSourceRoots(): readonly string[] {
  const projects = workspaceProjects();
  const roots = new Set<string>();
  for (const entry of PLATFORM_SERVICE_CATALOG) {
    if (entry.nxProject) {
      const project = projects.get(entry.nxProject);
      if (!project) {
        throw new TypeError(
          `Service ${entry.serviceId} references unknown Nx project ${entry.nxProject}`,
        );
      }
      roots.add(resolve(REPO_ROOT, project.sourceRoot));
    }
    if (entry.modulePath) roots.add(resolve(REPO_ROOT, entry.modulePath, 'src'));
  }
  for (const authority of [ROLE_AUTHORITY, PERMISSION_AUTHORITY, ROLES_GUARD]) {
    roots.add(dirname(resolve(REPO_ROOT, authority)));
  }
  return [...roots].filter(existsSync).sort();
}

let authorityProgram: ts.Program | undefined;
let authorityFiles: readonly string[] | undefined;
let authorityProgramRoots: readonly string[] | undefined;

const ROLE_SEMANTIC_CANDIDATE =
  /\b(?:Role|PlatformRoleCode|PLATFORM_ROLE_CODES|PLATFORM_ROLE_DEFINITIONS|isPlatformRole|roleAtLeast|SUPER_ADMIN|TENANT_ADMIN|MODULE_MANAGER|MODULE_USER|RolesGuard)\b/u;

function isProductionAuthorityFile(file: string): boolean {
  return (
    file.startsWith(`${REPO_ROOT}/`) &&
    !file.includes('/node_modules/') &&
    !file.endsWith('.d.ts') &&
    !file.includes('/generated/') &&
    !file.includes('/__tests__/') &&
    !/\.(?:spec|test)\.tsx?$/u.test(file)
  );
}

function productionAuthorityFiles(): readonly string[] {
  authorityFiles ??= Object.freeze(
    runtimeSourceRoots().flatMap(sourceFilesBelow).filter(isProductionAuthorityFile).sort(),
  );
  return authorityFiles;
}

function productionAuthorityProgramRoots(): readonly string[] {
  const authorityPaths = new Set(
    [ROLE_AUTHORITY, PERMISSION_AUTHORITY, ROLES_GUARD].map((authority) =>
      resolve(REPO_ROOT, authority),
    ),
  );
  authorityProgramRoots ??= Object.freeze(
    productionAuthorityFiles().filter(
      (file) =>
        authorityPaths.has(file) || ROLE_SEMANTIC_CANDIDATE.test(readFileSync(file, 'utf8')),
    ),
  );
  return authorityProgramRoots;
}

function productionAuthorityProgram(): ts.Program {
  if (authorityProgram) return authorityProgram;
  // The filesystem census remains exhaustive, but the semantic compiler only
  // roots files that can contain a governed role symbol or an exact literal
  // mirror. TypeScript then resolves their transitive symbol lineage. Rooting
  // all ~7k production files consumed >2 GiB and made the invariant itself
  // non-executable; this prefilter is content-complete for the closed role
  // vocabulary and keeps the proof bounded without an allowlist.
  const rootNames = productionAuthorityProgramRoots();
  const config = ts.readConfigFile(resolve(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile);
  if (config.error) {
    throw new TypeError(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  authorityProgram = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true } });
  return authorityProgram;
}

function productionAuthoritySources(): readonly ts.SourceFile[] {
  const governedFiles = new Set(productionAuthorityProgramRoots());
  return productionAuthorityProgram()
    .getSourceFiles()
    .filter((source) => governedFiles.has(source.fileName))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function literalUnionValues(type: ts.Type): readonly string[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  const values = members.flatMap((member) => (member.isStringLiteral() ? [member.value] : []));
  return values.length === members.length ? values.sort() : undefined;
}

function exactPlatformRoleTypeMirrors(): readonly string[] {
  const program = productionAuthorityProgram();
  const checker = program.getTypeChecker();
  const canonical = [...PLATFORM_ROLE_CODES].sort();
  const mirrors: string[] = [];
  for (const source of productionAuthoritySources()) {
    if (relative(REPO_ROOT, source.fileName) === ROLE_AUTHORITY) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const type = symbol
          ? checker.getDeclaredTypeOfSymbol(symbol)
          : checker.getTypeAtLocation(node);
        const values = literalUnionValues(type);
        if (
          values &&
          values.length === canonical.length &&
          values.every((v, i) => v === canonical[i])
        ) {
          mirrors.push(`${relative(REPO_ROOT, source.fileName)}#${node.name.text}`);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const type = checker.getTypeAtLocation(node.name);
        const properties = type.getProperties();
        const names = properties.map((property) => property.name).sort();
        if (names.length === canonical.length && names.every((name, i) => name === canonical[i])) {
          const selfLiteral = properties.every((property) => {
            const declaration = property.valueDeclaration ?? property.declarations?.[0];
            if (!declaration) return false;
            const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
            return propertyType.isStringLiteral() && propertyType.value === property.name;
          });
          if (selfLiteral)
            mirrors.push(`${relative(REPO_ROOT, source.fileName)}#${node.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return mirrors.sort();
}

function nonCanonicalIdentityImports(): readonly string[] {
  const checker = productionAuthorityProgram().getTypeChecker();
  const governed = new Set([
    'Role',
    'PlatformRoleCode',
    'PLATFORM_ROLE_CODES',
    'PLATFORM_ROLE_DEFINITIONS',
    'isPlatformRole',
    'roleAtLeast',
  ]);
  const violations: string[] = [];
  for (const source of productionAuthoritySources()) {
    const visit = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node)) {
        const importedName = (node.propertyName ?? node.name).text;
        if (governed.has(importedName)) {
          const alias = checker.getSymbolAtLocation(node.name);
          const target =
            alias && (alias.flags & ts.SymbolFlags.Alias) !== 0
              ? checker.getAliasedSymbol(alias)
              : alias;
          const declarationFiles =
            target?.declarations?.map((entry) =>
              relative(REPO_ROOT, entry.getSourceFile().fileName),
            ) ?? [];
          if (!declarationFiles.includes(ROLE_AUTHORITY)) {
            violations.push(
              `${relative(REPO_ROOT, source.fileName)}#${node.name.text}->${declarationFiles.join(',')}`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations.sort();
}

describe('platform role and permission vocabulary authority', () => {
  it('derives its production census from service/workspace roots and TS resolution', () => {
    const roots = runtimeSourceRoots();
    expect(productionAuthorityFiles()).toEqual(
      roots.flatMap(sourceFilesBelow).filter(isProductionAuthorityFile).sort(),
    );
    expect([...productionAuthorityProgram().getRootFileNames()].sort()).toEqual(
      [...productionAuthorityProgramRoots()].sort(),
    );
    expect(productionAuthorityProgramRoots().length).toBeLessThan(
      productionAuthorityFiles().length,
    );
    expect(productionAuthoritySources().map((source) => source.fileName)).toEqual(
      expect.arrayContaining([
        resolve(REPO_ROOT, ROLE_AUTHORITY),
        resolve(REPO_ROOT, PERMISSION_AUTHORITY),
        resolve(REPO_ROOT, ROLES_GUARD),
      ]),
    );
  });

  it('publishes the exact canonical platform vocabulary and invitation projection', () => {
    expect(PLATFORM_ROLE_CODES).toEqual(Object.values(Role));
    expect(Object.keys(PLATFORM_ROLE_DEFINITIONS).sort()).toEqual([...PLATFORM_ROLE_CODES].sort());
    expect(INVITABLE_ROLE_CODES).toEqual(
      PLATFORM_ROLE_CODES.filter((role) => role !== Role.SUPER_ADMIN),
    );
    expect(PLATFORM_ROLE_VOCABULARY).toMatchObject({
      vocabularyId: 'platform-role/v1',
      domain: 'platform-authorization',
      lifecycle: 'ACTIVE',
    });
  });

  it('registers distinct role domains and a fail-closed versioned retirement', () => {
    expect(Object.keys(ROLE_VOCABULARY_REGISTRY).sort()).toEqual([
      'aquamobil-token-role/v0',
      'platform-role/v1',
      'scada-hmi-role/v1',
    ]);
    expect(HMI_ROLE_VOCABULARY.domain).toBe('scada-operator');
    expect(HMI_ROLE_CODES.every((code) => !isPlatformRole(code))).toBe(true);
    expect(RETIRED_AQUAMOBIL_ROLE_VOCABULARY).toMatchObject({
      lifecycle: 'RETIRED',
      successorVocabularyId: 'platform-role/v1',
      retirementPolicy: 'REJECT_AT_TRUST_BOUNDARY',
    });
    expect(RETIRED_AQUAMOBIL_ROLE_CODES).toEqual(['MANAGER', 'OPERATOR', 'VIEWER']);
    expect(normalizeRole('MANAGER')).toBe(Role.MODULE_USER);
    expect(normalizeRole('OPERATOR')).toBe(Role.MODULE_USER);
    expect(normalizeRole('VIEWER')).toBe(Role.MODULE_USER);
  });

  it('uses compiler symbol lineage and admits no parallel platform-role type authority', () => {
    expect(nonCanonicalIdentityImports()).toEqual([]);
    expect(exactPlatformRoleTypeMirrors()).toEqual([]);
  });

  it('has one permission catalogue and one backend RolesGuard implementation', () => {
    expect(TENANT_PERMISSION_CODES.length).toBeGreaterThan(0);
    expect(new Set(TENANT_PERMISSION_CODES).size).toBe(TENANT_PERMISSION_CODES.length);
    const guards = productionAuthoritySources()
      .flatMap((source) => source.statements)
      .filter(ts.isClassDeclaration)
      .filter((declaration) => declaration.name?.text === 'RolesGuard')
      .map((declaration) => relative(REPO_ROOT, declaration.getSourceFile().fileName));
    expect(guards).toEqual([ROLES_GUARD]);
  });
});
