export const CONFIGURATION_SNAPSHOT_QUERY = `
  query ConfigurationSnapshot($scope: ConfigurationScopeInputV1!) {
    configurationSnapshot(scope: $scope) {
      catalogDigest
      tenantId
      environment
      scopeRevision
      snapshotToken
      readiness
      missingRequiredKeys
      invalidKeys
      catalogMismatches
      entries {
        keyId
        state
        source
        value
        sourceTenantId
        effectiveVersion
        mutable
        required
        requiresRestart
        fallbackSuppressed
      }
    }
  }
`;

export const APPLY_CONFIGURATION_BATCH_MUTATION = `
  mutation ApplyConfigurationBatch($input: ApplyConfigurationBatchInputV1!) {
    applyConfigurationBatch(input: $input) {
      operationId
      catalogDigest
      tenantId
      environment
      previousSnapshotToken
      resultingSnapshotToken
      scopeRevision
      replayed
      changes {
        keyId
        intent
        version
      }
    }
  }
`;
