import * as path from 'path';

import * as ts from 'typescript';

import {
  analyzeControllerDtoContracts,
  loadControllerDtoProgram,
  type ControllerDtoViolation,
} from './controller-dto-validation.analyzer';

const SERVICE_SOURCE_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(__dirname, '../../../..');
const TSCONFIG_PATH = path.resolve(SERVICE_SOURCE_ROOT, '../tsconfig.spec.json');

function formatViolations(violations: readonly ControllerDtoViolation[]): string {
  return violations
    .map(
      (violation) =>
        `  ${violation.file} :: ${violation.handler} :: ${violation.binding} ${violation.parameter} ` +
        `[${violation.code}] — ${violation.reason}`,
    )
    .join('\n');
}

function virtualControllerProgram(source: string): {
  readonly file: string;
  readonly program: ts.Program;
} {
  const file = path.resolve(
    REPOSITORY_ROOT,
    'apps/admin-api-service/src/__tests__/virtual-dto-contract.controller.ts',
  );
  const parseHost: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG_PATH, undefined, parseHost);
  if (!parsed) throw new Error(`Unable to parse TypeScript config: ${TSCONFIG_PATH}`);

  const host = ts.createCompilerHost(parsed.options);
  const originalFileExists = host.fileExists.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (candidate): boolean =>
    path.resolve(candidate) === file || originalFileExists(candidate);
  host.readFile = (candidate): string | undefined =>
    path.resolve(candidate) === file ? source : originalReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(candidate) === file
      ? ts.createSourceFile(candidate, source, languageVersion, true)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);

  return {
    file,
    program: ts.createProgram({ rootNames: [file], options: parsed.options, host }),
  };
}

describe('admin controller whole-object DTO validation architecture', () => {
  it('uses symbol provenance, inherited metadata, and fail-closed type classifications', () => {
    const fixture = virtualControllerProgram(`
      import {
        Body as RequestBody,
        Controller as HttpController,
        Query as RequestQuery,
        ValidationPipe,
      } from '@nestjs/common';
      import type { ValidationPipe as TypeOnlyDto } from '@nestjs/common';
      import * as Nest from '@nestjs/common';
      import { IsString as TextField } from 'class-validator';
      import * as Transformer from 'class-transformer';

      function IsString(): PropertyDecorator {
        return () => undefined;
      }

      class ValidBaseDto {
        @TextField()
        value!: string;
      }

      class InheritedDto extends ValidBaseDto {}

      class TransformedDto {
        @Transformer.Type(() => String)
        value!: string;
      }

      class EmptyDto {
        value!: string;
      }

      class SpoofedMetadataDto {
        @IsString()
        value!: string;
      }

      interface InterfacePayload { value: string }
      type AliasPayload = ValidBaseDto;
      declare const selectorOrPipe: string | ValidationPipe;

      @HttpController('fixture')
      class FixtureController {
        validAlias(@RequestBody() dto: ValidBaseDto): void {}
        validNamespace(@Nest.Query(new ValidationPipe()) dto: InheritedDto): void {}
        validTransformer(@RequestQuery() dto: TransformedDto): void {}
        propertyOnly(@RequestQuery('value') value: string): void {}
        ambiguousBinding(@RequestQuery(selectorOrPipe) dto: ValidBaseDto): void {}
        missing(@RequestBody() dto): void {}
        anyValue(@RequestBody() dto: any): void {}
        unknownValue(@RequestBody() dto: unknown): void {}
        objectValue(@RequestBody() dto: object): void {}
        objectConstructor(@RequestBody() dto: Object): void {}
        recordValue(@RequestBody() dto: Record<string, string>): void {}
        partialValue(@RequestBody() dto: Partial<ValidBaseDto>): void {}
        inlineValue(@RequestBody() dto: { value: string }): void {}
        interfaceValue(@RequestBody() dto: InterfacePayload): void {}
        aliasValue(@RequestBody() dto: AliasPayload): void {}
        unresolvedValue(@RequestBody() dto: MissingDto): void {}
        typeOnlyValue(@RequestBody() dto: TypeOnlyDto): void {}
        emptyClass(@RequestBody() dto: EmptyDto): void {}
        spoofedMetadata(@RequestBody() dto: SpoofedMetadataDto): void {}
      }
    `);

    const analysis = analyzeControllerDtoContracts(
      fixture.program,
      [fixture.file],
      REPOSITORY_ROOT,
    );

    expect(analysis.inspectedBindings).toBe(18);
    expect(
      Object.fromEntries(
        analysis.violations.map((violation) => [violation.handler, violation.code]),
      ),
    ).toEqual({
      aliasValue: 'type-alias',
      ambiguousBinding: 'ambiguous-binding',
      anyValue: 'any',
      emptyClass: 'no-validation-metadata',
      inlineValue: 'inline-object',
      interfaceValue: 'interface',
      missing: 'missing-type',
      objectConstructor: 'object',
      objectValue: 'object',
      partialValue: 'partial',
      recordValue: 'record',
      spoofedMetadata: 'no-validation-metadata',
      typeOnlyValue: 'type-only-import',
      unknownValue: 'unknown',
      unresolvedValue: 'unresolved',
    });
  });

  it('requires every admin @Body()/@Query() whole-object binding to use a validated DTO class', () => {
    const { controllerFiles, program } = loadControllerDtoProgram(
      SERVICE_SOURCE_ROOT,
      TSCONFIG_PATH,
    );
    const analysis = analyzeControllerDtoContracts(program, controllerFiles, REPOSITORY_ROOT);

    expect(controllerFiles.length).toBeGreaterThan(20);
    expect(analysis.inspectedBindings).toBeGreaterThan(100);
    if (analysis.violations.length > 0) {
      throw new Error(
        `${analysis.violations.length} admin whole-object request binding(s) bypass the global ` +
          `ValidationPipe contract:\n${formatViolations(analysis.violations)}`,
      );
    }
    expect(analysis.violations).toEqual([]);
  });
});
