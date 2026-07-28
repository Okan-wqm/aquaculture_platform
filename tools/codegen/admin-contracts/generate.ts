/**
 * Admin REST contract generator.
 *
 * Reads the backend types named in `manifest.ts` through the TypeScript
 * compiler and emits them as plain wire interfaces into the admin panel's own
 * source tree. The panel then RE-EXPORTS rather than re-declares, so a backend
 * shape change lands on the frontend as a regenerated file — not as drift
 * nobody notices until a page renders `undefined`.
 *
 * # Why the compiler API and not OpenAPI
 *
 * admin-api bootstraps no `SwaggerModule`, and its responses are interfaces and
 * utility types (`IStandardPaginatedResult<T>`, `Omit<Entity, secrets>`), which
 * OpenAPI cannot express without converting every response to a decorated
 * class. The compiler already knows these shapes exactly, including through
 * `Omit`, intersections and inheritance, so it is the accurate source.
 *
 * # What "wire form" means here
 *
 * The emitted type describes what arrives at `JSON.parse`, not what the
 * backend holds in memory:
 *
 *   - `Date` becomes `string`. This is the single most common hand-written
 *     mistake in the panel — admin-api declares 78 `Date` fields and the panel
 *     had 35 of them as `string`, leaving the rest to guesswork.
 *   - `undefined` is stripped from optional unions: `JSON.stringify` omits the
 *     key entirely, so `field?: T` is the honest shape and `T | undefined` is
 *     noise.
 *   - Enums become unions of their VALUES, since that is what serializes.
 *   - Methods are refused outright, because a type carrying behaviour is a
 *     persistence object about to be put on a response by mistake.
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import ts from 'typescript';

import { ADMIN_CONTRACT_SOURCES, type ContractSource } from './manifest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const OUTPUT = 'web/modules/admin-panel/src/services/types/generated/admin-contracts.ts';

/** A named shape queued for emission, in discovery order. */
interface EmittedType {
  readonly name: string;
  readonly module: string;
  readonly origin: string;
  readonly body: string;
}

class ContractGenerationError extends Error {}

/** `FeatureToggleScope` → `FEATURE_TOGGLE_SCOPE`. */
function screamingSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}


// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

function createProgram(files: readonly string[]): ts.Program {
  return ts.createProgram({
    rootNames: files.map((file) => resolve(REPO_ROOT, file)),
    options: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      // The generator reads types; it never emits JS, and a decorator or a
      // missing @types package must not stop it from resolving a shape.
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: REPO_ROOT,
      paths: readPathsFromBaseTsconfig(),
    },
  });
}

/** Reuse the repo's own path aliases so cross-package imports resolve. */
function readPathsFromBaseTsconfig(): Record<string, string[]> {
  const configPath = resolve(REPO_ROOT, 'tsconfig.base.json');
  if (!existsSync(configPath)) {
    return {};
  }
  const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const paths = (parsed.config as { compilerOptions?: { paths?: Record<string, string[]> } })
    ?.compilerOptions?.paths;
  return paths ?? {};
}

function findExportedSymbol(
  program: ts.Program,
  checker: ts.TypeChecker,
  source: ContractSource,
  exportName: string,
): ts.Symbol {
  const filePath = resolve(REPO_ROOT, source.file);
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) {
    throw new ContractGenerationError(
      `manifest names ${source.file}, which the compiler did not load. ` +
        `Check the path is repo-relative and the file is part of the program.`,
    );
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new ContractGenerationError(`${source.file} exports nothing the compiler can see.`);
  }

  const match = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);
  if (!match) {
    throw new ContractGenerationError(
      `${source.file} does not export "${exportName}". ` +
        `The manifest is the SSoT — either the export was renamed (update the ` +
        `manifest and regenerate) or it was deleted (drop the entry).`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Type → wire form
// ---------------------------------------------------------------------------

class WireEmitter {
  private readonly emitted = new Map<string, EmittedType>();
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    /** Emit-name overrides, so a reference resolves to the renamed contract too. */
    private readonly renames: ReadonlyMap<string, string> = new Map(),
  ) {}

  results(): EmittedType[] {
    return [...this.emitted.values()];
  }

  /** Emit a named type and everything it transitively references. */
  emitNamed(symbol: ts.Symbol, module: string, origin: string, alias?: string): void {
    const name = alias ?? symbol.getName();
    if (this.emitted.has(name) || this.inProgress.has(name)) {
      return;
    }

    const declaration = symbol.declarations?.[0];
    if (!declaration) {
      throw new ContractGenerationError(`"${name}" has no declaration to read.`);
    }

    // A type alias to a union/primitive stays an alias — flattening it into an
    // interface would lose the union and produce something that is not the
    // contract (a status union rendered as `{}` is worse than useless).
    const aliased = this.tryEmitAlias(name, declaration, module, origin);
    if (aliased) {
      return;
    }

    this.inProgress.add(name);
    const type = this.checker.getDeclaredTypeOfSymbol(symbol);
    const body = this.objectBody(type, name);
    this.inProgress.delete(name);

    // A generic contract keeps its parameters — resolving them here would
    // freeze one instantiation and silently drop every other.
    const parameters = this.typeParameters(declaration);
    this.emitted.set(name, {
      name,
      module,
      origin,
      body: `export interface ${name}${parameters} ${body}`,
    });
  }

  /** Enums, string-literal unions and primitive aliases keep their alias form. */
  private tryEmitAlias(
    name: string,
    declaration: ts.Declaration,
    module: string,
    origin: string,
  ): boolean {
    if (ts.isEnumDeclaration(declaration)) {
      const members = declaration.members.map((member) => {
        const value = this.checker.getConstantValue(member);
        if (typeof value !== 'string') {
          throw new ContractGenerationError(
            `enum ${name}.${member.name.getText()} is not a string enum. ` +
              `Only string enums have a stable wire form.`,
          );
        }
        return JSON.stringify(value);
      });
      // Emit the vocabulary as a VALUE as well as a type.
      //
      // A type-only union vanishes at runtime, so every dropdown that offers
      // these states has to re-list them by hand — and then it drifts. The job
      // filter offered 6 of JobStatus's 8 members, so `scheduled`, `retrying`
      // and `paused` jobs were unfilterable; the feature-toggle form omitted
      // `environment`, so that scope could not be created or edited at all.
      //
      // Deriving the type FROM the array means the two cannot disagree: one
      // declaration, usable in a `.map()` and in a `Record<T, …>` exhaustiveness
      // check alike.
      const constName = `${screamingSnake(name)}_VALUES`;
      this.emitted.set(name, {
        name,
        module,
        origin,
        body:
          `export const ${constName} = [${members.join(', ')}] as const;\n` +
          `export type ${name} = (typeof ${constName})[number];`,
      });
      return true;
    }

    if (ts.isTypeAliasDeclaration(declaration)) {
      const type = this.checker.getTypeAtLocation(declaration.type);
      // Object-shaped aliases (including Omit<>) are flattened as interfaces;
      // everything else keeps its alias.
      if (this.isObjectShape(type)) {
        return false;
      }
      this.emitted.set(name, {
        name,
        module,
        origin,
        body: `export type ${name} = ${this.render(type, name)};`,
      });
      return true;
    }

    return false;
  }

  private isObjectShape(type: ts.Type): boolean {
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      this.checker.getPropertiesOfType(type).length > 0 &&
      !this.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length
    );
  }

  /** `{ a: X; b?: Y }` for every own + inherited property, in declaration order. */
  private objectBody(type: ts.Type, owner: string, indent = ''): string {
    const properties = this.checker.getPropertiesOfType(type);
    if (properties.length === 0) {
      throw new ContractGenerationError(
        `"${owner}" resolved to a shape with no properties. ` +
          `A generic left unresolved (e.g. IStandardPaginatedResult without a ` +
          `type argument) does this — name the concrete type instead.`,
      );
    }

    const lines = properties.map((property) => {
      const declaration = property.declarations?.[0];
      if (declaration && (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration))) {
        throw new ContractGenerationError(
          `"${owner}.${property.getName()}" is a method. Methods do not survive ` +
            `JSON, so a type carrying one is a persistence object about to be ` +
            `serialized onto a response — fix the handler, not the manifest.`,
        );
      }

      // getTypeOfSymbol, not getTypeOfSymbolAtLocation: a property produced by a
      // mapped type (`Record<Enum, number>`) has no declaration node to pass,
      // and passing a bogus one silently yields `unknown` — a WRONG contract,
      // which is worse than the hand-written one this replaces.
      const propertyType = declaration
        ? this.checker.getTypeOfSymbolAtLocation(property, declaration)
        : this.checker.getTypeOfSymbol(property);

      // JSON.stringify omits an undefined-valued key, so `?` IS the contract
      // and `| undefined` alongside it is noise.
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const rendered = this.render(
        propertyType,
        `${owner}.${property.getName()}`,
        optional,
        `${indent}  `,
      );
      return `${indent}  ${property.getName()}${optional ? '?' : ''}: ${rendered};`;
    });

    return `{\n${lines.join('\n')}\n${indent}}`;
  }

  /** Render a type in wire form, queueing any named object shapes it references. */
  private render(type: ts.Type, path: string, stripUndefined = false, indent = ''): string {
    // Date is the wire's biggest lie: it arrives as an ISO string.
    if (this.isDate(type)) {
      return 'string';
    }

    // Checked before isUnion(): TypeScript models `boolean` as the union
    // `true | false`, so the union branch would render it as such.
    if ((type.flags & ts.TypeFlags.Boolean) !== 0) {
      return 'boolean';
    }

    if (type.isUnion()) {
      const parts = type.types
        .filter((member) => !(stripUndefined && (member.flags & ts.TypeFlags.Undefined) !== 0))
        .map((member) => this.render(member, path, false, indent));
      return [...new Set(parts)].join(' | ');
    }

    if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
      return JSON.stringify((type as ts.StringLiteralType).value);
    }
    if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
      return String((type as ts.NumberLiteralType).value);
    }
    if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      return this.checker.typeToString(type);
    }
    if ((type.flags & ts.TypeFlags.String) !== 0) return 'string';
    if ((type.flags & ts.TypeFlags.Number) !== 0) return 'number';
    if ((type.flags & ts.TypeFlags.Boolean) !== 0) return 'boolean';
    if ((type.flags & ts.TypeFlags.Null) !== 0) return 'null';
    if ((type.flags & ts.TypeFlags.Undefined) !== 0) return 'undefined';
    if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0) {
      return 'unknown';
    }
    // A generic's own parameter passes through by name.
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const parameterName = type.getSymbol()?.getName();
      if (parameterName) {
        return parameterName;
      }
    }

    if (this.checker.isArrayType(type)) {
      const [element] = this.checker.getTypeArguments(type as ts.TypeReference);
      if (!element) {
        return 'unknown[]';
      }
      const rendered = this.render(element, `${path}[]`, false, indent);
      return rendered.includes(' ') ? `Array<${rendered}>` : `${rendered}[]`;
    }

    // A named object type becomes its own emitted interface, referenced here.
    const named = type.aliasSymbol ?? type.getSymbol();
    if (named && this.isEmittableNamed(named, type)) {
      const alias = this.renames.get(named.getName());
      this.emitNamed(named, 'shared', 'transitive', alias);
      return alias ?? named.getName();
    }

    if (this.isObjectShape(type)) {
      return this.objectBody(type, path, indent);
    }

    // Index signatures (Record<string, X>) have no properties but are valid.
    const stringIndex = this.checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      return `Record<string, ${this.render(stringIndex, `${path}[key]`, false, indent)}>`;
    }

    throw new ContractGenerationError(
      `cannot express "${path}" (${this.checker.typeToString(type)}) in wire form.`,
    );
  }

  /** `<T, U extends X>` exactly as declared, or '' when the type is concrete. */
  private typeParameters(declaration: ts.Declaration): string {
    if (!ts.isInterfaceDeclaration(declaration) && !ts.isClassDeclaration(declaration)) {
      return '';
    }
    const parameters = declaration.typeParameters;
    if (!parameters || parameters.length === 0) {
      return '';
    }
    return `<${parameters.map((parameter) => parameter.getText()).join(', ')}>`;
  }

  private isDate(type: ts.Type): boolean {
    return type.getSymbol()?.getName() === 'Date';
  }

  /**
   * Only project-owned named shapes get their own interface. Anonymous inline
   * shapes are rendered in place, and a name the compiler synthesised (`__type`)
   * is not a contract.
   */
  private isEmittableNamed(symbol: ts.Symbol, type: ts.Type): boolean {
    const name = symbol.getName();
    if (name === '__type' || name === '__object' || !this.isObjectShape(type)) {
      return false;
    }
    const file = symbol.declarations?.[0]?.getSourceFile().fileName;
    // A type from node_modules is a library shape, not a contract this repo owns.
    return file !== undefined && !file.includes('node_modules');
  }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function renderFile(types: readonly EmittedType[]): string {
  const byModule = new Map<string, EmittedType[]>();
  for (const type of types) {
    const bucket = byModule.get(type.module) ?? [];
    bucket.push(type);
    byModule.set(type.module, bucket);
  }

  const sections = [...byModule.entries()].map(([module, entries]) => {
    const body = entries
      .map((entry) => `/** @see ${entry.origin} */\n${entry.body}`)
      .join('\n\n');
    return `// ${'='.repeat(74)}\n// ${module}\n// ${'='.repeat(74)}\n\n${body}`;
  });

  return `/**
 * GENERATED — DO NOT EDIT.
 *
 * Produced by \`npm run codegen:admin-contracts\` from the backend types named
 * in \`tools/codegen/admin-contracts/manifest.ts\`.
 *
 * These are WIRE shapes: what arrives at \`JSON.parse\`, not what the backend
 * holds in memory. \`Date\` is \`string\`, optional keys are absent rather than
 * \`undefined\`, and enums are unions of their serialized values.
 *
 * Editing this file by hand re-creates the problem it exists to remove: a
 * frontend copy of a contract that can drift from its owner. Change the
 * backend type and regenerate. CI runs \`codegen:admin-contracts:check\`.
 */

${sections.join('\n\n')}
`;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function generate(): string {
  const files = [...new Set(ADMIN_CONTRACT_SOURCES.map((source) => source.file))];
  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const renames = new Map<string, string>();
  for (const source of ADMIN_CONTRACT_SOURCES) {
    for (const [from, to] of Object.entries(source.rename ?? {})) {
      renames.set(from, to);
    }
  }
  const emitter = new WireEmitter(checker, renames);

  for (const source of ADMIN_CONTRACT_SOURCES) {
    for (const exportName of source.exports) {
      const symbol = findExportedSymbol(program, checker, source, exportName);
      emitter.emitNamed(symbol, source.module, source.file, source.rename?.[exportName]);
    }
  }

  return renderFile(emitter.results());
}

function main(): void {
  const check = process.argv.includes('--check');
  const outputPath = resolve(REPO_ROOT, OUTPUT);

  let generated: string;
  try {
    generated = generate();
  } catch (error) {
    if (error instanceof ContractGenerationError) {
      process.stderr.write(`admin-contracts codegen: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  if (check) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
    if (current !== generated) {
      process.stderr.write(
        `admin-contracts codegen: ${OUTPUT} is STALE.\n\n` +
          `  on disk:   ${current ? hashOf(current) : '(missing)'}\n` +
          `  from types: ${hashOf(generated)}\n\n` +
          `A backend contract changed and the panel's copy was not regenerated. ` +
          `Run \`npm run codegen:admin-contracts\` and commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`admin-contracts codegen: up to date (${hashOf(generated)})\n`);
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generated, 'utf8');
  process.stdout.write(`admin-contracts codegen: wrote ${OUTPUT} (${hashOf(generated)})\n`);
}

main();
