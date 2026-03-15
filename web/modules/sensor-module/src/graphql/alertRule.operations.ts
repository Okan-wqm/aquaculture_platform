/**
 * GraphQL queries and mutations for Alert Rule CRUD
 * Maps to alert-engine AlertResolver
 */

// ============================================================================
// Queries
// ============================================================================

export const ALERT_RULE_QUERY = `
  query AlertRule($id: ID!) {
    alertRule(id: $id) {
      id
      name
      description
      tenantId
      farmId
      pondId
      sensorId
      conditions
      severity
      isActive
      notificationChannels
      recipients
      cooldownMinutes
      createdAt
      updatedAt
      createdBy
    }
  }
`;

export const ALERT_RULES_QUERY = `
  query AlertRules($farmId: ID, $pondId: ID, $isActive: Boolean) {
    alertRules(farmId: $farmId, pondId: $pondId, isActive: $isActive) {
      id
      name
      description
      farmId
      pondId
      sensorId
      conditions
      severity
      isActive
      notificationChannels
      recipients
      cooldownMinutes
      createdAt
      updatedAt
      createdBy
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const CREATE_ALERT_RULE_MUTATION = `
  mutation CreateAlertRule($input: CreateAlertRuleInput!) {
    createAlertRule(input: $input) {
      id
      name
      description
      farmId
      pondId
      sensorId
      conditions
      severity
      isActive
      notificationChannels
      recipients
      cooldownMinutes
      createdAt
      updatedAt
      createdBy
    }
  }
`;

export const UPDATE_ALERT_RULE_MUTATION = `
  mutation UpdateAlertRule($input: UpdateAlertRuleInput!) {
    updateAlertRule(input: $input) {
      id
      name
      description
      farmId
      pondId
      sensorId
      conditions
      severity
      isActive
      notificationChannels
      recipients
      cooldownMinutes
      createdAt
      updatedAt
    }
  }
`;

export const DELETE_ALERT_RULE_MUTATION = `
  mutation DeleteAlertRule($ruleId: ID!) {
    deleteAlertRule(ruleId: $ruleId)
  }
`;
