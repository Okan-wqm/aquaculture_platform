# Dependency Graph: V2 Full Repo Audit Fixes

```mermaid
graph TD
    %% Sprint 0 - CRITICAL (mostly parallelizable)
    P01[01-edge-boot-safe-state]
    P02[02-jwt-asymmetric-signing]
    P03[03-event-bus-pii-removal]
    P04[04-infra-postgres-per-service-roles]
    P05[05-infra-nats-per-service-accounts]
    P06[06-ai-conversation-tenant-isolation]
    P07[07-fe-remote-integrity-full-coverage]
    P08[08-fe-offline-cache-tenant-namespace]
    P09[09-hr-audit-log-coverage]
    P10[10-hr-outbox-migration]
    P11[11-db-migration-tree-restore]
    P12[12-migration-search-path-fix]
    P13[13-sensor-metrics-time-bound]
    P14[14-hydroponics-decimal-math]

    %% Sprint 1 - HIGH
    P15[15-gateway-tenant-lookup-registration]
    P16[16-security-events-flatten]
    P17[17-tenant-id-uuid-convergence]
    P18[18-sensor-precision-decimal]
    P19[19-messaging-receipt-uniqueness]
    P20[20-messaging-tenant-id-write-paths]
    P21[21-farm-batch-close-fixes]
    P22[22-farm-tank-capacity-enforcement]
    P23[23-fe-csp-remove-unsafe-inline]
    P24[24-supply-chain-immutable-pins]
    P25[25-infra-immutable-deploy-tags]
    P26[26-mcp-security-hardening]

    %% Sprint 2 - Remaining HIGH + MEDIUM
    P27[27-platform-kernel-event-bus-hardening]
    P28[28-admin-schema-delete-audit]
    P29[29-edge-scada-pwa-self-contained]
    P30[30-edge-mqtt-failover-wiring]
    P31[31-hr-employee-pii-masking]
    P32[32-tenant-provisioning-lifecycle]
    P33[33-ai-quota-fail-closed]
    P34[34-platform-services-audit-security]
    P35[35-sensor-pagination-installer-fix]
    P36[36-admin-db-management-fixes]
    P37[37-test-infra-ci-hardening]

    %% Dependency edges
    P09 --> P10
    P03 --> P16
    P04 --> P17
    P06 --> P20
    P21 --> P22
    P24 --> P25

    %% Parallelizable sets (no edges between them)
    %% Tier 0 (Sprint 0): P01-P09, P11-P14
    %% Tier 1 (Sprint 0 after P09): P10
    %% Tier 2 (Sprint 1): P15-P21, P23-P24, P26
    %% Tier 3 (Sprint 1 after P21): P22; after P24: P25
    %% Tier 4 (Sprint 2): P27-P37 (all parallelizable)

    %% Styling
    classDef critical fill:#ff6b6b,stroke:#c0392b,color:#fff
    classDef high fill:#f39c12,stroke:#d35400,color:#fff
    classDef medium fill:#3498db,stroke:#2980b9,color:#fff

    class P01,P02,P03,P04,P05,P06,P07,P08,P09,P10,P11,P12,P13,P14 critical
    class P15,P16,P17,P18,P19,P20,P21,P22,P23,P24,P25,P26,P27,P28,P29,P30,P31,P32,P33,P34,P35 high
    class P36,P37 medium
```

## Topological Execution Order (Kahn's Algorithm, lexicographic tie-break)

### Tier 0 (zero in-degree, parallelizable):
01-edge-boot-safe-state, 02-jwt-asymmetric-signing, 03-event-bus-pii-removal, 04-infra-postgres-per-service-roles, 05-infra-nats-per-service-accounts, 06-ai-conversation-tenant-isolation, 07-fe-remote-integrity-full-coverage, 08-fe-offline-cache-tenant-namespace, 09-hr-audit-log-coverage, 11-db-migration-tree-restore, 12-migration-search-path-fix, 13-sensor-metrics-time-bound, 14-hydroponics-decimal-math

### Tier 1 (unblocked after Tier 0):
10-hr-outbox-migration (after 09), 15-gateway-tenant-lookup-registration, 16-security-events-flatten (after 03), 17-tenant-id-uuid-convergence (after 04), 18-sensor-precision-decimal, 19-messaging-receipt-uniqueness, 20-messaging-tenant-id-write-paths (after 06), 21-farm-batch-close-fixes, 23-fe-csp-remove-unsafe-inline, 24-supply-chain-immutable-pins, 26-mcp-security-hardening

### Tier 2 (unblocked after Tier 1):
22-farm-tank-capacity-enforcement (after 21), 25-infra-immutable-deploy-tags (after 24), 27-platform-kernel-event-bus-hardening, 28-admin-schema-delete-audit, 29-edge-scada-pwa-self-contained, 30-edge-mqtt-failover-wiring, 31-hr-employee-pii-masking, 32-tenant-provisioning-lifecycle, 33-ai-quota-fail-closed, 34-platform-services-audit-security, 35-sensor-pagination-installer-fix, 36-admin-db-management-fixes, 37-test-infra-ci-hardening

## Cycle Detection
No cycles detected. Kahn's algorithm emitted all 37 packages.
