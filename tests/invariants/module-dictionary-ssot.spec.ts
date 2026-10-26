/**
 * INVARIANT: the platform's module codes have ONE declaration — the module dictionary,
 * `libs/shared-contracts/src/modules/platform-modules.ts` (RBAC-MEDIUM-023, HR-MEDIUM-064;
 * ADR-051 §2, ADR-052 Decision 4). It replaces `hr-module-code-parity.spec.ts`, which tied one
 * copy (hr's) to another (auth's) instead of tying every copy to one owner.
 *
 * Before the dictionary there were six copies — auth `ModuleCode`, hr `HrModuleCode`, alert
 * `AlertModule`, the AI specialty type, the web nav union and a tenant-admin list — and their
 * member sets already disagreed: no copy outside auth could name hr. Each check below reads the
 * repository the way the compiler, the migration runner or GraphQL codegen does:
 *
 *   1. no copy: no union, one-literal alias or enum of module codes outside the dictionary, and no
 *      list of module codes in the web (specs, migrations, generated code and test utilities are
 *      exempt — they state facts about a moment, not the vocabulary);
 *   2. GraphQL: every module enum on the wire is registered through `registerOwnerModuleEnum`, and
 *      every module-code union codegen emitted equals the dictionary;
 *   3. Postgres: each enum column bound to a dictionary constant holds exactly its labels once the
 *      owning service's migrations are replayed in order, as a tenant schema replays them;
 *   4. type names: no type name is created by two tenant-aware services — they replay into one
 *      `tenant_<uuid>` namespace, where the second `CREATE TYPE … EXCEPTION WHEN duplicate_object`
 *      would silently inherit the first one's labels;
 *   5. auth seeds the `modules` catalogue with exactly the dictionary's codes, in its order.
 */
import { dirname } from 'node:path';

import {
  OWNER_MODULE,
  OWNER_MODULE_CODES,
  PLATFORM_MODULE,
  PLATFORM_MODULE_CODES,
} from '@aquaculture/shared-contracts';
import ts from 'typescript';

import { OWNER_MODULE_GRAPHQL_ENUM_NAMES } from '../../libs/backend-common/src/graphql/owner-module.enum';
import { tenantAwareMigrationGlobsBySchema } from '../../platform/libs/service-catalog/src';

import {
  createdTypeNames,
  dictionaryBoundColumns,
  migrationFilesIn,
  moduleLiteralCopies,
  readRepoFile,
  replayEnumLabels,
  serviceMigrationFiles,
  trackedFiles,
} from './helpers/module-dictionary-sources';

const DICTIONARY = 'libs/shared-contracts/src/modules/platform-modules.ts';
const GRAPHQL_FACE = 'libs/backend-common/src/graphql/owner-module.enum.ts';
const GENERATED_SCHEMA_TYPES = 'web/shared-ui/src/generated/graphql-types.ts';
const AUTH_MODULE_ENTITY = 'apps/auth-service/src/modules/system-module/entities/module.entity.ts';
const SOURCE_ROOTS = ['apps', 'libs', 'platform', 'web', 'mcp'];

/** Each dictionary constant an enum column may be bound to, with the labels it stands for. */
const DICTIONARY_CONSTANTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['OWNER_MODULE', OWNER_MODULE_CODES],
  ['PLATFORM_MODULE', PLATFORM_MODULE_CODES],
]);

/** PLATFORM_MODULE read as key → code, for the auth seed's `PLATFORM_MODULE.<KEY>` references. */
const CODE_BY_KEY: ReadonlyMap<string, string> = new Map(Object.entries(PLATFORM_MODULE));

/** Both spellings of every code: the dictionary's and the GraphQL enum value name. */
const CODE_SPELLINGS = new Set(PLATFORM_MODULE_CODES.flatMap((code) => [code, code.toUpperCase()]));

/** Test code, migrations and generated files state facts about a moment, not the vocabulary. */
function isVocabularySource(file: string): boolean {
  return (
    /\.(ts|tsx)$/.test(file) &&
    !file.endsWith('.d.ts') &&
    file !== DICTIONARY &&
    !/\.(spec|test)\.tsx?$/.test(file) &&
    !/(^|\/)(__tests__|__fixtures__|__mocks__|migrations|generated)\//.test(file) &&
    !/^apps\/[^/]+\/src\/test-utils\//.test(file) &&
    !file.includes('/node_modules/')
  );
}

const sources = trackedFiles(SOURCE_ROOTS).filter(isVocabularySource);

describe('INVARIANT: one module dictionary (RBAC-MEDIUM-023)', () => {
  it('scans the product sources (a broken listing must not pass as "no copies")', () => {
    expect(sources.length).toBeGreaterThan(1000);
    expect(sources).toContain(AUTH_MODULE_ENTITY);
  });

  it('1. declares no copy of the module codes outside the dictionary', () => {
    const copies = sources.flatMap((file) => {
      const source = readRepoFile(file);
      if (
        ![...CODE_SPELLINGS].some(
          (code) => source.includes(`'${code}'`) || source.includes(`"${code}"`),
        )
      ) {
        return [];
      }
      return moduleLiteralCopies(file, source, CODE_SPELLINGS, { lists: file.startsWith('web/') });
    });

    expect(copies.map((copy) => `${copy.where} ${copy.kind} of ${copy.codes.join(', ')}`)).toEqual(
      [],
    );
  });

  describe('2. GraphQL', () => {
    function registrationsIn(file: string): ts.CallExpression[] {
      const source = readRepoFile(file);
      if (!source.includes('registerOwnerModuleEnum') && !source.includes('registerEnumType')) {
        return [];
      }
      const calls: ts.CallExpression[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ['registerOwnerModuleEnum', 'registerEnumType'].includes(node.expression.text)
        ) {
          calls.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
      return calls;
    }

    const registrations = sources
      .filter((file) => file !== GRAPHQL_FACE)
      .flatMap((file) => registrationsIn(file).map((call) => ({ file, call })));

    it('registers each module enum name through registerOwnerModuleEnum, in exactly one service', () => {
      const byName = new Map<string, string[]>();
      for (const { file, call } of registrations) {
        const [name] = call.arguments;
        if (
          ts.isIdentifier(call.expression) &&
          call.expression.text === 'registerOwnerModuleEnum' &&
          name !== undefined &&
          ts.isStringLiteralLike(name)
        ) {
          byName.set(name.text, [...(byName.get(name.text) ?? []), file]);
        }
      }

      expect([...byName.keys()].sort()).toEqual([...OWNER_MODULE_GRAPHQL_ENUM_NAMES].sort());
      for (const [name, files] of byName) {
        expect({ name, files: files.length }).toEqual({ name, files: 1 });
      }
    });

    it('registers no module enum by hand: no registerEnumType of a dictionary constant or a module enum name', () => {
      const handRegistered = registrations.flatMap(({ file, call }) => {
        if (!ts.isIdentifier(call.expression) || call.expression.text !== 'registerEnumType') {
          return [];
        }
        const [target, options] = call.arguments;
        const name =
          options !== undefined && ts.isObjectLiteralExpression(options)
            ? options.properties
                .filter(ts.isPropertyAssignment)
                .find((property) => ts.isIdentifier(property.name) && property.name.text === 'name')
                ?.initializer
            : undefined;
        const namesModuleEnum =
          name !== undefined &&
          ts.isStringLiteralLike(name) &&
          OWNER_MODULE_GRAPHQL_ENUM_NAMES.some((moduleEnum) => moduleEnum === name.text);
        const registersConstant =
          target !== undefined && ts.isIdentifier(target) && DICTIONARY_CONSTANTS.has(target.text);
        return namesModuleEnum || registersConstant ? [file] : [];
      });

      expect(handRegistered).toEqual([]);
    });

    it('emits, in the codegen output, only module-code unions that equal the dictionary', () => {
      const generated = ts.createSourceFile(
        GENERATED_SCHEMA_TYPES,
        readRepoFile(GENERATED_SCHEMA_TYPES),
        ts.ScriptTarget.Latest,
        true,
      );
      const unions: Array<{ name: string; members: string[] }> = [];
      generated.forEachChild((node) => {
        if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
          const members = node.type.types.flatMap((member) =>
            ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal)
              ? [member.literal.text]
              : [],
          );
          if (members.filter((member) => CODE_SPELLINGS.has(member)).length >= 2) {
            unions.push({ name: node.name.text, members: [...members].sort() });
          }
        }
      });
      const owner = Object.keys(OWNER_MODULE).sort();
      const platform = Object.keys(PLATFORM_MODULE).sort();

      for (const union of unions) {
        expect([union.name, union.members]).toEqual([
          union.name,
          union.members.length === platform.length ? platform : owner,
        ]);
      }
      expect(unions.filter((union) => union.members.length === owner.length)).toHaveLength(
        OWNER_MODULE_GRAPHQL_ENUM_NAMES.length,
      );
    });
  });

  describe('3. Postgres', () => {
    const columns = sources
      .filter((file) => file.startsWith('apps/') && file.endsWith('.entity.ts'))
      .flatMap((file) => {
        const source = readRepoFile(file);
        return [...DICTIONARY_CONSTANTS.keys()].some((constant) => source.includes(constant))
          ? dictionaryBoundColumns(file, source, new Set(DICTIONARY_CONSTANTS.keys()))
          : [];
      });

    it('finds the dictionary-bound enum columns (the department and alarm modules at least)', () => {
      expect(columns.map((column) => column.typeName)).toEqual(
        expect.arrayContaining(['departments_hr_modulecode_enum', 'alert_history_module_enum']),
      );
    });

    it('replays to exactly the dictionary labels for every bound column', () => {
      const mismatches = columns.flatMap((column) => {
        const replayed = replayEnumLabels(
          serviceMigrationFiles(column.serviceDir),
          column.typeName,
        );
        const expected = [...(DICTIONARY_CONSTANTS.get(column.constant) ?? [])].sort();
        const actual = replayed === undefined ? undefined : [...replayed].sort();
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? []
          : [
              `${column.where} ${column.typeName}: replayed ${JSON.stringify(actual)}, dictionary ${JSON.stringify(expected)}`,
            ];
      });

      expect(mismatches).toEqual([]);
    });
  });

  it('4. creates no type name in two tenant-aware services', () => {
    const creators = new Map<string, Set<string>>();
    for (const { glob, schema } of tenantAwareMigrationGlobsBySchema()) {
      for (const file of migrationFilesIn(dirname(glob))) {
        for (const typeName of createdTypeNames(file, readRepoFile(file))) {
          creators.set(typeName, (creators.get(typeName) ?? new Set()).add(schema));
        }
      }
    }

    expect(creators.size).toBeGreaterThan(50);
    expect(creators.get('departments_hr_modulecode_enum')).toEqual(new Set(['hr']));
    expect(creators.get('alert_history_module_enum')).toEqual(new Set(['alert']));
    expect(
      [...creators]
        .filter(([, schemas]) => schemas.size > 1)
        .map(([name, schemas]) => `${name}: ${[...schemas].join(', ')}`),
    ).toEqual([]);
  });

  it('5. seeds the auth modules catalogue with exactly the dictionary codes, in its order', () => {
    const source = readRepoFile(AUTH_MODULE_ENTITY);
    const file = ts.createSourceFile(AUTH_MODULE_ENTITY, source, ts.ScriptTarget.Latest, true);
    const seeded: string[] = [];
    const visit = (node: ts.Node, inDefaults: boolean): void => {
      const entering =
        inDefaults ||
        (ts.isMethodDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'createDefaults');
      if (
        entering &&
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'code'
      ) {
        const value = node.initializer;
        seeded.push(
          ts.isPropertyAccessExpression(value) &&
            ts.isIdentifier(value.expression) &&
            value.expression.text === 'PLATFORM_MODULE'
            ? (CODE_BY_KEY.get(value.name.text) ?? `<no PLATFORM_MODULE.${value.name.text}>`)
            : `<not a dictionary constant: ${value.getText(file)}>`,
        );
      }
      ts.forEachChild(node, (child) => visit(child, entering));
    };
    visit(file, false);

    expect(seeded).toEqual(PLATFORM_MODULE_CODES);
  });
});
