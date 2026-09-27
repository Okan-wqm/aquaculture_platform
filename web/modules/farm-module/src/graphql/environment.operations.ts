/**
 * Environmental monitoring GraphQL operations.
 *
 * The backend catalog is the single source of truth for layer identifiers,
 * labels, units, scientific meaning, capabilities, and availability. The
 * frontend intentionally contains no layer catalog of its own.
 */

const ENVIRONMENT_VALUE_FIELDS = `
  metric
  value
  unit
  source
  semanticClass
  validAt
  issuedAt
  fetchedAt
  qualityStatus
  depthM
  requestedDepthM
  datasetId
  productId
  variableId
  resolutionM
  gridCellDistanceM
  locationRevision
  stationId
  stationDistanceKm
`;

/**
 * The deployment rollout gate as a value (ORPHAN-MEDIUM-827). The one
 * environment read that answers while the gate is closed; every other read
 * below is refused with a 503 until it opens.
 */
export const ENVIRONMENT_MONITORING_STATUS_QUERY = `
  query EnvironmentMonitoringStatus {
    environmentMonitoringStatus {
      enabled
    }
  }
`;

export const SITE_ENVIRONMENT_CURRENT_QUERY = `
  query SiteEnvironmentCurrent($siteId: ID!) {
    siteEnvironmentCurrent(siteId: $siteId) {
      siteId
      values {
        ${ENVIRONMENT_VALUE_FIELDS}
      }
    }
  }
`;

export const SITE_ENVIRONMENT_HISTORY_QUERY = `
  query SiteEnvironmentHistory($input: SiteEnvironmentHistoryInput!) {
    siteEnvironmentHistory(input: $input) {
      siteId
      values {
        ${ENVIRONMENT_VALUE_FIELDS}
      }
    }
  }
`;

export const SITE_ENVIRONMENT_FORECAST_QUERY = `
  query SiteEnvironmentForecast($input: SiteEnvironmentForecastInput!) {
    siteEnvironmentForecast(input: $input) {
      siteId
      values {
        ${ENVIRONMENT_VALUE_FIELDS}
      }
    }
  }
`;

export const ENVIRONMENT_LAYER_CATALOG_QUERY = `
  query EnvironmentLayerCatalog($siteId: ID!) {
    environmentLayerCatalog(siteId: $siteId) {
      id
      name
      description
      scientificLabel
      source
      semanticClass
      unit
      metric
      capabilities
      supportsDepth
      nominalResolutionM
      resolutionLabel
      minValue
      maxValue
      availability
      availableFrom
      availableTo
      coverage {
        expected
        successful
        failed
        noData
        outOfCoverage
        scopes {
          provider
          metric
          scopeKind
          scopeKey
          validFrom
          validTo
          outcome
          errorCode
          observationCount
          completedAt
        }
      }
    }
  }
`;

export const ENVIRONMENT_SCENES_QUERY = `
  query EnvironmentScenes($input: EnvironmentScenesInput!) {
    environmentScenes(input: $input) {
      siteId
      edges {
        cursor
        node {
          id
          sceneId
          collection
          productId
          datasetId
          acquiredAt
          cloudCoverPercent
          coveragePercent
          coverageStatus
          coverageMethod
          coverageSampleCount
          qualityStatus
          locationRevision
          fetchedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
