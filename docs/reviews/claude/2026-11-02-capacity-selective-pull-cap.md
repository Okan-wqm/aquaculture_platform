# Capacity gate refuses a selective deploy a full deploy fits — 2026-11-02

Found on 2026-11-02 when the deploy of 7a547f528 (#2196) was refused at `capacity-preflight`
(09:51Z) and the gateway's farm bridge stayed disconnected as a result.

## DEPLOY-HIGH-034

Defect. `projected_pull_bytes` estimated a selective deploy as the number of services times
`SERVICE_PULL_ESTIMATE_GIB` (2 GiB), with no upper bound. A change to a shared library selects
almost every image: 26 services gave 52 GiB, and with 36.9 GB free the projected free space was
−18.9 GB against the 10 GiB selective reserve. A full deploy of every image is estimated at
`FULL_PULL_ESTIMATE_GIB` (17 GiB, the script's own worst case with no layer reused) and would
have passed on the same disk. A selective deploy pulls a subset of those images, so it cannot
need more.

Severity HIGH: a fix touching a shared library could not reach production. Owner Okan-wqm,
deadline 2026-11-03.

Where. `scripts/deploy/droplet-capacity.sh:828` (the unbounded estimate), `:88` (the full
estimate), `:1046` (projected free space against the reserve).

Fix. The selective estimate is `min(count × SERVICE_PULL_ESTIMATE_GIB, FULL_PULL_ESTIMATE_GIB)`.
Thresholds and reserves are unchanged.

Verified. `tests/invariants/deploy-ssot-contract.spec.ts` runs the gate against the fake
`docker`/`df` harness with the script computing the estimate: five services with a 1 GiB
per-service and 2 GiB full estimate project 2 GiB and pass without GC; one service projects
1 GiB. Without the cap the first case is refused.
