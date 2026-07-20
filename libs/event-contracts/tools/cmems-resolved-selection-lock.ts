import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = 'apps/farm-service/src/marine-explorer/catalog/copernicus-catalog-lock.v2.json';
const DERIVATIVE_PATH =
  'libs/event-contracts/src/catalog/cmems-resolved-selection-lock.v2.generated.json';

interface SourceCmemsProduct {
  productId: string;
  processingLevel: string;
  spatialResolution: { x: number; y: number; unit: string };
  depthAxis: {
    semantics: string;
    positiveDirection: string;
    unit: string;
    levelCount: number;
    coordinateValuesSource: string;
  };
  attributionId: string;
}

interface SourceAttributionLock {
  id: string;
  provider: string;
  creditTemplate: string;
  citationTemplate: string | null;
  requiredTemplateVariables: string[];
  doi: string | null;
  doiUrl: string | null;
  sourceUrl: string;
  guidanceUrl: string;
}

interface SourceCmemsLayer {
  id: string;
  dataKind: string;
  productId: string;
  datasetId: string;
  datasetVersionPart: string;
  wmtsCapabilitiesUrl: string;
  selectionMethodId: string;
  processing: {
    toolboxVersion: string;
    derivationId: string;
    derivationVersion: number;
  };
  noData: unknown;
  rawVariables: ReadonlyArray<{ id: string; unit: string }>;
  display: {
    variable: string;
    style: string;
    legendId: string;
    legendPolicyId: string;
    artifact: { dataKind: string; mediaType: string; authority: string };
  };
  vectorDerivation: unknown;
}

interface SourceCmemsCatalogEntry {
  id: string;
  layerLockId: string;
  temporalMode: string;
}

interface SourceCmemsCatalog {
  schemaVersion: number;
  catalogVersion: string;
  attributionLocks: SourceAttributionLock[];
  cmems: {
    provider: 'CMEMS';
    toolbox: { lock: unknown };
    coordinateSelection: {
      method: string;
      verticalAxis: string;
      outOfBounds: string;
      raiseIfUpdating: boolean;
    };
    productLocks: SourceCmemsProduct[];
    layerLocks: SourceCmemsLayer[];
    catalogEntries: SourceCmemsCatalogEntry[];
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringPair(value: unknown): value is { id: string; unit: string } {
  return isUnknownRecord(value) && typeof value.id === 'string' && typeof value.unit === 'string';
}

function isSourceProduct(value: unknown): value is SourceCmemsProduct {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.spatialResolution)) return false;
  if (!isUnknownRecord(value.depthAxis)) return false;
  return (
    typeof value.productId === 'string' &&
    typeof value.processingLevel === 'string' &&
    typeof value.spatialResolution.x === 'number' &&
    typeof value.spatialResolution.y === 'number' &&
    typeof value.spatialResolution.unit === 'string' &&
    typeof value.depthAxis.semantics === 'string' &&
    typeof value.depthAxis.positiveDirection === 'string' &&
    typeof value.depthAxis.unit === 'string' &&
    typeof value.depthAxis.levelCount === 'number' &&
    typeof value.depthAxis.coordinateValuesSource === 'string' &&
    typeof value.attributionId === 'string'
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isSourceAttribution(value: unknown): value is SourceAttributionLock {
  return (
    isUnknownRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.creditTemplate === 'string' &&
    isNullableString(value.citationTemplate) &&
    Array.isArray(value.requiredTemplateVariables) &&
    value.requiredTemplateVariables.every((entry) => typeof entry === 'string') &&
    isNullableString(value.doi) &&
    isNullableString(value.doiUrl) &&
    typeof value.sourceUrl === 'string' &&
    typeof value.guidanceUrl === 'string'
  );
}

function isSourceLayer(value: unknown): value is SourceCmemsLayer {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.processing)) return false;
  if (!isUnknownRecord(value.display) || !Array.isArray(value.rawVariables)) return false;
  if (!isUnknownRecord(value.display.artifact)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.dataKind === 'string' &&
    typeof value.productId === 'string' &&
    typeof value.datasetId === 'string' &&
    typeof value.datasetVersionPart === 'string' &&
    typeof value.wmtsCapabilitiesUrl === 'string' &&
    typeof value.selectionMethodId === 'string' &&
    typeof value.processing.toolboxVersion === 'string' &&
    typeof value.processing.derivationId === 'string' &&
    typeof value.processing.derivationVersion === 'number' &&
    hasOwn(value, 'noData') &&
    value.rawVariables.every(isStringPair) &&
    typeof value.display.variable === 'string' &&
    typeof value.display.style === 'string' &&
    typeof value.display.legendId === 'string' &&
    typeof value.display.legendPolicyId === 'string' &&
    typeof value.display.artifact.dataKind === 'string' &&
    typeof value.display.artifact.mediaType === 'string' &&
    typeof value.display.artifact.authority === 'string' &&
    hasOwn(value, 'vectorDerivation')
  );
}

function isSourceCatalogEntry(value: unknown): value is SourceCmemsCatalogEntry {
  return (
    isUnknownRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.layerLockId === 'string' &&
    typeof value.temporalMode === 'string'
  );
}

function isSourceCatalog(value: unknown): value is SourceCmemsCatalog {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.cmems)) return false;
  const cmems = value.cmems;
  if (!isUnknownRecord(cmems.toolbox) || !hasOwn(cmems.toolbox, 'lock')) return false;
  if (!isUnknownRecord(cmems.coordinateSelection)) return false;
  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.catalogVersion === 'string' &&
    Array.isArray(value.attributionLocks) &&
    value.attributionLocks.every(isSourceAttribution) &&
    cmems.provider === 'CMEMS' &&
    typeof cmems.coordinateSelection.method === 'string' &&
    typeof cmems.coordinateSelection.verticalAxis === 'string' &&
    typeof cmems.coordinateSelection.outOfBounds === 'string' &&
    typeof cmems.coordinateSelection.raiseIfUpdating === 'boolean' &&
    Array.isArray(cmems.productLocks) &&
    cmems.productLocks.every(isSourceProduct) &&
    Array.isArray(cmems.layerLocks) &&
    cmems.layerLocks.every(isSourceLayer) &&
    Array.isArray(cmems.catalogEntries) &&
    cmems.catalogEntries.every(isSourceCatalogEntry)
  );
}

/** Resolve every CMEMS catalogue entry into the exact worker lease provenance. */
export function resolveCmemsSelectionLock(sourceBytes: Buffer): unknown {
  const decoded: unknown = JSON.parse(sourceBytes.toString('utf8'));
  if (!isSourceCatalog(decoded)) {
    throw new TypeError('Copernicus catalogue does not match the CMEMS lock generator input');
  }
  const sourceCatalog = decoded;
  const catalogRevision = createHash('sha256').update(sourceBytes).digest('hex');
  const products = new Map(
    sourceCatalog.cmems.productLocks.map((product) => [product.productId, product]),
  );
  const attributions = new Map(
    sourceCatalog.attributionLocks.map((attribution) => [attribution.id, attribution]),
  );
  const layers = new Map(sourceCatalog.cmems.layerLocks.map((layer) => [layer.id, layer]));
  const resolvedSelections = sourceCatalog.cmems.catalogEntries.map((entry) => {
    const layer = layers.get(entry.layerLockId);
    if (!layer) {
      throw new TypeError(`catalogue entry ${entry.id} references an unknown layer`);
    }
    const product = products.get(layer.productId);
    if (!product) {
      throw new TypeError(`layer ${layer.id} references an unknown product`);
    }
    const attribution = attributions.get(product.attributionId);
    if (!attribution || attribution.provider !== 'COPERNICUS_MARINE') {
      throw new TypeError(`product ${product.productId} references an invalid attribution lock`);
    }
    return {
      dataRole: entry.temporalMode,
      selectionProvenance: {
        catalogSchemaVersion: sourceCatalog.schemaVersion,
        catalogVersion: sourceCatalog.catalogVersion,
        catalogRevision,
        catalogEntryId: entry.id,
        provider: sourceCatalog.cmems.provider,
        dataKind: layer.dataKind,
        productId: layer.productId,
        datasetId: layer.datasetId,
        datasetVersionPart: layer.datasetVersionPart,
        variables: layer.rawVariables,
        spatialResolution: product.spatialResolution,
        depthSelection: {
          semantics: product.depthAxis.semantics,
          method: sourceCatalog.cmems.coordinateSelection.method,
          verticalAxis: sourceCatalog.cmems.coordinateSelection.verticalAxis,
          positiveDirection: product.depthAxis.positiveDirection,
          unit: product.depthAxis.unit,
          levelCount: product.depthAxis.levelCount,
          coordinateValuesSource: product.depthAxis.coordinateValuesSource,
          outOfBounds: sourceCatalog.cmems.coordinateSelection.outOfBounds,
          raiseIfUpdating: sourceCatalog.cmems.coordinateSelection.raiseIfUpdating,
        },
        selectionMethodId: layer.selectionMethodId,
        processing: {
          providerLevel: product.processingLevel,
          toolboxVersion: layer.processing.toolboxVersion,
          derivationId: layer.processing.derivationId,
          derivationVersion: layer.processing.derivationVersion,
          vectorDerivation: layer.vectorDerivation,
        },
        noData: layer.noData,
        recipeSha256: null,
        display: {
          wmtsCapabilitiesUrl: layer.wmtsCapabilitiesUrl,
          ...layer.display,
        },
        attribution,
        toolbox: sourceCatalog.cmems.toolbox.lock,
      },
    };
  });

  return {
    schemaVersion: 1,
    generatedBy: 'libs/event-contracts/tools/cmems-resolved-selection-lock.ts',
    sourcePath: SOURCE_PATH,
    sourceCatalog: {
      schemaVersion: sourceCatalog.schemaVersion,
      catalogVersion: sourceCatalog.catalogVersion,
      catalogRevision,
    },
    resolvedSelections,
  };
}

export function serializeCmemsSelectionLock(sourceBytes: Buffer): string {
  return `${prettyJson(resolveCmemsSelectionLock(sourceBytes))}\n`;
}

function prettyJson(value: unknown, depth = 0): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('CMEMS selection lock contains invalid JSON');
    return encoded;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('CMEMS selection lock contains a non-finite number');
    return String(value);
  }
  const indentation = '  '.repeat(depth);
  const childIndentation = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${childIndentation}${prettyJson(item, depth + 1)}`).join(',\n')}\n${indentation}]`;
  }
  if (isUnknownRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{\n${keys
      .map(
        (key) => `${childIndentation}${JSON.stringify(key)}: ${prettyJson(value[key], depth + 1)}`,
      )
      .join(',\n')}\n${indentation}}`;
  }
  throw new TypeError('CMEMS selection lock contains a non-JSON value');
}

function run(): void {
  const sourcePath = resolve(process.cwd(), SOURCE_PATH);
  const derivativePath = resolve(process.cwd(), DERIVATIVE_PATH);
  const generated = serializeCmemsSelectionLock(readFileSync(sourcePath));
  if (process.argv.includes('--write')) {
    writeFileSync(derivativePath, generated, 'utf8');
    return;
  }
  const committed = readFileSync(derivativePath, 'utf8');
  if (committed !== generated) {
    throw new Error(
      `${DERIVATIVE_PATH} is stale; run this entrypoint with --write and review the derivative`,
    );
  }
}

if (require.main === module) {
  run();
}
