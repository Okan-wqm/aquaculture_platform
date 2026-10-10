// ============================================================================
// Alert GraphQL Operations — MOB-HIGH-006 (mobile alarm surface)
// ============================================================================
// Field workers need the alert-engine's alarm state on the device that is with
// them in the field: history filtered by severity/acknowledged state, an
// acknowledge flow (offline-capable via the operation registry), and resolve.
// tenantId comes from the JWT via backend decorators, never from variables.
//
// S1-CODEGEN: real gql-tagged documents so graphql-codegen emits
// TypedDocumentNode + result types per operation into ../generated/graphql.ts.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';

import type {
  MobileAlertHistoryQuery,
  MobileAlertHistoryQueryVariables,
  MobileAcknowledgeAlertMutation,
  MobileAcknowledgeAlertMutationVariables,
  MobileResolveAlertMutation,
  MobileResolveAlertMutationVariables,
} from '@/generated/graphql';

/** Shared selection so list/ack/resolve stay shape-identical for the cache. */
const ALERT_FIELDS = gql`
  fragment MobileAlertFields on AlertHistory {
    id
    ruleId
    ruleName
    farmId
    pondId
    sensorId
    severity
    message
    triggeredAt
    acknowledged
    acknowledgedAt
    acknowledgedBy
    acknowledgementNote
    resolved
    resolvedAt
    createdAt
  }
`;

/** Paginated alert history, filterable by severity + acknowledged state. */
export const MOBILE_ALERT_HISTORY: TypedDocumentNode<
  MobileAlertHistoryQuery,
  MobileAlertHistoryQueryVariables
> = gql`
  query MobileAlertHistory(
    $page: Int
    $limit: Int
    $severity: AlertSeverity
    $acknowledged: Boolean
  ) {
    alertHistory(page: $page, limit: $limit, severity: $severity, acknowledged: $acknowledged) {
      ...MobileAlertFields
    }
  }
  ${ALERT_FIELDS}
`;

/**
 * Acknowledge an alert. The input extends MobileCommandEnvelopeInput on the
 * backend, so the offline queue's injected envelope is accepted on replay.
 */
export const MOBILE_ACKNOWLEDGE_ALERT: TypedDocumentNode<
  MobileAcknowledgeAlertMutation,
  MobileAcknowledgeAlertMutationVariables
> = gql`
  mutation MobileAcknowledgeAlert($input: AcknowledgeAlertInput!) {
    acknowledgeAlert(input: $input) {
      ...MobileAlertFields
    }
  }
  ${ALERT_FIELDS}
`;

/** Mark an alert resolved (the underlying condition is fixed). */
export const MOBILE_RESOLVE_ALERT: TypedDocumentNode<
  MobileResolveAlertMutation,
  MobileResolveAlertMutationVariables
> = gql`
  mutation MobileResolveAlert($alertId: ID!) {
    resolveAlert(alertId: $alertId) {
      ...MobileAlertFields
    }
  }
  ${ALERT_FIELDS}
`;
