# Dependency Graph: 2026-04-13-e2e-audit-fixes

## DAG

```mermaid
graph TD
    subgraph Tier 1 — CRITICAL Security [parallelizable]
        P01["01-nats-edge-device-tenant-scoped-routing<br/>CRITICAL | security-sensitive"]
        P02["02-user-deleted-tenant-verification<br/>CRITICAL | security-sensitive"]
        P03["03-mobile-settings-role-enforcement<br/>CRITICAL | security-sensitive"]
    end

    subgraph Tier 2 — HIGH Backend Logic [parallelizable]
        P04["04-archive-channel-membership-fix<br/>HIGH"]
        P05["05-edge-device-maintenance-terminal-guard<br/>HIGH"]
        P06["06-task-event-integrity<br/>HIGH"]
    end

    subgraph Tier 3 — HIGH Frontend [parallelizable]
        P07["07-tenant-admin-cache-key-scoping<br/>HIGH"]
        P08["08-web-shell-access-type-enforcement<br/>HIGH"]
    end

    subgraph Tier 4 — MEDIUM Dashboard/Charts [parallelizable]
        P09["09-billing-analytics-dashboard-truthfulness<br/>MEDIUM"]
        P10["10-chart-single-point-nan-guard<br/>MEDIUM"]
    end

    P01 --> P04
    P01 --> P05
    P01 --> P06
    P02 --> P04
    P02 --> P05
    P02 --> P06
    P03 --> P04
    P03 --> P05
    P03 --> P06
    P04 --> P07
    P04 --> P08
    P05 --> P07
    P05 --> P08
    P06 --> P07
    P06 --> P08
    P07 --> P09
    P07 --> P10
    P08 --> P09
    P08 --> P10
```

## Topological Execution Order (Kahn's, deterministic tie-break by slug ascending)

| Position | Package | Tier | Parallelizable With |
|----------|---------|------|---------------------|
| 1 | 01-nats-edge-device-tenant-scoped-routing | Tier 1 | 02, 03 |
| 2 | 02-user-deleted-tenant-verification | Tier 1 | 01, 03 |
| 3 | 03-mobile-settings-role-enforcement | Tier 1 | 01, 02 |
| 4 | 04-archive-channel-membership-fix | Tier 2 | 05, 06 |
| 5 | 05-edge-device-maintenance-terminal-guard | Tier 2 | 04, 06 |
| 6 | 06-task-event-integrity | Tier 2 | 04, 05 |
| 7 | 07-tenant-admin-cache-key-scoping | Tier 3 | 08 |
| 8 | 08-web-shell-access-type-enforcement | Tier 3 | 07 |
| 9 | 09-billing-analytics-dashboard-truthfulness | Tier 4 | 10 |
| 10 | 10-chart-single-point-nan-guard | Tier 4 | 09 |

## Notes

- Security-sensitive packages (01, 02, 03) are placed at position 1-3, overriding default tie-breaking per Domain Rule 2.
- Within each tier, packages touch entirely different services/apps and have zero shared file dependencies. They can be executed in parallel by independent sessions.
- Tier ordering is strict: all Tier N packages must be committed and verified before any Tier N+1 package begins. This ensures security fixes are deployed first and backend correctness is established before frontend fixes depend on it.
- No cycles detected. All 10 packages are emitted by Kahn's algorithm.
