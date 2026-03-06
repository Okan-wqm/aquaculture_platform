// GraphQL queries and mutations for SCADA package deployment

export const DEPLOY_SCADA_PACKAGE = `
  mutation DeployScadaPackage($packageId: ID!, $deviceId: ID!) {
    deployScadaPackageToEdge(packageId: $packageId, deviceId: $deviceId) {
      success
      message
      packageId
      deviceId
    }
  }
`;
