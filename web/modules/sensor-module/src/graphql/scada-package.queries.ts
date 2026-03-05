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
      offset
      limit
      hasMore
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
