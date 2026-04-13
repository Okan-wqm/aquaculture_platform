# Dependency Graph: AquaMobil Offline Sync Remediation

```mermaid
graph TD
    P01[01-aquamobil-leave-authoritative-submit]
    P02[02-aquamobil-leave-readback-convergence]
    P03[03-aquamobil-messaging-authoritative-offline-queue]
    P04[04-aquamobil-sw-handoff-basename-routing]
    P05[05-aquamobil-truthful-queued-state-ui]
    P06[06-aquamobil-permissions-fail-closed]
    P07[07-aquamobil-mobile-offline-regression-harness]

    P01 --> P02
    P02 --> P05
    P03 --> P04
    P03 --> P05
    P02 --> P07
    P04 --> P07
    P05 --> P07
    P06 --> P07

    classDef high fill:#f39c12,stroke:#d35400,color:#fff
    classDef medium fill:#3498db,stroke:#2980b9,color:#fff

    class P01,P03,P04,P05 high
    class P02,P06,P07 medium
```

## Topological Execution Order

### Tier 0 (zero in-degree, parallelizable)
01-aquamobil-leave-authoritative-submit, 03-aquamobil-messaging-authoritative-offline-queue, 06-aquamobil-permissions-fail-closed

### Tier 1 (unblocked after Tier 0)
02-aquamobil-leave-readback-convergence (after 01), 04-aquamobil-sw-handoff-basename-routing (after 03)

### Tier 2 (unblocked after Tier 1)
05-aquamobil-truthful-queued-state-ui (after 02, 03)

### Tier 3 (validation gate)
07-aquamobil-mobile-offline-regression-harness (after 02, 04, 05, 06)

## Cycle Detection
No cycles detected. All 7 packages have a valid execution order.
