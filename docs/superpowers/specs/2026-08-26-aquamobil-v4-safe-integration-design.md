# AquaMobil v4 Safe Integration Design

- **Date:** 2026-08-26
- **Status:** Approved for implementation planning
- **Source branch:** `origin/feature/aquamobil-v4-redesign`
- **Source pull request:** #1107
- **Integration base:** `origin/main`

## 1. Objective

Integrate every valid behavior from `feature/aquamobil-v4-redesign` into `main` without merging its
stale 480-file patch as a unit. The integration must preserve correctness already present on `main`,
establish one authority for every concern, and make security and migration failures block the
relevant pull request.

The program is complete only when every source commit has an evidence-backed disposition, every
accepted behavior is present on `main`, every superseded implementation has been removed, and all
required verification is green.

## 2. Evidence at Design Time

The design is anchored to these immutable commits:

| Ref                                    | Commit                                     |
| -------------------------------------- | ------------------------------------------ |
| `origin/main`                          | `4002868c535a2d8676aad6eadd5f4bbd57d4625b` |
| `origin/feature/aquamobil-v4-redesign` | `542c8e0bb7ff3afbeee0496f277f8926526cc41a` |
| merge base                             | `8d8d54365ada11d45b43374af76e9814c5958ff0` |

At this point the source branch is 219 commits behind and 35 commits ahead of `main`. Its unique
history consists of 33 non-merge commits and two merge commits. The merge-base diff changes 480
files with 42,778 insertions and 10,828 deletions. Pull request #1107 is open, reports conflicts,
has no review, and has failing test/security aggregate checks.

Only one textual conflict is visible in a synthetic merge, in
`apps/farm-service/src/feeding/services/__tests__/daily-feeding-execution.service.spec.ts`. That
does not make the branch safe to merge: semantic overlap, generated artifacts, schema evolution,
published events, package state, and deployment behavior are the larger risks.

The integration work starts from a clean linked worktree on `feat/aquamobil-v4-safe-integration`.
Baseline validation on the anchored `main` commit is:

- affected lint: pass;
- invariant tests: 228 suites and 2,423 tests pass;
- dependency installation: succeeds, while the repository-wide npm graph reports 40 audit findings
  (28 moderate, 10 high, 2 critical). Each affected production dependency path must be classified
  during the slice that owns it; aggregate counts cannot be used as evidence of runtime reachability
  or safety.

## 3. Decision

The source branch is a read-only behavior and provenance reference. None of its merge commits or
functional commits will be merged or cherry-picked into the integration branch. Accepted behavior
will be reimplemented on the current `main` architecture in dependency-ordered pull requests.

This decision rejects two alternatives:

| Alternative                            | Rejection reason                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge or rebase #1107 as one change    | The review surface is too broad, CI is red, package state is inconsistent, published interfaces change without a complete rollout protocol, and current-main fixes can be overwritten semantically.     |
| Rewrite from product screenshots alone | This discards the behavioral intent and regression knowledge contained in 33 non-merge commits plus two explicit merge resolutions. The source objects remain useful as requirements and test evidence. |

The chosen approach preserves branch knowledge without importing branch assumptions.

## 4. Non-Negotiable Integration Invariants

### 4.1 One authority per concern

| Concern                                | Required authority                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| appearance preference and DOM mutation | one appearance runtime; React hooks are typed bindings to it                           |
| design values                          | CSS custom properties in the AquaMobil token layer                                     |
| touch density                          | the same appearance runtime and `data-density` contract                                |
| loading/error state                    | one reusable `Loadable`/`DataState` contract                                           |
| GraphQL types and operations           | composed schema plus generated clients                                                 |
| feeder assignment                      | database-enforced unit/feeder model owned by farm-service                              |
| equipment identity                     | farm-service equipment identity; sensor-service stores attested tenant-scoped bindings |
| NATS permissions                       | `infrastructure/nats/services.yaml`, followed by generated configuration               |
| feeding stock mutation                 | the storage-ledger writer already established on `main`                                |
| migrations                             | new service-owned forward migrations generated from current schema state               |

No hook, entity, event, mutation, migration, generated client, or package authority may be copied
under a second name. Replacing an authority requires deleting its superseded implementation in the
same pull request that activates the replacement.

### 4.2 Main correctness wins

Current-main and verified adjacent-history preservation gates include:

- `2f5ef21eb`: the water-quality workflow must use compiler-owned generated input contracts.
  Evidence correction: this commit is not an ancestor of the anchored `origin/main`; it exists on
  `origin/claude/repoda-agents-farm-audit-qekxmh`, while anchored main still carries the
  hand-written `CreateWaterQualityInput` and an inline operation. V2 must therefore reimplement the
  verified generated-contract behavior as its first prerequisite instead of treating it as baseline
  state. Feature-branch hand-written mirror types must not survive that prerequisite.
- `550a72311`: the storage ledger is the feeding write-path authority. Feeding work must be built
  around that writer rather than restoring a second stock mutation path.
- `82852e31f`: the current migration SQL gate remains authoritative. Source-branch migration gate
  edits are not copied.
- AquaMobil remains a standalone `/mobile/` PWA with the handwritten `injectManifest` worker, React
  singleton aliases, content-hashed shell assets, GraphQL no-cache behavior, logout cache purge, and
  the existing foreground/closed-client offline replay lanes.
- The current production presign path is not accepted as baseline correctness: farm and messaging
  can return Docker-internal `minio:9000` URLs to browsers, while AquaMobil CSP permits only its own
  origin. I1 must establish one public presign origin, keep internal object operations on the
  internal client, and prove signed PUT/GET through the real edge before the appearance slice
  starts.
- The Firebase messaging worker retains its distinct sub-scope. Neither worker may acquire
  origin-wide authority.

Every slice must identify additional main-only commits touching its paths before implementation.

### 4.3 No patch-shaped migration mechanisms

The program does not introduce adapters that preserve two business interfaces, duplicate stores,
silent fallbacks, hand-written GraphQL mirrors, handwritten generated files, or `ours` merges that
only make Git history appear integrated.

The UI can move page by page because each page has exactly one component system. V0 replaces the
current duplicated inline-script/React-store behavior with one CSP-valid appearance runtime while
preserving the current `light | dark | system` and `.dark` contract. Semantic token use may then
increase while invariant ratchets prohibit new legacy utilities and Konsta imports. Legacy body and
Konsta styling remain unchanged until their owning pages move; feature-final CSS is never copied
wholesale over that state.

The UI convergence slice changes that single runtime atomically to `night | day | colour | system`,
removes `.dark` as an AquaMobil styling contract, removes the last Konsta and legacy utility
consumers, and regenerates package state. A one-time preference data migration maps an installed
PWA's old value into a versioned v4 record, writes the new record, and removes the old key. A
migrated installation reads only the v4 record. These are two complete product contracts in an
ordered release sequence, not two concurrent appearance authorities.

### 4.4 Protected integration history

Each pull request begins from the current `origin/main` or from an explicitly declared predecessor
slice. Once published, a slice branch is updated with normal, non-force history only. Protected
branch checks, hooks, signatures, and review requirements are never bypassed.

The append-only preflight records the exact main commit at worktree creation; it is not rewritten
merely because an independent lane advances main. Before review and merge, the coordinator compares
all changes since that base with the slice-owned and shared-authority path sets. A zero-overlap
branch may proceed only through required checks on the latest merge-queue candidate. Any overlap
blocks the PR until current main is merged into the slice with normal history, the semantic diff is
reviewed again, and the complete affected/security gates pass. A later PR that invalidates an
already reconciled slice requires a new plan-pinned remediation boundary; immutable evidence is
never edited to pretend the conflict did not occur.

## 5. Appearance and Deployment Architecture

### 5.1 CSP-safe pre-paint

Production CSP uses `script-src 'self'` without inline-script permission. Theme and density
pre-paint therefore run from a blocking, same-origin classic script loaded in `<head>`. No inline
script and no `unsafe-inline` relaxation is allowed.

The Firebase messaging worker follows the same policy. Its existing notification, active-user,
logout, and deeper-scope behavior is moved from a public script that imports mutable remote compat
files into typed source bundled from AquaMobil's one locked Firebase dependency. The emitted worker
has a stable same-origin URL, contains no remote script import, and is exercised under the rendered
production CSP. The platform CSP manifest remains the only policy authority; nginx and browser tests
consume its generated AquaMobil profile.

The authored authority is a typed appearance-runtime source. The AquaMobil build compiles it as a
classic IIFE, emits a content-hashed asset, and rewrites the matching HTML to load that exact asset
before styles and application modules. The `theme-color` meta element precedes the script. A
handwritten stable `public/theme-init.js` is prohibited.

The emitted runtime installs a versioned, typed global snapshot/subscription API before first paint.
`useDarkMode` in V0, then `useTheme` and `useDensity` at convergence, are bindings to that API only.
A missing or version-mismatched runtime fails the build and browser contract tests; hooks do not
create a fallback store. The authored runtime is the authority for:

- preference schema validation and one-time data migration;
- system-theme resolution;
- the versioned DOM contract: `.dark` plus `data-density` in V0, then `data-theme` plus
  `data-density` with `.dark` removed at convergence;
- browser `theme-color` mutation;
- OS-preference and cross-tab change propagation;
- a small subscription/snapshot API consumed by React.

The same boundary handles blocked or unavailable `localStorage` consistently and resolves to the
documented system preference without throwing. React code does not access appearance storage
directly. Theme colors, parsing, migration, DOM mutation, and resolution are therefore compiled from
one source rather than copied between a public script and hooks.

### 5.2 Asset serving

The appearance asset follows the same revisioned shell policy as its matching HTML and CSS. It is
included in the Workbox precache manifest with its content hash; nginx `no-store` is not used as a
false freshness guarantee for a precached resource. The worker update protocol must install a
complete new shell, coordinate document build IDs, reload controlled clients onto the matching
HTML/runtime/style generation, and retain any shell generation still named by a controlled client.
Cache cleanup occurs only after no controlled client reports that generation. Offline startup
continues entirely on one installed generation.

This version handshake is the mechanism that permits `.dark` to be removed. Browser tests cover an
old active tab, a background tab, an offline reload, an update becoming available, client reload,
and cache retirement. Immediate `skipWaiting()` plus unconditional old-precache deletion does not
satisfy the contract.

The deployment path preserves AquaMobil's `/mobile/` base and handwritten `injectManifest` service
worker. Nginx behavior is:

- missing JavaScript, CSS, font, manifest, or worker assets return an honest 404 and never the SPA
  HTML document;
- `^~ /assets/`, `^~ /icons/`, and `^~ /fonts/` locations win over extension regexes, use honest
  `try_files`, retain their cache policies, and re-include the security-header SSoT;
- the outer `/mobile/` proxy and inner stripped paths are tested together;
- self-hosted Geist font files are present in the PWA build and precache graph;
- CSP remains strict;
- `Service-Worker-Allowed` is `/mobile/`, including for the worker that owns the deeper Firebase
  messaging sub-scope, never `/`.

Production and staging run on separate droplets and never share private certificate material. One
closed deployment manifest owns the two exact host/certificate identities; one reviewed nginx source
template is rendered to an untracked deployment-local config containing only the selected identity.
The default HTTP and MQTT TLS servers use native handshake rejection, selected SNI and Host must
agree exactly, unknown public HTTP hosts never expose the loopback-only health endpoint, and
deployment fails before replacing the active config when its selected certificate, SAN, expiry, key
match, or rendered `nginx -t` check is invalid. Neither runtime depends on the peer certificate
being present or absent to enforce host isolation.

Browser object traffic is same-origin and signature-gated. Internal storage operations use the
Docker MinIO endpoint; presigners use the public application origin. The edge exposes only the
declared farm/messaging bucket prefixes, preserves host/path/query bytes required by SigV4, strips
cookies before proxying, permits only signed GET/HEAD/PUT, caps request bodies at the server-owned
media limit, and applies `nosniff` plus a sandboxed object-response CSP. An unsigned or altered URL
must remain forbidden. A generated object-route manifest is the single authority for public bucket
prefixes and per-environment bucket membership; it consumes, but cannot restate, the closed
deployment host authority.

The source branch's `293d78020` is narrow enough to use as a reference, but it is still reviewed
against current nginx before reimplementation.

### 5.3 Package integrity

The source branch removes Konsta from `package.json` but leaves an inconsistent standalone lockfile
and a `konsta/react` Vite optimization entry. The final Konsta-removal slice must:

- remove all source imports first;
- remove the Vite optimization entry;
- remove patch/install hooks that exist only for Konsta;
- regenerate the correct lockfile using the repository toolchain;
- prove both Docker's `npm ci --ignore-scripts` path and a normal `npm ci`, then typecheck, tests,
  and production build;
- resolve every high or critical finding reachable from the AquaMobil production graph.

No automated audit command with breaking rewrites is used as a substitute for dependency-path
analysis.

## 6. Integration Dependency Graph

```text
I1 -> [I1 R] -> V0 -> [V0 R] -> [V0 findings close + closure R]
                                      |
                                V1 -> [V1 R]
                                      |
                                V2 -> [V2 R]
                                      +------------------+
                                      |                  |
                                V3 -> [V3 R]       V4 -> [V4 R]
                                      +------------------+
                                               |
                                         V5 -> [V5 R]
                                               |
                               [product findings close + closure R]
                                               |
                              UI convergence -> [UI R]
                                               |
                                  [UI finding close + closure R]
                                               |
                                               +------------------+
                                                                  |
F0 (three boundaries) -> [F0 R]                                   |
        |                                                         |
F1a (three boundaries) -> [F1a R]                                 |
        |                                                         |
F2 -> [F2 R] -> F1b -> [F1b R]                                   |
        |                                                         |
[feeding-foundation findings close + closure R]                   |
        |                                                         |
F3 -> [F3 R] -> F4 -> [F4 R] -> F5 -> [F5 R] ---------------------+
                                                                  |
                                              V6 mobile VFD -> [V6 R]
                                                                  |
                                      [VFD findings close + closure R]
```

`R` is a distinct protected-main reconciliation PR, never an implementation-branch ledger edit. A
`findings close + closure R` box is likewise two protected PRs: registry/review state first, then
the immutable closure evidence and regenerated ledger. No downstream arrow opens before every box on
its incoming path is a protected-main ancestor. F0 and F1a may run beside I1 because they use no
container fixture; F2 has the additional cross-edge from I1 reconciliation because its NATS live
harness consumes I1's sole pinned-image resolver.

V2 starts only after V1 reconciliation and establishes the shared `TankCard` plus queued GraphQL
operation/generated-document authority used downstream. V3 and V4 then start from separate fresh
worktrees at the exact V2 reconciliation main commit and may run independently of each other. V5
waits for both reconciliations because it embeds those pages. V6 waits for both the UI convergence
closure reconciliation and the complete server-side VFD safety chain.

## 7. Pull Request Slices

### I1 — nginx and proxy asset boundary

Reimplement `293d78020` against current nginx. Add the asset-serving invariant and validate a
deployed `/mobile/` path through the outer and inner nginx configurations. Preserve the `^~`
asset/icon/font ordering, honest extension 404s, security-header includes, the SPA route fallback,
and worker scope restricted to `/mobile/`. Establish deployment-local nginx rendering and
certificate/host isolation before the first staging use; test production and staging from the same
source template while each case has only its own required key material. Close the current
public-object HIGH in the same I1 gate: separate internal clients from public presign clients and
prove signed/altered PUT/GET behavior through each selected edge identity. This slice owns serving
policy; V0 owns the appearance runtime that exercises it.

### V0 — semantic tokens and shared primitives

Sources: `27fd9e5be`, `c4c70636f`, the CSP correction from `18bf1b3e3`, and the corrected
`CapacityMeter` semantics from `96c082aff`.

Introduce the token vocabulary, density dimensions, self-hosted fonts, and shared primitives. Token
values are rederived from the final branch behavior; the two early commits are not copied as
patches. `DataState` is not part of this slice because it belongs to the query-state architecture.

Replace the CSP-blocked inline initializer and `useDarkMode`'s internal store with the generated,
content-hashed appearance runtime and a typed hook binding. V0 preserves light/dark/system behavior
and the existing body/Konsta `.dark` contract; it does not copy the feature branch's final body CSS
or expose the colour theme. It also proves the meta-before-script order and first-paint theme,
density, and browser-chrome color under production CSP.

Ratchets are measured with their own invariant matcher against current `main`, must never increase,
and become zero-value bans at the UI convergence gate. Source-branch baseline constants are not
reused.

### V1 — shell, navigation, and reusable data-state semantics

Sources: `1f05d0b91`, `160330eaf`, `3fa34505b`, `2b71d59f3`, and relevant corrections from
`e398704d1` and `18bf1b3e3`.

Build the dock, shell contract, route loading behavior, scan-to-unit route and `resolveScannedUnit`,
`Loadable`/`DataState`, and query-error propagation. Hooks cannot swallow query errors and pages
cannot create local variants of the same loading/error state machine. A route test proves that a
valid scan resolves the intended unit and invalid input fails visibly.

### V2 — home and field workflows

Sources: `f2590b3a1`, `33a89eefd`, `700458279`, `e398704d1`, `18bf1b3e3`, and `96c082aff`.

Integrate home prioritization, unit/tank details, in-context logging, capacity semantics, farm
summary, and regulated water-quality workflows. First reimplement the verified compiler-owned
water-quality operation and input behavior from `2f5ef21eb` on the then-current main; after that
prerequisite, the generated water-quality input is the only request contract.

### V3 — messaging and reusable information cards

Sources: `c16cd9a95` and `2a7a749f8`.

Move messaging pages and shared AI/status/reading cards onto the semantic primitives. Message
transport, tenant query keys, and error propagation remain owned by current-main data boundaries.

### V4 — reports, warehouse state, and remaining pages

Sources: `602fa8776`, `bcac0a73e`, `9a2768092`, and `b25cd4d65`.

Integrate reports, storage outage-versus-empty semantics, the regulated review surface, and the
remaining page conversions. All converted pages consume the shared explicit data-state contract.

### V5 — tablet control board

Source: `f102bc831`.

Add the two-dimensional board breakpoint, tablet layouts, board pages, unit panes, report deadline
behavior, and chat embedding only after V2 through V4 are available. Tablet routes must be reachable
and must preserve mobile navigation behavior below the board breakpoint.

### UI convergence gate — v4 theme activation and Konsta removal

Sources: `350fe409c`, `4df6eae77`, and `6731656f8`, plus the CSP correction in `18bf1b3e3`.

Activate the versioned `night | day | colour | system` preference and glove density through the
single pre-paint runtime. Remove `useDarkMode`, `.dark` styling, all Konsta imports and dependency
state, old utility palettes, and migration-only comments. Promote ratchets to zero-value bans.

The source branch's retained `.dark` mutation for stale service-worker chunks is explicitly not
ported. The build-ID handshake, complete-shell install, controlled-client reload, generation-aware
cache retention, and route-level browser matrix defined in section 5.2 must prove that one document
cannot combine a v4 appearance runtime with an obsolete styling chunk. The v4 program cannot be
released or closed before this gate is merged.

### F0 — weighing as feeding/ration authority

Source: `826690623`.

Reimplement weighing-driven biomass, ration, and projection behavior around main's storage-ledger
writer. Readers move before retired fields are removed. New migrations follow nullable, backfill,
constraint sequencing.

F0 also adds optional `tankId` to the published `GrowthSampleRecorded` contract, updates its
producer, and subscribes the stock projection to the event. Acceptance proves that weighing
refreshes both ration state and mobile/container stock projections without introducing another stock
writer.

### F1a — feeder model and database-enforced assignment

Source: `0aabe5a5e`.

Introduce tenant-scoped feeder assignment with a database-enforced active-share invariant: the
committed total is exactly zero or 100. Application validation alone is insufficient. Concurrent
assignment and cross-tenant access tests are required. This slice also migrates sub-equipment
compatibility from a scalar to an array and updates the farm seed, equipment-type seed, DTO/type
handlers, and selection tests so compatible feeder hardware remains configurable. It does not
publish `UnitFeederAssignmentsChanged`.

### F2 — published event language and NATS authority

Sources: the contract portions of `0aabe5a5e` and `1401860c7`, plus `8fad0357a`.

Order is contract/interface, validator, explicit version-history audit, then generated ACL. All
three event types are new on anchored main, so they begin honestly at version 1 and do not receive
fabricated no-op upcasters. The upcaster-chain invariant records that decision and requires a real
upcaster only if a later release changes an existing wire shape. `infrastructure/nats/services.yaml`
is edited and the bounded NATS configuration block is generated. Cert CN remains the only NATS
identity. No producer is activated in F2.

The three subjects are:

- `UnitFeederAssignmentsChanged`;
- `VfdDriveBindingAttested`;
- `VfdDriveBindingAttestationRequested`.

### F1b — feeder assignment API and event producer

Source: the producer/API portion of `0aabe5a5e`.

Expose the assignment commands, queries, resolver, and service only after F1a's database invariant
and F2's event validator/ACL exist. Publish `UnitFeederAssignmentsChanged` through the established
outbox/event path and prove validator acceptance plus tenant-safe consumer behavior.

### F3 — VFD binding and attestation

Source: `1401860c7`.

Farm-service attests the complete equipment identity and assignment. Sensor-service owns a
tenant-scoped binding and rejects stale, absent, deleted, inactive, or mismatched attestations.
Equipment deletion and assignment changes revoke or reconcile the binding.

Fresh migrations carry each legacy `vfd_devices.pump_id` into a pending, non-actuable equipment
binding. They deliberately do not infer equipment from `tank_id`, because a drive is wired to
equipment rather than a unit. Per-tenant pre/post backfill counts must match; pending bindings must
refuse commands; all legacy readers must be gone before `pump_id` and `tank_id` are dropped.

### F4 — feeder physical model and mass projection

Source: `05479fd83`.

Introduce discrete/continuous dosing physics, `feedId` calibration identity, optional load-cell
evidence, and tenant-safe mass projection. The source commit makes breaking event and GraphQL
changes without a complete rollout protocol, so its public interface shape is not copied.

`FeederCalibrationsSaved` is versioned and upcasted before producer rollout. `feederSetup` lands as
an additive GraphQL field; generated clients migrate before the retired field is removed in the same
tracked F4 rollout.

The calibration migration never silently deletes unmatched or ambiguous legacy rows. It adds
`feedId` as nullable, backfills only an exact single live-feed match, reports unresolved counts per
tenant, and blocks the constraint/drop phase while any unresolved row remains. Operator-provided
canonical mappings resolve those rows in the owning table; only a zero-unresolved proof permits
`feedId` to become required and the retired identity to be removed.

### F5 — feeding-loop completion

Sources: the farm portion of `66fd87865` and verified behavior from `b4b2f653c`.

Complete ration basis, transitions, reconciliation, daily-plan migration, harvest coupling, and
water-quality coupling on top of F0 through F4 and the storage-ledger authority. Narrative
documentation is updated only from verified behavior.

### V6 — mobile VFD operations

Source: the AquaMobil portion of `66fd87865`.

Add generated VFD operations, drive hooks, drive surfaces, tablet pane integration, and explicit
online command behavior. Start, stop, frequency, reset, and emergency operations are structurally
excluded from the offline replay registry. Authorization and attestation failure are visible to the
operator and fail closed.

`OperationType` remains the positive offline whitelist and actuator hooks import no queue or replay
path. The server contract is the actuation-root authority; generated or server-verified tests prove
that every actuation mutation stays outside the whitelist. A second handwritten frontend command
inventory is prohibited.

## 8. Source History Disposition Ledger

Every one of the 35 source-only history objects has a disposition. The 33 non-merge commits are
behavior/documentation units:

| Source commit(s)                                                             | Disposition                                                                           | Integration owner       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `27fd9e5be`, `c4c70636f`                                                     | reimplement                                                                           | V0                      |
| `1f05d0b91`, `160330eaf`, `3fa34505b`, `2b71d59f3`                           | reimplement                                                                           | V1                      |
| `f2590b3a1`, `33a89eefd`, `700458279`, `e398704d1`, `18bf1b3e3`, `96c082aff` | split by behavior and reimplement                                                     | V0/V1/V2/UI convergence |
| `c16cd9a95`, `2a7a749f8`                                                     | reimplement                                                                           | V3                      |
| `602fa8776`, `bcac0a73e`, `9a2768092`, `b25cd4d65`                           | reimplement                                                                           | V4                      |
| `f102bc831`                                                                  | reimplement                                                                           | V5                      |
| `350fe409c`, `4df6eae77`, `6731656f8`                                        | reimplement final-state behavior                                                      | UI convergence          |
| `293d78020`                                                                  | reimplement after current-nginx review                                                | I1                      |
| `826690623`                                                                  | reimplement on storage-ledger main                                                    | F0                      |
| `0aabe5a5e`                                                                  | split and reimplement                                                                 | F1a/F2/F1b              |
| `1401860c7`                                                                  | split and reimplement                                                                 | F2/F3                   |
| `05479fd83`                                                                  | reimplement with versioned interfaces                                                 | F4                      |
| `66fd87865`                                                                  | split and reimplement                                                                 | F5/V6                   |
| `8fad0357a`                                                                  | reimplement from `services.yaml`, then generate                                       | F2                      |
| `b4b2f653c`                                                                  | reimplement verified farm behavior; regenerate docs from result                       | F5                      |
| `2425e7698`                                                                  | exclude as branch-only markdown repair; current docs are assessed after F5            | none                    |
| `ccaead92d`                                                                  | exclude as 123-file formatting-only churn; format touched files in their owning slice | none                    |
| `542c8e0bb`                                                                  | exclude as an independent fish-count invariant maintenance change                     | none                    |

The remaining two objects are merge-resolution units. They are not ignored merely because they have
two parents:

| Merge commit                               | Ordered parents                                                                        | Result tree                                | Resolution-path blobs                                                                                                                                  | Disposition                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d6cc9d889b26a2566fe0211868e8faf7f2b34b23` | `b4b2f653cb7fc0cfb7328890fa8abb8f3e83c4d0`, `8d8d54365ada11d45b43374af76e9814c5958ff0` | `8d22e50aa070d0c36e9b82aff29247151e42b897` | `docs/reviews/orphan-findings.md=279ec1dba8ee557ee6a86eb03d97349a39ec0d7c`; `tools/quality/format-scope.json=a23838b45be7ea883a4e226c5ff75dc8b3a7a8f3` | exclude as review-ledger whitespace plus generated format-scope conflict resolution; reverify against current-main review lineage and regenerate format scope             |
| `1cae13834df31b4f5f982785e27b68d717d3de0b` | `bcac0a73e55e7a7687b23674d7f526f1408239c5`, `1acda8a012aff0f492c9af13ea111f91da56ad44` | `a13ce39d6ee34af1e609efa9febacf4891998265` | `docs/reviews/orphan-findings.md=f35863b4ff8152e78973ddcdf8b5899c32bc44b8`; `tools/quality/format-scope.json=8e42aa04a69f5893c68325e8faeb598f017808a2` | exclude as main review-ledger selection plus regenerated format-scope resolution; reverify that current main carries the newer review authority and fresh generated scope |

The verifier recomputes each merge's exact ordered parents, result tree, approved two-path set, and
path blob OIDs from Git. A pinned Git version with repository/system attributes, textconv, external
diff commands, color, and rename heuristics disabled may additionally remerge the commits to prove
that no third resolution path exists; the rendered diff text or its hash is diagnostic, not the
identity authority. Any parent/tree/blob/path mismatch is new scope. Neither resolution contains an
accepted AquaMobil product/runtime authority; both concern only the append-only review ledger and
generated format metadata, whose current-main authorities are verified at closeout. Generated
GraphQL files, NATS configuration, migration manifests, and format-scope artifacts are always
recreated by their owning generators.

## 9. Data, Schema, and Published-Interface Safety

### 9.1 Migrations

- Existing migration files are never edited.
- Source-branch migration timestamps do not grant transplant safety.
- New migrations are generated from current schemas and registered through each service's current
  migration authority.
- Tenant tables omit `schema:`; infrastructure tables use the authoritative
  `MODULE_SCHEMAS[].infrastructureTables` classification.
- Column evolution follows add-nullable, backfill, validate, then enforce.
- A migration cannot silently delete or collapse ambiguous tenant data. Unresolved rows remain in
  their owning canonical table and block destructive constraint/drop phases until measured
  remediation reaches zero.
- Backfill and rollback rehearsals run against representative pre-slice data.

### 9.2 Events

- Events remain flat and are created with `createBaseEvent()`.
- Trust-boundary events receive JSON Schema validators.
- Additive event fields update the contract and validator before the producer emits them.
- Breaking event vocabulary receives a version/upcaster path before new producers publish.
- Producers and consumers cannot land ahead of the validators and authorization that make the new
  language safe.

### 9.3 GraphQL

- Public replacement fields are introduced additively.
- Clients move using generated operations and types.
- Schema composition and code generation are checked before removal of a retired field.
- Hand-written replicas of generated inputs are prohibited.

## 10. Verification and Merge Gates

Every slice must pass:

1. a fresh current-main overlap review;
2. focused TDD tests written before implementation behavior;
3. affected typecheck, test, lint, and build, plus lint on every touched source file;
4. generated-artifact freshness checks;
5. zero unresolved high or critical finding reachable from the affected production dependency graph;
6. protected PR checks and review without bypass.

V0 adds a canonical standalone `test` script that runs `vitest run --config vitest.config.ts`; later
slices invoke it through the AquaMobil package. The existing whole-app ESLint baseline is not
represented as green: affected lint and touched-file lint are the merge evidence until the owning
repository gate proves a broader clean baseline.

Additional gates are owned by the relevant slice:

| Area          | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AquaMobil     | standalone typecheck, canonical Vitest command, production build, route reachability, scan resolution, query-error surface, design-token/field ergonomics, advisory marking                                                                                                                                                                                                                                                                                                            |
| appearance    | generated classic asset and matching HTML/precache revision, all four Geist faces, meta-before-script, CSP execution before first paint, theme/density/chrome color, unavailable storage behavior                                                                                                                                                                                                                                                                                      |
| PWA           | build-ID update matrix, generation-aware cache retirement, offline shell, existing logout purge, GraphQL no-cache, bundled same-origin FCM worker/sub-scope, queue/replay preservation                                                                                                                                                                                                                                                                                                 |
| asset serving | renderer/topology invariants plus separate production/staging outer+inner `/mobile/` smoke: each deployment starts with only its selected certificate, unknown/cross SNI+Host fails closed, existing JS/CSS/font/worker headers are preserved, missing assets return 404, `/mobile/units` returns SPA HTML/200, worker scope is `/mobile/`; real MinIO signed PUT/GET succeeds while unsigned, altered, cross-environment, oversized, and forbidden-method object requests fail closed |
| package       | Docker `npm ci --ignore-scripts`, normal `npm ci`, regenerated lockfile parity, production dependency-path audit                                                                                                                                                                                                                                                                                                                                                                       |
| F0            | weighing refreshes ration and stock projections; additive `GrowthSampleRecorded.tankId` contract/validator/producer/listener parity                                                                                                                                                                                                                                                                                                                                                    |
| F1a/F1b       | concurrent database share invariant, tenant isolation, hardware compatibility/seed parity, event producer only after F2                                                                                                                                                                                                                                                                                                                                                                |
| F0-F5         | farm unit/e2e tests, schema invariants, migration SQL lint, migration manifest completeness, per-tenant backfill counts, rollback rehearsal                                                                                                                                                                                                                                                                                                                                            |
| F2-F4         | validator acceptance/rejection, upcaster chains, NATS static/live ACL tests, cert-only publish identity, pending-binding refusal, zero unresolved calibration rows                                                                                                                                                                                                                                                                                                                     |
| V6            | generated selections compile against composed schema; authorization and attestation fail closed; server actuation roots remain outside the positive offline whitelist                                                                                                                                                                                                                                                                                                                  |

I1 establishes a required PR container/proxy smoke lane so deployed-path evidence exists before
merge. The existing mobile Playwright run after a `main` deployment remains useful detection, but is
not represented as a pre-merge gate.

A pull request is not mergeable when its owned gate is red, even if unrelated repository checks are
green.

## 11. Source Branch Closeout

Pull request #1107 remains open and the source branch remains unchanged while it is an active
provenance source. Closeout requires all of the following:

- all 35 source-only objects have a final disposition: 33 non-merge behavior/documentation rows and
  two machine-verified merge-resolution rows;
- every ledger entry records disposition, owning integration PR, resulting main commit,
  generated-artifact evidence, and verification run;
- every accepted behavior is merged to `main` and linked to that passing evidence;
- every exclusion has been rechecked against the then-current `main`;
- the final source SHA is resolved from the remote and recorded at closeout;
- no open pull request other than source PR #1107 and no active worktree consumes the source branch;
  #1107 remains a separately approved Closeout Task 7 source action, not a closeout prerequisite;
- an annotated provenance tag under the repository's protected provenance namespace resolves, after
  peeling, to the exact final source SHA; the active ruleset is verified to reject tag update and
  deletion, and a fresh clone can fetch the tag and rerun the source-exclusion checks;
- the provenance tag and its normalized evidence are merged through a protected closeout PR before
  any authorized source action;
- closing PR #1107 and deleting the source branch are separate explicit user approvals; only the
  approved subset is performed, in close-then-delete order when both are approved;
- deletion additionally requires an active exact-ref ruleset with no bypass actors that prevents
  source-branch updates and recreation while leaving deletion permitted, followed by a fresh proof
  that the frozen ref still equals the approved source SHA; no force or force-with-lease push is
  permitted, failure to prove the freeze retains the branch, and a successful deletion leaves the
  exact-ref recreation restriction active and recorded in the receipt;
- after any approved close and/or delete action, a separate protected post-action receipt records
  the approvals, actions that actually succeeded, observed PR and source-ref states, command-output
  digests, source-freeze control evidence, and fresh-clone signed-provenance proof without weakening
  the terminal ledger checks. A durable two-phase intent/result journal is written around each
  remote action and retained until that receipt is protected-main-verified, so interruption or a
  later action failure cannot erase an earlier success;
- when neither remote action is approved, no post-action receipt is fabricated and the clean,
  detached coordinator worktree remains at the exact final-report main commit for later resumption.

Because the implementation is reconstructed on current `main`, the source tip will not become a Git
ancestor of `main`. It must therefore be reported as **semantically superseded**, never as strictly
Git-merged. An `ours` merge, empty ancestry marker, or equivalent history manipulation is forbidden.
Deletion approval is based on the complete behavior ledger and verification evidence, not a
misleading `git branch --merged` result. If the repository cannot enforce immutable protection for
the provenance tag, the source branch is retained and the closeout claim is narrowed accordingly;
branch deletion is never used as a substitute for durable provenance.

## 12. Planning Handoff

After this design is reviewed, the implementation plan must expand each slice into file-level,
test-first tasks with exact commands and commit boundaries. Execution uses isolated worktrees,
subagent review at slice boundaries, verification-before-completion, and protected push/PR
workflows. No implementation task begins before that plan is approved.
