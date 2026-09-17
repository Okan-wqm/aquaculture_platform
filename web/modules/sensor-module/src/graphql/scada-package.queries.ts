// GraphQL queries and mutations for SCADA packages

export const SCADA_PACKAGE_FIELDS = `
  id
  name
  description
  version
  processId
  processName
  packageData
  status
  createdBy
  updatedBy
  createdAt
  updatedAt
`;

export const GET_SCADA_PACKAGE = `
  query ScadaPackage($id: ID!) {
    scadaPackage(id: $id) {
      ${SCADA_PACKAGE_FIELDS}
    }
  }
`;

export const GET_SCADA_PACKAGES = `
  query ScadaPackages($filter: ScadaPackageFilterInput, $pagination: ProcessPaginationInput) {
    scadaPackages(filter: $filter, pagination: $pagination) {
      items {
        ${SCADA_PACKAGE_FIELDS}
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

export const CREATE_SCADA_PACKAGE = `
  mutation CreateScadaPackage($input: CreateScadaPackageInput!) {
    createScadaPackage(input: $input) {
      ${SCADA_PACKAGE_FIELDS}
    }
  }
`;

export const UPDATE_SCADA_PACKAGE = `
  mutation UpdateScadaPackage($id: ID!, $input: UpdateScadaPackageInput!) {
    updateScadaPackage(id: $id, input: $input) {
      ${SCADA_PACKAGE_FIELDS}
    }
  }
`;

export const DELETE_SCADA_PACKAGE = `
  mutation DeleteScadaPackage($id: ID!) {
    deleteScadaPackage(id: $id) {
      success
      message
      deletedId
    }
  }
`;

/**
 * Atomic bundle deploy (GAP-3A): SCADA package + its bound automation programs
 * ship as ONE signed release bundle (release_bundles PENDING + outbox in a
 * single transaction; PUBLISHED only on the edge's two-phase confirmation).
 * This replaces the N+1 fire-and-forget deployScadaPackageToEdge path in the
 * unified editor, structurally closing the half-deploy window.
 */
export const DEPLOY_SCADA_WITH_AUTOMATION = `
  mutation DeployScadaWithAutomation($input: DeployScadaWithAutomationInput!) {
    deployScadaWithAutomation(input: $input) {
      success
      message
      automationResults {
        programId
        success
        message
        commandId
      }
      scadaResult {
        packageId
        success
        message
      }
    }
  }
`;

export const DEPLOY_SCADA_PACKAGE = `
  mutation DeployScadaPackageToEdge($packageId: ID!, $deviceId: ID!) {
    deployScadaPackageToEdge(packageId: $packageId, deviceId: $deviceId) {
      success
      message
      packageId
      deviceId
    }
  }
`;

/**
 * Operator consumption gate (M4): the deployed/PUBLISHED representation of a
 * package. The backend refuses non-PUBLISHED packages with the GraphQL error
 * code FORBIDDEN and message 'Package is not published'. `publishedAt` is
 * derived server-side from the latest shipped deploy-log row (nullable when
 * the package never shipped).
 */
export const PUBLISHED_SCADA_PACKAGE = `
  query PublishedScadaPackage($id: ID!) {
    publishedScadaPackage(id: $id) {
      id
      name
      version
      status
      publishedAt
      packageData
    }
  }
`;

/**
 * Deploy-less publish (M5): flips the package to PUBLISHED through the same
 * shared transition the deploy/ack paths use (activation bridge reloads the
 * tenant runtime) — no edge round-trip, no MQTT, no signing.
 */
export const PUBLISH_SCADA_PACKAGE = `
  mutation PublishScadaPackage($id: ID!) {
    publishScadaPackage(id: $id) {
      success
      message
      version
    }
  }
`;
