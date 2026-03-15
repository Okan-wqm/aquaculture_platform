/**
 * GraphQL queries and mutations for Escalation Policy CRUD
 * Maps to alert-engine EscalationPolicyResolver
 */

// ============================================================================
// Fragments
// ============================================================================

const ESCALATION_POLICY_FIELDS = `
  id
  name
  description
  tenantId
  severity
  levels
  onCallSchedule
  suppressionWindows
  repeatIntervalMinutes
  maxRepeats
  isActive
  isDefault
  priority
  conditions
  timezone
  ruleIds
  farmIds
  createdAt
  updatedAt
  createdBy
`;

// ============================================================================
// Queries
// ============================================================================

export const ESCALATION_POLICY_QUERY = `
  query EscalationPolicy($id: ID!) {
    escalationPolicy(id: $id) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const ESCALATION_POLICIES_QUERY = `
  query EscalationPolicies($activeOnly: Boolean) {
    escalationPolicies(activeOnly: $activeOnly) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const DEFAULT_ESCALATION_POLICY_QUERY = `
  query DefaultEscalationPolicy {
    defaultEscalationPolicy {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const CURRENT_ON_CALL_USER_QUERY = `
  query CurrentOnCallUser($policyId: ID!) {
    currentOnCallUser(policyId: $policyId)
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const CREATE_ESCALATION_POLICY_MUTATION = `
  mutation CreateEscalationPolicy($input: CreateEscalationPolicyInput!) {
    createEscalationPolicy(input: $input) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const UPDATE_ESCALATION_POLICY_MUTATION = `
  mutation UpdateEscalationPolicy($input: UpdateEscalationPolicyInput!) {
    updateEscalationPolicy(input: $input) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const DELETE_ESCALATION_POLICY_MUTATION = `
  mutation DeleteEscalationPolicy($policyId: ID!) {
    deleteEscalationPolicy(policyId: $policyId)
  }
`;

export const ADD_SUPPRESSION_WINDOW_MUTATION = `
  mutation AddSuppressionWindow($input: AddSuppressionWindowInput!) {
    addSuppressionWindow(input: $input) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const REMOVE_SUPPRESSION_WINDOW_MUTATION = `
  mutation RemoveSuppressionWindow($policyId: ID!, $windowId: ID!) {
    removeSuppressionWindow(policyId: $policyId, windowId: $windowId) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const UPDATE_ON_CALL_SCHEDULE_MUTATION = `
  mutation UpdateOnCallSchedule($input: UpdateOnCallScheduleInput!) {
    updateOnCallSchedule(input: $input) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;

export const CLONE_ESCALATION_POLICY_MUTATION = `
  mutation CloneEscalationPolicy($input: ClonePolicyInput!) {
    cloneEscalationPolicy(input: $input) {
      ${ESCALATION_POLICY_FIELDS}
    }
  }
`;
