/**
 * GraphQL operations for VFD Remote Programming
 *
 * Queries and mutations matching backend VfdProgrammingResolver
 * and VfdAutomationResolver. All operations use fragments for
 * consistent type shapes.
 */

// ============================================================================
// Fragments
// ============================================================================

export const VFD_CHANGE_SET_ITEM_FRAGMENT = `
  fragment VfdChangeSetItemFields on VfdChangeSetItem {
    id
    changeSetId
    parameterDefinitionId
    parameterName
    previousValue
    requestedValue
    appliedValue
    status
    errorMessage
    appliedAt
    createdAt
  }
`;

export const VFD_CHANGE_SET_FRAGMENT = `
  fragment VfdChangeSetFields on VfdChangeSet {
    id
    tenantId
    vfdDeviceId
    status
    description
    createdBy
    approvedBy
    rejectedBy
    rejectionReason
    appliedAt
    verifiedAt
    scheduledAt
    automationRuleId
    rollbackOfId
    metadata
    items {
      ...VfdChangeSetItemFields
    }
    createdAt
    updatedAt
  }
  ${VFD_CHANGE_SET_ITEM_FRAGMENT}
`;

export const VFD_PARAMETER_DEFINITION_FRAGMENT = `
  fragment VfdParameterDefinitionFields on VfdParameterDefinition {
    id
    tenantId
    brand
    modelSeries
    parameterName
    displayName
    description
    category
    group
    registerAddress
    registerCount
    functionCode
    dataType
    scalingFactor
    offset
    unit
    byteOrder
    wordOrder
    minValue
    maxValue
    defaultValue
    step
    riskLevel
    requiresMotorStop
    isReadable
    isWritable
    isActive
    displayOrder
    metadata
    createdAt
    updatedAt
  }
`;

export const VFD_AUDIT_LOG_FRAGMENT = `
  fragment VfdAuditLogFields on VfdParameterAuditLog {
    id
    tenantId
    vfdDeviceId
    changeSetId
    parameterName
    previousValue
    newValue
    action
    performedBy
    clientIp
    userAgent
    automationRuleId
    metadata
    timestamp
  }
`;

export const VFD_AUTOMATION_RULE_FRAGMENT = `
  fragment VfdAutomationRuleFields on VfdAutomationRule {
    id
    tenantId
    name
    description
    triggerCondition
    targetVfdDeviceIds
    parameterChanges
    requiresApproval
    priority
    isActive
    lastTriggeredAt
    triggerCount
    createdBy
    createdAt
    updatedAt
  }
`;

// ============================================================================
// Parameter Definition Queries
// ============================================================================

export const VFD_PARAMETER_DEFINITIONS_QUERY = `
  query VfdParameterDefinitions($vfdDeviceId: ID!, $group: String) {
    vfdParameterDefinitions(vfdDeviceId: $vfdDeviceId, group: $group) {
      ...VfdParameterDefinitionFields
    }
  }
  ${VFD_PARAMETER_DEFINITION_FRAGMENT}
`;

// ============================================================================
// Change Set Queries
// ============================================================================

export const VFD_CHANGE_SETS_QUERY = `
  query VfdChangeSets($vfdDeviceId: ID!, $status: VfdChangeSetStatus, $limit: Int, $offset: Int) {
    vfdChangeSets(vfdDeviceId: $vfdDeviceId, status: $status, limit: $limit, offset: $offset) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

export const VFD_CHANGE_SET_QUERY = `
  query VfdChangeSet($id: ID!) {
    vfdChangeSet(id: $id) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

// ============================================================================
// Audit Log Query
// ============================================================================

export const VFD_AUDIT_LOG_QUERY = `
  query VfdParameterAuditLog($vfdDeviceId: ID!, $parameterName: String, $limit: Int) {
    vfdParameterAuditLog(vfdDeviceId: $vfdDeviceId, parameterName: $parameterName, limit: $limit) {
      ...VfdAuditLogFields
    }
  }
  ${VFD_AUDIT_LOG_FRAGMENT}
`;

// ============================================================================
// Change Set Mutations
// ============================================================================

export const CREATE_VFD_CHANGE_SET_MUTATION = `
  mutation CreateVfdChangeSet($input: CreateVfdChangeSetInput!) {
    createVfdChangeSet(input: $input) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

export const APPROVE_VFD_CHANGE_SET_MUTATION = `
  mutation ApproveVfdChangeSet($changeSetId: ID!) {
    approveVfdChangeSet(changeSetId: $changeSetId) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

export const REJECT_VFD_CHANGE_SET_MUTATION = `
  mutation RejectVfdChangeSet($input: RejectVfdChangeSetInput!) {
    rejectVfdChangeSet(input: $input) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

export const ROLLBACK_VFD_CHANGE_SET_MUTATION = `
  mutation RollbackVfdChangeSet($input: RollbackVfdChangeSetInput!) {
    rollbackVfdChangeSet(input: $input) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

export const SUBMIT_VFD_CHANGE_SET_MUTATION = `
  mutation SubmitVfdChangeSetForApproval($changeSetId: ID!) {
    submitVfdChangeSetForApproval(changeSetId: $changeSetId) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

export const CANCEL_VFD_CHANGE_SET_MUTATION = `
  mutation CancelVfdChangeSet($changeSetId: ID!) {
    cancelVfdChangeSet(changeSetId: $changeSetId) {
      ...VfdChangeSetFields
    }
  }
  ${VFD_CHANGE_SET_FRAGMENT}
`;

// ============================================================================
// Automation Rule Queries
// ============================================================================

export const VFD_AUTOMATION_RULES_QUERY = `
  query VfdAutomationRules {
    vfdAutomationRules {
      ...VfdAutomationRuleFields
    }
  }
  ${VFD_AUTOMATION_RULE_FRAGMENT}
`;

export const VFD_AUTOMATION_RULES_BY_DEVICE_QUERY = `
  query VfdAutomationRulesByDevice($vfdDeviceId: ID!) {
    vfdAutomationRulesByDevice(vfdDeviceId: $vfdDeviceId) {
      ...VfdAutomationRuleFields
    }
  }
  ${VFD_AUTOMATION_RULE_FRAGMENT}
`;

export const VFD_AUTOMATION_RULE_QUERY = `
  query VfdAutomationRule($id: ID!) {
    vfdAutomationRule(id: $id) {
      ...VfdAutomationRuleFields
    }
  }
  ${VFD_AUTOMATION_RULE_FRAGMENT}
`;

export const VFD_AUTOMATION_RULE_HISTORY_QUERY = `
  query VfdAutomationRuleHistory($ruleId: ID!, $limit: Int) {
    vfdAutomationRuleHistory(ruleId: $ruleId, limit: $limit) {
      ...VfdAuditLogFields
    }
  }
  ${VFD_AUDIT_LOG_FRAGMENT}
`;

// ============================================================================
// Automation Rule Mutations
// ============================================================================

export const CREATE_VFD_AUTOMATION_RULE_MUTATION = `
  mutation CreateVfdAutomationRule($input: CreateVfdAutomationRuleInput!) {
    createVfdAutomationRule(input: $input) {
      ...VfdAutomationRuleFields
    }
  }
  ${VFD_AUTOMATION_RULE_FRAGMENT}
`;

export const UPDATE_VFD_AUTOMATION_RULE_MUTATION = `
  mutation UpdateVfdAutomationRule($id: ID!, $input: UpdateVfdAutomationRuleInput!) {
    updateVfdAutomationRule(id: $id, input: $input) {
      ...VfdAutomationRuleFields
    }
  }
  ${VFD_AUTOMATION_RULE_FRAGMENT}
`;

export const DELETE_VFD_AUTOMATION_RULE_MUTATION = `
  mutation DeleteVfdAutomationRule($id: ID!) {
    deleteVfdAutomationRule(id: $id)
  }
`;

export const TOGGLE_VFD_AUTOMATION_RULE_MUTATION = `
  mutation ToggleVfdAutomationRule($id: ID!, $isActive: Boolean!) {
    toggleVfdAutomationRule(id: $id, isActive: $isActive) {
      ...VfdAutomationRuleFields
    }
  }
  ${VFD_AUTOMATION_RULE_FRAGMENT}
`;
