#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parse } from 'graphql';
import ts from 'typescript';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'infrastructure/apollo-router/subgraphs.json'), 'utf8'),
);
const outputPath = resolve(
  repoRoot,
  'apps/gateway-api/src/security/generated/impersonation-graphql-operation-policy.generated.ts',
);
const routeConsumerOutputPath = resolve(
  repoRoot,
  'apps/gateway-api/src/security/generated/impersonation-route-consumers.generated.ts',
);
const check = process.argv.includes('--check');
const generatorVersion = 1;

function resolvedSymbol(symbol, checker) {
  if (!symbol) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function repoPath(fileName) {
  return relative(repoRoot, fileName).replaceAll('\\', '/');
}

function compileRouteConsumerProjection() {
  const tsconfigPath = resolve(repoRoot, 'apps/gateway-api/tsconfig.app.json');
  const loaded = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(tsconfigPath));
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const declarationFile = resolve(
    repoRoot,
    'apps/gateway-api/src/security/impersonation-route-consumer-declaration.ts',
  );
  const declarationSource = program.getSourceFile(declarationFile);
  if (!declarationSource) throw new Error('Impersonation route declaration authority is absent');
  const declarationModule = checker.getSymbolAtLocation(declarationSource);
  const factory = declarationModule
    ? checker
        .getExportsOfModule(declarationModule)
        .find((symbol) => symbol.name === 'defineImpersonationRouteConsumer')
    : undefined;
  if (!factory) throw new Error('defineImpersonationRouteConsumer symbol is absent');

  const declarations = [];
  for (const source of program.getSourceFiles()) {
    const sourcePath = repoPath(source.fileName);
    if (
      !sourcePath.startsWith('apps/gateway-api/src/') ||
      sourcePath.includes('/generated/') ||
      sourcePath.endsWith('.spec.ts')
    ) {
      continue;
    }
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const called = resolvedSymbol(checker.getSymbolAtLocation(node.expression), checker);
        if (called === factory) {
          const variable = node.parent;
          const statement = variable.parent?.parent;
          if (
            !ts.isVariableDeclaration(variable) ||
            !ts.isIdentifier(variable.name) ||
            !ts.isVariableStatement(statement) ||
            !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
          ) {
            throw new Error(
              `${sourcePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
                'route consumer declarations must be exported const bindings',
            );
          }
          declarations.push({ sourceFile: sourcePath, exportName: variable.name.text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  declarations.sort(
    (left, right) =>
      left.sourceFile.localeCompare(right.sourceFile) ||
      left.exportName.localeCompare(right.exportName),
  );
  if (declarations.length === 0) throw new Error('Impersonation route consumer census is empty');
  const coordinates = declarations.map((entry) => `${entry.sourceFile}#${entry.exportName}`);
  const digest = sha256(`impersonation-route-consumer-projection/v1\0${coordinates.join('\n')}`);
  const outputDirectory = dirname(routeConsumerOutputPath);
  const imports = declarations.map((entry, index) => {
    const modulePath = relative(
      outputDirectory,
      resolve(repoRoot, entry.sourceFile.replace(/\.ts$/u, '')),
    ).replaceAll('\\', '/');
    const specifier = modulePath.startsWith('.') ? modulePath : `./${modulePath}`;
    return `import { ${entry.exportName} as routeConsumer${index} } from '${specifier}';`;
  });
  return {
    digest,
    content: `${[
      '/** GENERATED — exact symbol-derived gateway impersonation route declarations. */',
      ...imports,
      '',
      "export const IMPERSONATION_ROUTE_CONSUMER_PROJECTION_VERSION = 'impersonation-route-consumer-projection/v1' as const;",
      `export const IMPERSONATION_ROUTE_CONSUMER_PROJECTION_DIGEST = '${digest}' as const;`,
      `export const IMPERSONATION_ROUTE_CONSUMER_PROJECTION_COORDINATES = Object.freeze(${JSON.stringify(coordinates)});`,
      `export const IMPERSONATION_ROUTE_CONSUMER_DECLARATIONS = Object.freeze([${declarations
        .map((_, index) => `routeConsumer${index}`)
        .join(', ')}]);`,
      '',
    ].join('\n')}\n`,
  };
}

const USER_FIELDS = new Set([
  'tenantUsers',
  'tenantRoles',
  'tenantRole',
  'defaultTenantRole',
  'permissionCategories',
  'moduleUsers',
  'userAssignedSiteIds',
  'getUserEffectivePermissions',
  'createTenantUser',
  'updateTenantUser',
  'deleteTenantUser',
  'deactivateTenantUser',
  'activateTenantUser',
  'unlockTenantUser',
  'assignUserRole',
  'updateUserRole',
  'revokeUserRole',
  'bulkAssignUserRole',
  'createTenantRole',
  'updateTenantRole',
  'deleteTenantRole',
  'seedTenantRoles',
  'assignUserToModule',
  'removeUserFromModule',
  'assignUserToSite',
  'unassignUserFromSite',
  'assignModuleManager',
  'removeModuleManager',
]);

const SETTINGS_FIELDS = new Set([
  'effectiveConfiguration',
  'effectiveConfigurationsByService',
  'setConfiguration',
  'getMobileUserSettings',
  'getMyMobileSettings',
  'getMobileUsersSettings',
  'updateMobileUserSettings',
  'bulkUpdateMobileSettings',
  'getMyNotificationPreferences',
  'updateMyNotificationPreferences',
  'mySecuritySettings',
  'myTenantModules',
  'aiProviderSettings',
  'updateAiProviderSettings',
  'aiSettings',
  'financeSettings',
  'updateFinanceSettings',
  'regulatorySettings',
  'regulatoryConfigurationStatus',
  'updateRegulatorySettings',
  'payrollCostSettings',
  'updatePayrollCostSettings',
  'schedulingSettings',
  'updateSchedulingSettings',
  'updateNotificationPreference',
  'updateProgramSettings',
  'parameterConfigs',
  'parameterConfig',
  'parameterConfigByCode',
  'parameterTemplates',
  'createParameterConfig',
  'updateParameterConfig',
  'deleteParameterConfig',
  'seedDefaultWaterQualityParameterConfigs',
  'applyParameterTemplate',
  'reorderParameterConfigs',
  'parameterEquipmentMappings',
  'equipmentParameters',
  'createParamEquipmentMapping',
  'updateParamEquipmentMapping',
  'deleteParamEquipmentMapping',
  'bulkMapParamsToEquipment',
  'protocols',
  'protocolSummaries',
  'protocolDetails',
  'protocolSchema',
  'protocolDefaults',
  'protocolCapabilities',
  'protocolCategoryStats',
  'protocolCodes',
  'vfdBrands',
  'vfdProtocols',
  'vfdProtocolSchema',
  'vfdProtocolDefaultConfig',
  'vfdRegisterMappings',
  'vfdRegisterMappingsByCategory',
  'vfdBrandCommands',
  'addDeviceIoConfig',
  'updateDeviceIoConfig',
  'removeDeviceIoConfig',
  'pushIoConfigToDevice',
  'bulkAddDeviceIoConfigs',
  'validateVfdConfig',
  'validateProtocolConfig',
  'testProtocolConnection',
  'pingProtocol',
  'applyProtocolDefaults',
  'hydroponicsConfigurations',
  'hydroponicsConfiguration',
  'createHydroponicsConfiguration',
  'updateHydroponicsConfiguration',
  'deleteHydroponicsConfiguration',
]);

const EXPORT_FIELDS = new Set([
  'exportTenantData',
  'exportChannelData',
  'exportTenantMessages',
  'exportMyMessages',
  'biomassReportAltinnExport',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function authorityFor(module, rootType, field) {
  const mode = rootType === 'Query' ? 'read' : 'write';
  if (EXPORT_FIELDS.has(field)) return 'export';
  if (module === 'billing') return mode === 'read' ? 'billing.read' : 'billing.write';
  if (module === 'config' || SETTINGS_FIELDS.has(field)) {
    return mode === 'read' ? 'settings.read' : 'settings.write';
  }
  if (USER_FIELDS.has(field)) return mode === 'read' ? 'users.read' : 'users.write';
  return mode === 'read' ? 'data.read' : 'data.write';
}

const rootTypeNames = new Set(['Query', 'Mutation', 'Subscription']);
const catalogs = {};
const schemaDigests = {};
for (const subgraph of registry.subgraphs) {
  const schemaPath = resolve(repoRoot, subgraph.schemaArtifactPath);
  if (!existsSync(schemaPath)) {
    throw new Error(
      `Missing ${subgraph.schemaArtifactPath}; build the registered subgraph schemas first`,
    );
  }
  const schemaText = readFileSync(schemaPath, 'utf8');
  schemaDigests[subgraph.name] = sha256(schemaText);
  const document = parse(schemaText);
  const catalog = {};
  for (const definition of document.definitions) {
    if (
      !['ObjectTypeDefinition', 'ObjectTypeExtension'].includes(definition.kind) ||
      !rootTypeNames.has(definition.name.value)
    ) {
      continue;
    }
    for (const field of definition.fields ?? []) {
      const coordinate = `${definition.name.value}.${field.name.value}`;
      if (catalog[coordinate] !== undefined) {
        throw new Error(`Duplicate GraphQL root coordinate ${subgraph.name}:${coordinate}`);
      }
      catalog[coordinate] = authorityFor(subgraph.name, definition.name.value, field.name.value);
    }
  }
  catalogs[subgraph.name] = Object.fromEntries(
    Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right)),
  );
}

const catalogDigest = sha256(JSON.stringify(catalogs));
const lines = [
  '/**',
  ' * GENERATED — DO NOT EDIT.',
  ' * Closed GraphQL impersonation operation policy projected from every registered SDL.',
  ` * Generator version: ${generatorVersion}`,
  ` * Catalog SHA256: ${catalogDigest}`,
  ' */',
  "import type { ImpersonationModule, ImpersonationOperationAuthority } from '@aquaculture/shared-contracts';",
  '',
  "export const IMPERSONATION_GRAPHQL_OPERATION_POLICY_VERSION = 'impersonation-graphql-operation-policy/v1' as const;",
  `export const IMPERSONATION_GRAPHQL_OPERATION_POLICY_DIGEST = '${catalogDigest}' as const;`,
  `export const IMPERSONATION_GRAPHQL_SCHEMA_DIGESTS = Object.freeze(${JSON.stringify(schemaDigests, null, 2)}) as Readonly<Record<ImpersonationModule, string>>;`,
  '',
  'export const IMPERSONATION_GRAPHQL_OPERATION_POLICY = Object.freeze({',
];
for (const [module, catalog] of Object.entries(catalogs)) {
  lines.push(
    `  ${JSON.stringify(module)}: Object.freeze(${JSON.stringify(catalog, null, 2).replaceAll('\n', '\n  ')}),`,
  );
}
lines.push(
  '}) as Readonly<Record<ImpersonationModule, Readonly<Record<string, ImpersonationOperationAuthority>>>>;',
  '',
);
const content = `${lines.join('\n')}\n`;
const routeConsumerProjection = compileRouteConsumerProjection();

if (check) {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== content) {
    throw new Error('Generated impersonation GraphQL operation policy is out of date');
  }
  if (
    !existsSync(routeConsumerOutputPath) ||
    readFileSync(routeConsumerOutputPath, 'utf8') !== routeConsumerProjection.content
  ) {
    throw new Error('Generated impersonation route consumer projection is out of date');
  }
  process.stdout.write(
    `Impersonation operation policy matches ${catalogDigest}; route consumers ${routeConsumerProjection.digest}.\n`,
  );
} else {
  writeFileSync(outputPath, content);
  writeFileSync(routeConsumerOutputPath, routeConsumerProjection.content);
  process.stdout.write(
    `Generated impersonation operation policy ${catalogDigest}; route consumers ${routeConsumerProjection.digest}.\n`,
  );
}
