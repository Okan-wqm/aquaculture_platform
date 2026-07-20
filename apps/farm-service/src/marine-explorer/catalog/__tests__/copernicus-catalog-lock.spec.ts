import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Capability = 'MAP' | 'POINT' | 'AOI_STATS' | 'TIME_SERIES';
type DataKind = 'RASTER' | 'SCALAR' | 'VECTOR';
type TemporalMode = 'ANALYSIS' | 'FORECAST' | 'REANALYSIS' | 'HINDCAST';

interface SpatialResolution {
  x: number;
  y: number;
  unit: 'm' | 'degree';
}

interface ArtifactBand {
  id: string;
  unit: string;
  nodataValue: number;
}

interface DisplayOutput {
  id: string;
  dataKind: 'RASTER';
  mediaType: 'image/png';
  authority: 'DISPLAY_ONLY';
  sampleType: 'AUTO';
  legendId: string | null;
  legendPolicyId: string | null;
}

interface NumericOutput {
  id: string;
  dataKind: 'SCALAR';
  mediaType: 'image/tiff';
  authority: 'NUMERIC' | 'VALIDITY_MASK';
  sampleType: 'FLOAT32' | 'UINT8';
  nodataValue: number;
  bands: ArtifactBand[];
}

interface CdseRecipeLock {
  id: string;
  kind: 'NATURAL_COLOR' | 'QUALITATIVE_NDWI';
  dataKind: 'RASTER' | 'SCALAR';
  recipePath: string;
  recipeSha256: string;
  inputBands: Array<{
    id: 'B02' | 'B03' | 'B04' | 'B08';
    unit: 'REFLECTANCE';
    spatialResolution: SpatialResolution;
  }>;
  spatialResolution: SpatialResolution;
  depthSelection: {
    semantics: 'NOT_APPLICABLE';
    method: 'NOT_APPLICABLE';
  };
  processing: {
    providerLevel: 'L2A';
    engine: 'SENTINEL_HUB_EVALSCRIPT';
    engineVersion: 3;
    derivationId: string;
    derivationVersion: 1;
  };
  noData: {
    rule:
      | 'INVALID_WHEN_DATAMASK_EQUALS_ZERO'
      | 'INVALID_WHEN_DATAMASK_EQUALS_ZERO_OR_DENOMINATOR_ZERO';
    valueSource: 'CDSE_DATAMASK' | 'CDSE_DATAMASK_AND_DERIVATION';
    analyticOutputValue: number | null;
    onMissingSource: 'REJECT';
  };
  attributionId: string;
  capabilities: Capability[];
  pointReadOutputId: 'analytic' | null;
  outputs: {
    display: DisplayOutput;
    analytic: NumericOutput | null;
    dataMask: NumericOutput | null;
  };
}

interface AttributionLock {
  id: string;
  provider: 'COPERNICUS_SENTINEL' | 'COPERNICUS_MARINE';
  creditTemplate: string;
  citationTemplate: string | null;
  requiredTemplateVariables: Array<'YEAR' | 'ACCESSED_ON'>;
  doi: string | null;
  doiUrl: string | null;
  sourceUrl: string;
  guidanceUrl: string;
}

interface LegendClass {
  id: string;
  predicate: string;
  rgba: number[];
}

interface LegendCapture {
  operation: 'GetLegend';
  mediaType: 'image/svg+xml';
  layerSource: 'LOCKED_DISPLAY_VARIABLE';
  styleSource: 'LOCKED_DISPLAY_STYLE';
  requiredSnapshotFields: Array<'requestUrl' | 'mediaType' | 'sha256'>;
  numericAuthority: 'NONE';
  onMissing: 'REJECT';
}

interface LegendPolicy {
  id: string;
  kind: 'CATALOG_CATEGORICAL' | 'PROVIDER_WMTS_CAPTURE';
  immutability: 'RECIPE_SHA256_LOCKED' | 'CAPTURE_SHA256_LOCKED_PER_ARTIFACT';
  displayAuthority: 'DISPLAY_ONLY';
  sourceUrl: string;
  breaks: number[] | null;
  classes: LegendClass[] | null;
  capture: LegendCapture | null;
}

interface ProductLock {
  productId: string;
  title: string;
  modelClass: 'MODEL_ANALYSIS_FORECAST' | 'MODEL_REANALYSIS' | 'MODEL_HINDCAST';
  processingLevel: 'L4';
  spatialResolution: SpatialResolution;
  depthAxis: {
    semantics: 'DEPTH_BELOW_SEA_SURFACE';
    positiveDirection: 'DOWN';
    unit: 'm';
    levelCount: number;
    coordinateValuesSource: 'PROVIDER_DATASET_METADATA';
  };
  attributionId: string;
  doi: string;
  descriptionUrl: string;
  servicesUrl: string;
}

interface VariableLock {
  id: string;
  unit: string;
}

interface VectorDerivation {
  version: 1;
  eastwardVariable: 'uo';
  northwardVariable: 'vo';
  speed: {
    id: 'speed';
    formula: 'sqrt(uo^2 + vo^2)';
    unit: 'm s-1';
  };
  bearing: {
    id: 'bearing';
    formula: '(atan2(uo, vo) * 180 / pi + 360) % 360';
    unit: 'degrees_true';
    convention: 'clockwise_from_true_north_toward_flow';
  };
}

interface CmemsLayerLock {
  id: string;
  dataKind: 'SCALAR' | 'VECTOR';
  productId: string;
  datasetId: string;
  datasetVersionPart: string;
  wmtsCapabilitiesUrl: string;
  selectionMethodId: string;
  processing: {
    toolboxVersion: '2.4.1';
    derivationId: 'marine.cmems.raw-scalar' | 'marine.cmems.raw-uv-speed-bearing';
    derivationVersion: 1;
  };
  noData: {
    rule: 'EXCLUDE_METADATA_NODATA_AND_NON_FINITE';
    valueSource: 'PROVIDER_VARIABLE_METADATA';
    metadataKeysInPriorityOrder: ['_FillValue', 'missing_value'];
    onMissingValue: 'REJECT';
  };
  rawVariables: VariableLock[];
  display: {
    variable: string;
    style: string;
    legendId: string;
    legendPolicyId: string;
    artifact: {
      dataKind: 'RASTER';
      mediaType: 'image/png';
      authority: 'DISPLAY_ONLY';
    };
  };
  numeric: {
    dataKind: 'SCALAR' | 'VECTOR';
    artifactFormat: 'ZARR';
    authority: 'NUMERIC';
    variables: string[];
  };
  vectorDerivation: VectorDerivation | null;
}

interface CmemsCatalogEntry {
  id: string;
  layerLockId: string;
  temporalMode: TemporalMode;
  sourceKind: 'NUMERICAL_MODEL';
  capabilities: Capability[];
}

interface TemporalSelectionPolicy {
  boundarySource: 'JOB_REQUESTED_AT_UTC' | null;
  acceptedInterval: 'AT_OR_BEFORE_BOUNDARY' | 'AFTER_BOUNDARY' | 'DECLARED_DATASET_COVERAGE';
  onMismatch: 'REJECT';
}

interface ToolboxLock {
  schemaVersion: 1;
  tool: 'copernicusmarine';
  version: '2.4.1';
  artifact: {
    name: 'copernicusmarine_linux-glibc-2.35.cli';
    sizeBytes: 154166192;
    sha256: 'e65f72db9fc7075f91fc9bd90368246248aa39a599a8a79eb4d06a5705b15864';
  };
}

interface CatalogLock {
  schemaVersion: 2;
  catalogVersion: string;
  review: {
    status: 'REVIEWED';
    reviewedOn: string;
    lifecycle: 'DORMANT';
    providerCallsEnabled: false;
    runtimeImportsEnabled: false;
  };
  authority: {
    selection: 'SERVER_LOCKED';
    displayArtifacts: 'DISPLAY_ONLY';
    numericArtifacts: 'ANALYTIC_ONLY';
    pointSampling: 'ANALYTIC_ARTIFACT_ONLY';
  };
  attributionLocks: AttributionLock[];
  legendPolicies: LegendPolicy[];
  cdse: {
    provider: 'CDSE';
    dataRole: 'OBSERVATION';
    collectionId: string;
    sourceUrl: string;
    selectionMethod: {
      id: string;
      mosaicking: 'SIMPLE';
      mosaickingOrder: 'leastCC';
      onEmpty: 'REJECT';
    };
    recipes: CdseRecipeLock[];
  };
  cmems: {
    provider: 'CMEMS';
    toolbox: {
      sourceUrl: string;
      lock: ToolboxLock;
    };
    coordinateSelection: {
      id: string;
      method: 'strict-inside';
      verticalAxis: 'depth';
      depthPositiveDirection: 'DOWN';
      depthUnit: 'm';
      outOfBounds: 'REJECT';
      raiseIfUpdating: true;
      sourceUrl: string;
    };
    temporalSelectionPolicies: Record<TemporalMode, TemporalSelectionPolicy>;
    productLocks: ProductLock[];
    layerLocks: CmemsLayerLock[];
    catalogEntries: CmemsCatalogEntry[];
  };
}

interface ExpectedLayerLock {
  productId: string;
  datasetId: string;
  datasetVersionPart: string;
  dataKind: 'SCALAR' | 'VECTOR';
  rawVariables: VariableLock[];
  displayVariable: string;
  style: string;
}

const CATALOG_DIR = join(__dirname, '..');
const CATALOG_PATH = join(CATALOG_DIR, 'copernicus-catalog-lock.v2.json');
const FARM_SOURCE_DIR = join(CATALOG_DIR, '..', '..');
const WORKER_TOOLBOX_LOCK_PATH = join(
  CATALOG_DIR,
  '..',
  '..',
  '..',
  '..',
  'marine-analysis-worker',
  'copernicus-toolbox.lock.json',
);

const EXPECTED_RECIPE_HASHES: Readonly<Record<string, string>> = {
  'cdse.sentinel-2-l2a.natural-color.v1':
    'f035a8f9c389a4179a0f877a5028e0d3ac3f5e230b399f172e49538117f26700',
  'cdse.sentinel-2-l2a.ndwi.v1': 'a7a80ad629d849ea0785bf53fcb3d8f1494c491af53b76170becdfd646cbb713',
};

const EXPECTED_PRODUCTS: ProductLock[] = [
  {
    productId: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    title: 'Global Ocean Physics Analysis and Forecast',
    modelClass: 'MODEL_ANALYSIS_FORECAST',
    processingLevel: 'L4',
    spatialResolution: { x: 0.083, y: 0.083, unit: 'degree' },
    depthAxis: {
      semantics: 'DEPTH_BELOW_SEA_SURFACE',
      positiveDirection: 'DOWN',
      unit: 'm',
      levelCount: 50,
      coordinateValuesSource: 'PROVIDER_DATASET_METADATA',
    },
    attributionId: 'attribution.cmems.global-analysisforecast-phy-001-024.v1',
    doi: '10.48670/moi-00016',
    descriptionUrl:
      'https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024/description',
    servicesUrl:
      'https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024/services',
  },
  {
    productId: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    title: 'Global Ocean Biogeochemistry Analysis and Forecast',
    modelClass: 'MODEL_ANALYSIS_FORECAST',
    processingLevel: 'L4',
    spatialResolution: { x: 0.25, y: 0.25, unit: 'degree' },
    depthAxis: {
      semantics: 'DEPTH_BELOW_SEA_SURFACE',
      positiveDirection: 'DOWN',
      unit: 'm',
      levelCount: 50,
      coordinateValuesSource: 'PROVIDER_DATASET_METADATA',
    },
    attributionId: 'attribution.cmems.global-analysisforecast-bgc-001-028.v1',
    doi: '10.48670/moi-00015',
    descriptionUrl:
      'https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_BGC_001_028/description',
    servicesUrl:
      'https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_BGC_001_028/services',
  },
  {
    productId: 'GLOBAL_MULTIYEAR_PHY_001_030',
    title: 'Global Ocean Physics Reanalysis',
    modelClass: 'MODEL_REANALYSIS',
    processingLevel: 'L4',
    spatialResolution: { x: 0.083, y: 0.083, unit: 'degree' },
    depthAxis: {
      semantics: 'DEPTH_BELOW_SEA_SURFACE',
      positiveDirection: 'DOWN',
      unit: 'm',
      levelCount: 50,
      coordinateValuesSource: 'PROVIDER_DATASET_METADATA',
    },
    attributionId: 'attribution.cmems.global-multiyear-phy-001-030.v1',
    doi: '10.48670/moi-00021',
    descriptionUrl:
      'https://data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_PHY_001_030/description',
    servicesUrl: 'https://data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_PHY_001_030/services',
  },
  {
    productId: 'GLOBAL_MULTIYEAR_BGC_001_029',
    title: 'Global Ocean Biogeochemistry Hindcast',
    modelClass: 'MODEL_HINDCAST',
    processingLevel: 'L4',
    spatialResolution: { x: 0.25, y: 0.25, unit: 'degree' },
    depthAxis: {
      semantics: 'DEPTH_BELOW_SEA_SURFACE',
      positiveDirection: 'DOWN',
      unit: 'm',
      levelCount: 75,
      coordinateValuesSource: 'PROVIDER_DATASET_METADATA',
    },
    attributionId: 'attribution.cmems.global-multiyear-bgc-001-029.v1',
    doi: '10.48670/moi-00019',
    descriptionUrl:
      'https://data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_BGC_001_029/description',
    servicesUrl: 'https://data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_BGC_001_029/services',
  },
];

const EXPECTED_LAYERS: Readonly<Record<string, ExpectedLayerLock>> = {
  'cmems.operational.temperature': {
    productId: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    datasetId: 'cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m',
    datasetVersionPart: '202406',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'thetao', unit: 'degrees_C' }],
    displayVariable: 'thetao',
    style: 'cmap:thermal',
  },
  'cmems.operational.salinity': {
    productId: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    datasetId: 'cmems_mod_glo_phy-so_anfc_0.083deg_P1D-m',
    datasetVersionPart: '202406',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'so', unit: '1e-3' }],
    displayVariable: 'so',
    style: 'cmap:haline',
  },
  'cmems.operational.currents': {
    productId: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    datasetId: 'cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m',
    datasetVersionPart: '202406',
    dataKind: 'VECTOR',
    rawVariables: [
      { id: 'uo', unit: 'm s-1' },
      { id: 'vo', unit: 'm s-1' },
    ],
    displayVariable: 'sea_water_velocity',
    style: 'cmap:speed,vectorStyle:solidAndVector',
  },
  'cmems.operational.oxygen': {
    productId: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    datasetId: 'cmems_mod_glo_bgc-bio_anfc_0.25deg_P1D-m',
    datasetVersionPart: '202311',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'o2', unit: 'mmol m-3' }],
    displayVariable: 'o2',
    style: 'cmap:matter',
  },
  'cmems.operational.chlorophyll': {
    productId: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    datasetId: 'cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m',
    datasetVersionPart: '202311',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'chl', unit: 'mg m-3' }],
    displayVariable: 'chl',
    style: 'cmap:algae',
  },
  'cmems.reanalysis.temperature': {
    productId: 'GLOBAL_MULTIYEAR_PHY_001_030',
    datasetId: 'cmems_mod_glo_phy_my_0.083deg_P1D-m',
    datasetVersionPart: '202311',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'thetao', unit: 'degrees_C' }],
    displayVariable: 'thetao',
    style: 'cmap:thermal',
  },
  'cmems.reanalysis.salinity': {
    productId: 'GLOBAL_MULTIYEAR_PHY_001_030',
    datasetId: 'cmems_mod_glo_phy_my_0.083deg_P1D-m',
    datasetVersionPart: '202311',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'so', unit: '1e-3' }],
    displayVariable: 'so',
    style: 'cmap:haline',
  },
  'cmems.reanalysis.currents': {
    productId: 'GLOBAL_MULTIYEAR_PHY_001_030',
    datasetId: 'cmems_mod_glo_phy_my_0.083deg_P1D-m',
    datasetVersionPart: '202311',
    dataKind: 'VECTOR',
    rawVariables: [
      { id: 'uo', unit: 'm s-1' },
      { id: 'vo', unit: 'm s-1' },
    ],
    displayVariable: 'sea_water_velocity',
    style: 'cmap:speed,vectorStyle:solidAndVector',
  },
  'cmems.hindcast.oxygen': {
    productId: 'GLOBAL_MULTIYEAR_BGC_001_029',
    datasetId: 'cmems_mod_glo_bgc_my_0.25deg_P1D-m',
    datasetVersionPart: '202406',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'o2', unit: 'mmol m-3' }],
    displayVariable: 'o2',
    style: 'cmap:matter',
  },
  'cmems.hindcast.chlorophyll': {
    productId: 'GLOBAL_MULTIYEAR_BGC_001_029',
    datasetId: 'cmems_mod_glo_bgc_my_0.25deg_P1D-m',
    datasetVersionPart: '202406',
    dataKind: 'SCALAR',
    rawVariables: [{ id: 'chl', unit: 'mg m-3' }],
    displayVariable: 'chl',
    style: 'cmap:algae',
  },
};

function loadCatalog(): CatalogLock {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogLock;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectExactKeys(value: object, expected: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('Copernicus catalog lock', () => {
  it('is a reviewed dormant v2 contract with a closed exact-key schema', () => {
    const catalog = loadCatalog();

    expectExactKeys(catalog, [
      'schemaVersion',
      'catalogVersion',
      'review',
      'authority',
      'attributionLocks',
      'legendPolicies',
      'cdse',
      'cmems',
    ]);
    expectExactKeys(catalog.review, [
      'status',
      'reviewedOn',
      'lifecycle',
      'providerCallsEnabled',
      'runtimeImportsEnabled',
    ]);
    expectExactKeys(catalog.authority, [
      'selection',
      'displayArtifacts',
      'numericArtifacts',
      'pointSampling',
    ]);
    expectExactKeys(catalog.cdse, [
      'provider',
      'dataRole',
      'collectionId',
      'sourceUrl',
      'selectionMethod',
      'recipes',
    ]);
    expectExactKeys(catalog.cdse.selectionMethod, [
      'id',
      'mosaicking',
      'mosaickingOrder',
      'onEmpty',
    ]);
    expectExactKeys(catalog.cmems, [
      'provider',
      'toolbox',
      'coordinateSelection',
      'temporalSelectionPolicies',
      'productLocks',
      'layerLocks',
      'catalogEntries',
    ]);
    expectExactKeys(catalog.cmems.toolbox, ['sourceUrl', 'lock']);
    expectExactKeys(catalog.cmems.toolbox.lock, ['schemaVersion', 'tool', 'version', 'artifact']);
    expectExactKeys(catalog.cmems.toolbox.lock.artifact, ['name', 'sizeBytes', 'sha256']);
    expectExactKeys(catalog.cmems.coordinateSelection, [
      'id',
      'method',
      'verticalAxis',
      'depthPositiveDirection',
      'depthUnit',
      'outOfBounds',
      'raiseIfUpdating',
      'sourceUrl',
    ]);

    for (const attribution of catalog.attributionLocks) {
      expectExactKeys(attribution, [
        'id',
        'provider',
        'creditTemplate',
        'citationTemplate',
        'requiredTemplateVariables',
        'doi',
        'doiUrl',
        'sourceUrl',
        'guidanceUrl',
      ]);
    }
    for (const policy of catalog.legendPolicies) {
      expectExactKeys(policy, [
        'id',
        'kind',
        'immutability',
        'displayAuthority',
        'sourceUrl',
        'breaks',
        'classes',
        'capture',
      ]);
      for (const legendClass of policy.classes ?? []) {
        expectExactKeys(legendClass, ['id', 'predicate', 'rgba']);
      }
      if (policy.capture) {
        expectExactKeys(policy.capture, [
          'operation',
          'mediaType',
          'layerSource',
          'styleSource',
          'requiredSnapshotFields',
          'numericAuthority',
          'onMissing',
        ]);
      }
    }

    for (const recipe of catalog.cdse.recipes) {
      expectExactKeys(recipe, [
        'id',
        'kind',
        'dataKind',
        'recipePath',
        'recipeSha256',
        'inputBands',
        'spatialResolution',
        'depthSelection',
        'processing',
        'noData',
        'attributionId',
        'capabilities',
        'pointReadOutputId',
        'outputs',
      ]);
      expectExactKeys(recipe.spatialResolution, ['x', 'y', 'unit']);
      expectExactKeys(recipe.depthSelection, ['semantics', 'method']);
      expectExactKeys(recipe.processing, [
        'providerLevel',
        'engine',
        'engineVersion',
        'derivationId',
        'derivationVersion',
      ]);
      expectExactKeys(recipe.noData, [
        'rule',
        'valueSource',
        'analyticOutputValue',
        'onMissingSource',
      ]);
      for (const band of recipe.inputBands) {
        expectExactKeys(band, ['id', 'unit', 'spatialResolution']);
        expectExactKeys(band.spatialResolution, ['x', 'y', 'unit']);
      }
      expectExactKeys(recipe.outputs, ['display', 'analytic', 'dataMask']);
      expectExactKeys(recipe.outputs.display, [
        'id',
        'dataKind',
        'mediaType',
        'authority',
        'sampleType',
        'legendId',
        'legendPolicyId',
      ]);
      for (const output of [recipe.outputs.analytic, recipe.outputs.dataMask]) {
        if (output) {
          expectExactKeys(output, [
            'id',
            'dataKind',
            'mediaType',
            'authority',
            'sampleType',
            'nodataValue',
            'bands',
          ]);
          for (const band of output.bands) {
            expectExactKeys(band, ['id', 'unit', 'nodataValue']);
          }
        }
      }
    }

    for (const product of catalog.cmems.productLocks) {
      expectExactKeys(product, [
        'productId',
        'title',
        'modelClass',
        'processingLevel',
        'spatialResolution',
        'depthAxis',
        'attributionId',
        'doi',
        'descriptionUrl',
        'servicesUrl',
      ]);
      expectExactKeys(product.spatialResolution, ['x', 'y', 'unit']);
      expectExactKeys(product.depthAxis, [
        'semantics',
        'positiveDirection',
        'unit',
        'levelCount',
        'coordinateValuesSource',
      ]);
    }
    for (const layer of catalog.cmems.layerLocks) {
      expectExactKeys(layer, [
        'id',
        'dataKind',
        'productId',
        'datasetId',
        'datasetVersionPart',
        'wmtsCapabilitiesUrl',
        'selectionMethodId',
        'processing',
        'noData',
        'rawVariables',
        'display',
        'numeric',
        'vectorDerivation',
      ]);
      expectExactKeys(layer.processing, ['toolboxVersion', 'derivationId', 'derivationVersion']);
      expectExactKeys(layer.noData, [
        'rule',
        'valueSource',
        'metadataKeysInPriorityOrder',
        'onMissingValue',
      ]);
      for (const variable of layer.rawVariables) {
        expectExactKeys(variable, ['id', 'unit']);
      }
      expectExactKeys(layer.display, [
        'variable',
        'style',
        'legendId',
        'legendPolicyId',
        'artifact',
      ]);
      expectExactKeys(layer.display.artifact, ['dataKind', 'mediaType', 'authority']);
      expectExactKeys(layer.numeric, ['dataKind', 'artifactFormat', 'authority', 'variables']);
      if (layer.vectorDerivation) {
        expectExactKeys(layer.vectorDerivation, [
          'version',
          'eastwardVariable',
          'northwardVariable',
          'speed',
          'bearing',
        ]);
        expectExactKeys(layer.vectorDerivation.speed, ['id', 'formula', 'unit']);
        expectExactKeys(layer.vectorDerivation.bearing, ['id', 'formula', 'unit', 'convention']);
      }
    }
    for (const entry of catalog.cmems.catalogEntries) {
      expectExactKeys(entry, ['id', 'layerLockId', 'temporalMode', 'sourceKind', 'capabilities']);
    }
    for (const policy of Object.values(catalog.cmems.temporalSelectionPolicies)) {
      expectExactKeys(policy, ['boundarySource', 'acceptedInterval', 'onMismatch']);
    }

    expect(catalog).toMatchObject({
      schemaVersion: 2,
      catalogVersion: '2026-07-19.2',
      review: {
        status: 'REVIEWED',
        reviewedOn: '2026-07-19',
        lifecycle: 'DORMANT',
        providerCallsEnabled: false,
        runtimeImportsEnabled: false,
      },
      authority: {
        selection: 'SERVER_LOCKED',
        displayArtifacts: 'DISPLAY_ONLY',
        numericArtifacts: 'ANALYTIC_ONLY',
        pointSampling: 'ANALYTIC_ARTIFACT_ONLY',
      },
    });

    const catalogRuntimeSources = filesUnder(CATALOG_DIR).filter(
      (path) => path.endsWith('.ts') && !path.includes(`${join(CATALOG_DIR, '__tests__')}/`),
    );
    expect(catalogRuntimeSources).toEqual([]);

    const externalRuntimeImports = filesUnder(FARM_SOURCE_DIR)
      .filter((path) => path.endsWith('.ts') && !path.startsWith(CATALOG_DIR))
      .filter((path) =>
        readFileSync(path, 'utf8').includes('marine-explorer/catalog/copernicus-catalog-lock'),
      );
    expect(externalRuntimeImports).toEqual([]);
  });

  it('locks S2L2A inputs at 10 m, deterministic selection, derivation, and no-data semantics', () => {
    const catalog = loadCatalog();

    expect(catalog.cdse).toMatchObject({
      provider: 'CDSE',
      dataRole: 'OBSERVATION',
      collectionId: 'sentinel-2-l2a',
      sourceUrl: 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html',
      selectionMethod: {
        id: 'cdse.sentinel-hub.simple-least-cc.v1',
        mosaicking: 'SIMPLE',
        mosaickingOrder: 'leastCC',
        onEmpty: 'REJECT',
      },
    });
    expect(catalog.cdse.recipes.map(({ id }) => id)).toEqual([
      'cdse.sentinel-2-l2a.natural-color.v1',
      'cdse.sentinel-2-l2a.ndwi.v1',
    ]);

    for (const recipe of catalog.cdse.recipes) {
      expect(recipe.recipeSha256).toBe(EXPECTED_RECIPE_HASHES[recipe.id]);
      expect(recipe.recipeSha256).toBe(sha256(join(CATALOG_DIR, recipe.recipePath)));
      expect(recipe.spatialResolution).toEqual({ x: 10, y: 10, unit: 'm' });
      expect(
        recipe.inputBands.every(
          ({ spatialResolution }) =>
            JSON.stringify(spatialResolution) === JSON.stringify(recipe.spatialResolution),
        ),
      ).toBe(true);
      expect(recipe.inputBands.every(({ unit }) => unit === 'REFLECTANCE')).toBe(true);
      expect(recipe.depthSelection).toEqual({
        semantics: 'NOT_APPLICABLE',
        method: 'NOT_APPLICABLE',
      });
      expect(recipe.processing).toMatchObject({
        providerLevel: 'L2A',
        engine: 'SENTINEL_HUB_EVALSCRIPT',
        engineVersion: 3,
        derivationVersion: 1,
      });
      expect(recipe.noData.onMissingSource).toBe('REJECT');
      expect(recipe.attributionId).toBe('attribution.cdse.modified-sentinel.v1');
      expect(recipe.outputs.display).toMatchObject({
        dataKind: 'RASTER',
        mediaType: 'image/png',
        authority: 'DISPLAY_ONLY',
      });
    }

    const [naturalColor, ndwi] = catalog.cdse.recipes;
    if (!naturalColor || !ndwi) {
      throw new Error('The two locked CDSE recipes are required');
    }
    expect(naturalColor).toMatchObject({
      dataKind: 'RASTER',
      inputBands: [
        { id: 'B02', unit: 'REFLECTANCE' },
        { id: 'B03', unit: 'REFLECTANCE' },
        { id: 'B04', unit: 'REFLECTANCE' },
      ],
      capabilities: ['MAP'],
      pointReadOutputId: null,
      noData: {
        rule: 'INVALID_WHEN_DATAMASK_EQUALS_ZERO',
        valueSource: 'CDSE_DATAMASK',
        analyticOutputValue: null,
        onMissingSource: 'REJECT',
      },
      outputs: { analytic: null, dataMask: null },
    });
    expect(ndwi).toMatchObject({
      dataKind: 'SCALAR',
      inputBands: [
        { id: 'B03', unit: 'REFLECTANCE' },
        { id: 'B08', unit: 'REFLECTANCE' },
      ],
      capabilities: ['MAP', 'POINT', 'AOI_STATS', 'TIME_SERIES'],
      pointReadOutputId: 'analytic',
      noData: {
        rule: 'INVALID_WHEN_DATAMASK_EQUALS_ZERO_OR_DENOMINATOR_ZERO',
        valueSource: 'CDSE_DATAMASK_AND_DERIVATION',
        analyticOutputValue: -9999,
        onMissingSource: 'REJECT',
      },
    });
    expect(ndwi.outputs.analytic).toEqual({
      id: 'analytic',
      dataKind: 'SCALAR',
      mediaType: 'image/tiff',
      authority: 'NUMERIC',
      sampleType: 'FLOAT32',
      nodataValue: -9999,
      bands: [{ id: 'ndwi', unit: '1', nodataValue: -9999 }],
    });
    expect(ndwi.outputs.dataMask).toEqual({
      id: 'dataMask',
      dataKind: 'SCALAR',
      mediaType: 'image/tiff',
      authority: 'VALIDITY_MASK',
      sampleType: 'UINT8',
      nodataValue: 0,
      bands: [{ id: 'dataMask', unit: '1', nodataValue: 0 }],
    });
  });

  it('pins official CMEMS product resolution, depth axes, datasets, styles, variables, and units', () => {
    const catalog = loadCatalog();

    expect(catalog.cmems.provider).toBe('CMEMS');
    expect(catalog.cmems.productLocks).toEqual(EXPECTED_PRODUCTS);
    expect(catalog.cmems.layerLocks.map(({ id }) => id).sort()).toEqual(
      Object.keys(EXPECTED_LAYERS).sort(),
    );
    for (const layer of catalog.cmems.layerLocks) {
      const expected = EXPECTED_LAYERS[layer.id];
      if (!expected) {
        throw new Error(`Unexpected layer lock: ${layer.id}`);
      }
      expect(layer).toMatchObject({
        dataKind: expected.dataKind,
        productId: expected.productId,
        datasetId: expected.datasetId,
        datasetVersionPart: expected.datasetVersionPart,
        rawVariables: expected.rawVariables,
        display: {
          variable: expected.displayVariable,
          style: expected.style,
        },
      });
      expect(layer.wmtsCapabilitiesUrl).toBe(
        `https://wmts.marine.copernicus.eu/teroWmts/${layer.productId}/${layer.datasetId}_${layer.datasetVersionPart}?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`,
      );
      expect(layer.selectionMethodId).toBe(catalog.cmems.coordinateSelection.id);
      expect(layer.processing.toolboxVersion).toBe(catalog.cmems.toolbox.lock.version);
      expect(layer.processing.derivationVersion).toBe(1);
      expect(layer.numeric.variables).toEqual(layer.rawVariables.map(({ id }) => id));

      const product = catalog.cmems.productLocks.find(
        ({ productId }) => productId === layer.productId,
      );
      expect(product?.spatialResolution).toEqual(
        layer.datasetId.includes('0.083deg')
          ? { x: 0.083, y: 0.083, unit: 'degree' }
          : { x: 0.25, y: 0.25, unit: 'degree' },
      );
      expect(product?.depthAxis).toMatchObject({
        semantics: 'DEPTH_BELOW_SEA_SURFACE',
        positiveDirection: 'DOWN',
        unit: 'm',
        coordinateValuesSource: 'PROVIDER_DATASET_METADATA',
      });
    }
  });

  it('fails closed for CMEMS coordinate and no-data selection without inventing fill values', () => {
    const catalog = loadCatalog();

    expect(catalog.cmems.coordinateSelection).toEqual({
      id: 'cmems.toolbox.strict-inside.depth.v1',
      method: 'strict-inside',
      verticalAxis: 'depth',
      depthPositiveDirection: 'DOWN',
      depthUnit: 'm',
      outOfBounds: 'REJECT',
      raiseIfUpdating: true,
      sourceUrl:
        'https://help.marine.copernicus.eu/en/articles/8684964-i-m-an-operational-user-what-should-i-know-to-use-the-copernicus-marine-toolbox',
    });

    for (const layer of catalog.cmems.layerLocks) {
      expect(layer.noData).toEqual({
        rule: 'EXCLUDE_METADATA_NODATA_AND_NON_FINITE',
        valueSource: 'PROVIDER_VARIABLE_METADATA',
        metadataKeysInPriorityOrder: ['_FillValue', 'missing_value'],
        onMissingValue: 'REJECT',
      });
      expect(Object.values(layer.noData).some((value) => typeof value === 'number')).toBe(false);
    }
  });

  it('keeps scalar and vector provenance structurally consistent and derives currents only from raw u/v', () => {
    const catalog = loadCatalog();

    for (const layer of catalog.cmems.layerLocks) {
      expect(layer.display.artifact).toEqual({
        dataKind: 'RASTER',
        mediaType: 'image/png',
        authority: 'DISPLAY_ONLY',
      });
      expect(layer.numeric).toMatchObject({
        dataKind: layer.dataKind,
        artifactFormat: 'ZARR',
        authority: 'NUMERIC',
      });

      if (layer.dataKind === 'VECTOR') {
        expect(layer.rawVariables).toEqual([
          { id: 'uo', unit: 'm s-1' },
          { id: 'vo', unit: 'm s-1' },
        ]);
        expect(layer.processing.derivationId).toBe('marine.cmems.raw-uv-speed-bearing');
        expect(layer.vectorDerivation).toEqual({
          version: 1,
          eastwardVariable: 'uo',
          northwardVariable: 'vo',
          speed: {
            id: 'speed',
            formula: 'sqrt(uo^2 + vo^2)',
            unit: 'm s-1',
          },
          bearing: {
            id: 'bearing',
            formula: '(atan2(uo, vo) * 180 / pi + 360) % 360',
            unit: 'degrees_true',
            convention: 'clockwise_from_true_north_toward_flow',
          },
        });
      } else {
        expect(layer.rawVariables).toHaveLength(1);
        expect(layer.processing.derivationId).toBe('marine.cmems.raw-scalar');
        expect(layer.vectorDerivation).toBeNull();
      }
    }
  });

  it('locks NDWI classes to evalscript colors and captures CMEMS legends as display-only artifacts', () => {
    const catalog = loadCatalog();
    const ndwiPolicy = catalog.legendPolicies.find(
      ({ id }) => id === 'legend-policy.cdse.ndwi-qualitative.v1',
    );
    const cmemsPolicy = catalog.legendPolicies.find(
      ({ id }) => id === 'legend-policy.cmems.wmts-getlegend.v1',
    );

    expect(ndwiPolicy).toEqual({
      id: 'legend-policy.cdse.ndwi-qualitative.v1',
      kind: 'CATALOG_CATEGORICAL',
      immutability: 'RECIPE_SHA256_LOCKED',
      displayAuthority: 'DISPLAY_ONLY',
      sourceUrl: 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Evalscript.html',
      breaks: [0, 0.2],
      classes: [
        { id: 'negative', predicate: 'value < 0', rgba: [0.45, 0.3, 0.15, 1] },
        {
          id: 'low-positive',
          predicate: 'value >= 0 && value < 0.2',
          rgba: [0.85, 0.85, 0.65, 1],
        },
        { id: 'water', predicate: 'value >= 0.2', rgba: [0.05, 0.35, 0.85, 1] },
      ],
      capture: null,
    });
    expect(cmemsPolicy).toEqual({
      id: 'legend-policy.cmems.wmts-getlegend.v1',
      kind: 'PROVIDER_WMTS_CAPTURE',
      immutability: 'CAPTURE_SHA256_LOCKED_PER_ARTIFACT',
      displayAuthority: 'DISPLAY_ONLY',
      sourceUrl:
        'https://help.marine.copernicus.eu/en/articles/6478168-how-to-use-wmts-to-visualize-data',
      breaks: null,
      classes: null,
      capture: {
        operation: 'GetLegend',
        mediaType: 'image/svg+xml',
        layerSource: 'LOCKED_DISPLAY_VARIABLE',
        styleSource: 'LOCKED_DISPLAY_STYLE',
        requiredSnapshotFields: ['requestUrl', 'mediaType', 'sha256'],
        numericAuthority: 'NONE',
        onMissing: 'REJECT',
      },
    });

    const ndwiRecipe = catalog.cdse.recipes.find(({ kind }) => kind === 'QUALITATIVE_NDWI');
    expect(ndwiRecipe?.outputs.display).toMatchObject({
      legendId: 'legend.cdse.sentinel-2-l2a.ndwi.qualitative.v1',
      legendPolicyId: ndwiPolicy?.id,
    });
    if (!ndwiRecipe) {
      throw new Error('NDWI recipe is required');
    }
    const ndwiScript = readFileSync(join(CATALOG_DIR, ndwiRecipe.recipePath), 'utf8');
    for (const snippet of [
      'if (ndwi < 0)',
      'else if (ndwi < 0.2)',
      '[0.45, 0.3, 0.15]',
      '[0.85, 0.85, 0.65]',
      '[0.05, 0.35, 0.85]',
    ]) {
      expect(ndwiScript).toContain(snippet);
    }

    const cmemsLegendIds = catalog.cmems.layerLocks.map(({ display }) => display.legendId);
    expect(new Set(cmemsLegendIds).size).toBe(cmemsLegendIds.length);
    for (const layer of catalog.cmems.layerLocks) {
      expect(layer.display.legendPolicyId).toBe(cmemsPolicy?.id);
      expect(layer.display.legendId).toMatch(
        new RegExp(`^legend\\.${layer.id.replaceAll('.', '\\.')}\\.${layer.datasetVersionPart}\\.`),
      );
    }
  });

  it('pins exact official attribution and closes every recipe and product reference', () => {
    const catalog = loadCatalog();
    const attributionIds = catalog.attributionLocks.map(({ id }) => id);

    expect(new Set(attributionIds).size).toBe(5);
    expect(catalog.attributionLocks[0]).toEqual({
      id: 'attribution.cdse.modified-sentinel.v1',
      provider: 'COPERNICUS_SENTINEL',
      creditTemplate: 'Contains modified Copernicus Sentinel data {{YEAR}}',
      citationTemplate: null,
      requiredTemplateVariables: ['YEAR'],
      doi: null,
      doiUrl: null,
      sourceUrl: 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html',
      guidanceUrl: 'https://documentation.dataspace.copernicus.eu/FAQ.html',
    });
    for (const recipe of catalog.cdse.recipes) {
      expect(attributionIds).toContain(recipe.attributionId);
    }
    for (const product of catalog.cmems.productLocks) {
      const attribution = catalog.attributionLocks.find(({ id }) => id === product.attributionId);
      expect(attribution).toMatchObject({
        provider: 'COPERNICUS_MARINE',
        creditTemplate: `Generated using E.U. Copernicus Marine Service Information; https://doi.org/${product.doi}`,
        requiredTemplateVariables: ['ACCESSED_ON'],
        doi: product.doi,
        doiUrl: `https://doi.org/${product.doi}`,
        sourceUrl: product.descriptionUrl,
        guidanceUrl:
          'https://help.marine.copernicus.eu/en/articles/4444611-how-to-cite-copernicus-marine-products-and-services',
      });
      expect(attribution?.citationTemplate).toBe(
        `${product.title}. E.U. Copernicus Marine Service Information (CMEMS). Marine Data Store (MDS). DOI: ${product.doi} (Accessed on {{ACCESSED_ON}})`,
      );
    }

    for (const attribution of catalog.attributionLocks) {
      expect(attribution.sourceUrl).toMatch(
        /^https:\/\/(documentation\.dataspace\.copernicus\.eu|data\.marine\.copernicus\.eu)\//,
      );
      expect(attribution.guidanceUrl).toMatch(
        /^https:\/\/(documentation\.dataspace\.copernicus\.eu|help\.marine\.copernicus\.eu)\//,
      );
    }
  });

  it('pins the worker-identical Copernicus Marine Toolbox v2.4.1 Linux artifact', () => {
    const catalog = loadCatalog();
    const workerLock = JSON.parse(readFileSync(WORKER_TOOLBOX_LOCK_PATH, 'utf8')) as ToolboxLock;

    expect(catalog.cmems.toolbox).toEqual({
      sourceUrl: 'https://github.com/mercator-ocean/copernicus-marine-toolbox/releases/tag/v2.4.1',
      lock: {
        schemaVersion: 1,
        tool: 'copernicusmarine',
        version: '2.4.1',
        artifact: {
          name: 'copernicusmarine_linux-glibc-2.35.cli',
          sizeBytes: 154166192,
          sha256: 'e65f72db9fc7075f91fc9bd90368246248aa39a599a8a79eb4d06a5705b15864',
        },
      },
    });
    expect(catalog.cmems.toolbox.lock).toEqual(workerLock);
  });

  it('keeps temporal roles distinct, IDs unique, references closed, and PNG nonnumeric', () => {
    const catalog = loadCatalog();
    const productIds = catalog.cmems.productLocks.map(({ productId }) => productId);
    const layerIds = catalog.cmems.layerLocks.map(({ id }) => id);
    const entryIds = catalog.cmems.catalogEntries.map(({ id }) => id);
    const recipeIds = catalog.cdse.recipes.map(({ id }) => id);
    const legendPolicyIds = catalog.legendPolicies.map(({ id }) => id);

    expect(catalog.cmems.temporalSelectionPolicies).toEqual({
      ANALYSIS: {
        boundarySource: 'JOB_REQUESTED_AT_UTC',
        acceptedInterval: 'AT_OR_BEFORE_BOUNDARY',
        onMismatch: 'REJECT',
      },
      FORECAST: {
        boundarySource: 'JOB_REQUESTED_AT_UTC',
        acceptedInterval: 'AFTER_BOUNDARY',
        onMismatch: 'REJECT',
      },
      REANALYSIS: {
        boundarySource: null,
        acceptedInterval: 'DECLARED_DATASET_COVERAGE',
        onMismatch: 'REJECT',
      },
      HINDCAST: {
        boundarySource: null,
        acceptedInterval: 'DECLARED_DATASET_COVERAGE',
        onMismatch: 'REJECT',
      },
    });

    for (const ids of [productIds, layerIds, entryIds, recipeIds, legendPolicyIds]) {
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(new Set([...layerIds, ...entryIds, ...recipeIds]).size).toBe(
      layerIds.length + entryIds.length + recipeIds.length,
    );
    for (const layer of catalog.cmems.layerLocks) {
      expect(productIds).toContain(layer.productId);
      expect(legendPolicyIds).toContain(layer.display.legendPolicyId);
      expect(layer.display.artifact.authority).toBe('DISPLAY_ONLY');
      expect(layer.numeric.authority).toBe('NUMERIC');
      expect(layer.numeric.artifactFormat).toBe('ZARR');
    }
    for (const entry of catalog.cmems.catalogEntries) {
      expect(layerIds).toContain(entry.layerLockId);
      expect(catalog.cmems.temporalSelectionPolicies[entry.temporalMode]).toBeDefined();
      expect(entry.sourceKind).toBe('NUMERICAL_MODEL');
      expect(entry.capabilities).toEqual(['MAP', 'POINT', 'AOI_STATS', 'TIME_SERIES']);
    }
    for (const layerLockId of layerIds.filter((id) => id.startsWith('cmems.operational.'))) {
      expect(
        catalog.cmems.catalogEntries
          .filter((entry) => entry.layerLockId === layerLockId)
          .map(({ temporalMode }) => temporalMode)
          .sort(),
      ).toEqual(['ANALYSIS', 'FORECAST']);
    }

    const serialized = JSON.stringify(catalog);
    for (const bannedLegacyIdentifier of [
      'sentinel:chlorophyll',
      'sentinel:turbidity',
      'cdse.sentinel-2-l2a.chlorophyll',
      'cdse.sentinel-2-l2a.turbidity',
      'evalscriptOverride',
      'PNG_NUMERIC',
      'RGB_PACKED_NUMERIC',
    ]) {
      expect(serialized).not.toContain(bannedLegacyIdentifier);
    }
  });
});
