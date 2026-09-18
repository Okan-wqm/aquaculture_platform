# ARIA Current State

Date: 2026-09-18
Target ref: `origin/main`
Last verified ARIA authority hash: `20e5389eeb16d884d4c530ba0a735898e3af811c2c84198dd3f973d72244f432`
Status: post-snowball mainline hardening in progress

## Connected execution checkpoint

The integrated candidate now contains selected-commit source excerpts, event-identity regression
detection, cycle/outer failure propagation and same-plan baseline retention. These owners share the
preserved central evidence readers. The four verified merge-predicate exports are now integrated;
runtime native claim/revision binding and the corrective-planning consumer are integrated into the
same checkout. The genuine planning call is next; unfinished merge predicates do not gate this
read-only planning action. Isolated component results must not be combined into end-to-end
acceptance. A separately peer-checked installed Codex component returned `ARIA_COMPONENT_OK` in
40.03 seconds with private writable state and a read-only managed-auth file; it did not exercise the
native task/claim/result chain. Requested Astra Ultra is distinct from unavailable returned
model/effort fields.

The connected selection includes existing targeted current/legacy retention, post-restore
verification, retained-version and receiving-hot-log continuity controls. Source integration
preserves the inherited index and all R1 reader definitions; the actual six-method selection passed
with eight subtests in 136.97 seconds. The connected scope/caller selection passed seven methods;
its native Nx prerequisite initially hit sandbox Git EPERM, then the exact unchanged remaining
method passed with eight subtests in 202.49 seconds outside that sandbox. These are separate runs,
not a fabricated combined run. [Current owner entries and result-flow
edges](./ARCHITECTURE.md#connected-candidate-cycle-and-retained-evidence-consumers) distinguish
source integration, isolated test results and remaining native proof.

## Authority Chain

ARIA authority is ordered and fail-closed:

1. Executable code and machine-checked contracts are normative.
2. This file is the live human-readable state index.
3. Accepted ADRs are normative only when they do not contradict executable contracts or this file.
4. `SPEC.md`, `CONTRACTS.md`, `IDENTITY.md`, `ROADMAP.md`, and `docs/aria/plans/**` are live only in
   sections that are not marked historical, superseded, or compatibility reference.
5. Historical snowball/Claude-era docs are evidence of design history, not runtime authority.

When two sources disagree, the lower-priority source must be updated, generated from code, or
explicitly marked historical. Runtime behavior must not be inferred from stale prose.

## Current Normative Anchors

- Runtime CLI and public surface: `aria-kernel/aria_kernel/cli.py`
- Runtime profile and write authorization: `aria-kernel/aria_kernel/runtime_profile.py`
- State surface inventory: `aria-kernel/aria_kernel/state_manifest.py`
- Tools root identity and binding: `aria-kernel/aria_kernel/tool_registry.py`
- Runtime artifact graph and v2 approval: `aria-kernel/aria_kernel/runtime_artifacts.py`
- Run envelope/status owner: `aria-kernel/aria_kernel/tool_health.py`
- Strict run-ledger reader/upcaster: `aria-kernel/aria_kernel/runs_reader.py`
- Agent role/lifecycle SSoT: `aria-kernel/aria_kernel/agent_surface.py`
- Agent request/response contract: `aria-kernel/aria_kernel/agent_contract.py`
- Transactional append/index primitive: `aria-kernel/aria_kernel/ledger.py`
- Ledger row-size cap, one constant for write and read side:
  `aria-kernel/aria_kernel/ledger.py::LEDGER_ROW_MAX_BYTES`
- Inline-row byte discipline shared by ledger writers: `aria-kernel/aria_kernel/ledger_inline.py`
- Runner habitat memory budget (systemd drop-ins; `scripts/aria/provision_runner.sh` installs and
  drift-checks them): `scripts/aria/runner-habitat/systemd/`
- Merge authority: `aria-kernel/aria_kernel/merge_authority.py::merge_pr_if_ready`
- Enterprise risk policy owner: `aria-kernel/aria_kernel/risk_policy.py`
- Enterprise autonomy unlock owner: `aria-kernel/aria_kernel/autonomy_unlock.py`
- L3 policy approval owner: `aria-kernel/aria_kernel/policy_approval.py`
- Rollback bundle owner: `aria-kernel/aria_kernel/rollback_bundle.py`
- Incident ledger owner: `aria-kernel/aria_kernel/incident_ledger.py`
- Runner attestation owner: `aria-kernel/aria_kernel/runner_attestation.py`
- Capability resolution owner: `aria-kernel/aria_kernel/capability_resolver.py`
- Required PR merge check: `.github/workflows/aria-merge-authority.yml`
- Executor implementation: `tools/aria-poc/ci_executor.py`, `tools/aria-poc/worker_executor.py`, `tools/aria-poc/claude_runtime.py`
- Runtime artifact safety boundary: `aria-kernel/aria_kernel/artifact_safety.py`
- Enterprise autonomy burn-in: `aria-kernel/aria_kernel/burn_in.py`
- Observe burn-in report schema: `docs/aria/schemas/autonomy-burn-in-report.schema.json`

## Runtime

ARIA live autonomous execution is Claude Code CLI based and must use a managed Claude Code login
session on a trusted/private runner. Direct API-key / proxy-billing runtime mode is not the default
authority for this repository.

Legacy Codex executor language in older docs is historical or compatibility reference unless an
executable contract explicitly calls it. Any live doc section that treats `codex exec`,
ChatGPT-managed Codex auth, or `codex_runtime.py` as the current ARIA runtime authority is a
documentation defect.

## Execution Policy Amendment (2026-09-11)

The preceding mainline runtime description is an executable-history boundary, not proof that
the candidate is deployed. The current user-required adaptive design has these distinct routes:

| Provider  | Required transport/authentication                                                                                                              | Current proof boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI    | Actual Codex CLI with managed ChatGPT/subscription login; request Astra Ultra. No API key or direct API fallback.                              | Integrated offline profile/argv and filesystem-probe controls; effective managed authentication and native dispatch remain open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Anthropic | Actual Claude Code CLI with managed subscription login. No Console/API-key/cloud or direct API fallback.                                       | Natively admitted since 2026-09-11 on `claude auth status --json` (claude.ai = subscription; API-key/console logins refused by name) and executed through the existing containment spawn with attempt/finished evidence (`_invoke_native_claude`, `test_ci_executor_native_claude`).                                                                                                                                                                                                                                                                                                                         |
| Z.ai      | Separate API transport with its own scoped credential and explicit product/endpoint/model identity. Never redirect either managed CLI to Z.ai. | `tools/aria-poc/zai_runtime.py` (OpenAI-compatible chat completions over `urllib`) is wired into fleet availability, native admission (`observe_status` probe), native execution (`_invoke_native_zai`) and the legacy ladder (`_run_zai_as_claude_result`); proven end to end against a local stand-in vendor (`test_ci_executor_native_zai`). Live on 2026-09-11: Coding-Plan probe HTTP 200 (general route 429/1113 — wallet, not plan); the first ACCEPTED native planner result in ARIA ran on this route (trial six, `AIR-aria-challenger-planner-b82f89291809`, glm-5.3, state `CHALLENGER_DRAFTED`). |

The user's Z.ai credential has not been provisioned to the reviewed runtime. Its boundary is
`ARIA_ZAI_API_KEY_FILE`: an absolute path to a regular file readable by its owner only
(mode `0600`; any group/world bit is refused by name), holding exactly one line — or, for
CI-secret injection only, `ARIA_ZAI_API_KEY`; both at once is refused as ambiguous
(`zai_runtime.read_zai_credential`). The value is held in a `ZaiCredential` whose repr,
str and equality never expose it, is used only to build one `Authorization: Bearer` header,
and is never placed in `os.environ`, argv, a ledger row, a governance event, an exception
message or a transcript; `agent_env.SECRET_SHAPED_ENV_NAME` drops both variable names from
every agent child. The former `claude_runtime.provider_redirect_env` route — the `claude`
binary with `ANTHROPIC_BASE_URL` pointed at Z.ai — is deleted, and `run_claude_exec` refuses
a non-Anthropic model by name (`model_not_served_by_claude_runtime`). No credential value,
digest or fragment belongs in source, command arguments, evidence or documentation.

The Z.ai general API and Coding Plan endpoints are distinct and both are named in
`zai_runtime.ZAI_ENDPOINTS` (`coding` → `/api/coding/paas/v4`, the subscription quota;
`general` → `/api/paas/v4`, the prepaid wallet); the vendor's GLM-5.3 page states that
Coding-Plan subscribers reach the model API only through the OpenAI-compatible protocol, so
`coding` is the default and `ARIA_ZAI_ENDPOINT` selects otherwise (a documented name, or an
explicit base URL recorded as `custom`). Entitlement is never inferred from key shape or
silently substituted: `probe_zai_status` makes one `max_tokens=1` completion against the
selected endpoint and records the HTTP status, the vendor's error code and message, and the
(auth, quota) classification as the candidate observation the fleet admission reads. Published
API rates do not establish subscription billing for either CLI.
Zero actually admitted providers must preserve pending work; one uses independent reviewer
sessions on that one model; multiple available providers should be mixed honestly. These are
accepted implementation requirements, not completed native selection/recovery evidence.
Supervising engineering agents use the user's selected Astra xhigh; ARIA's Codex dispatch
continues to request Astra Ultra. The current subscription policy does not make nominal
dollar estimates a hard admission condition for the admitted subscription routes. Unknown
cost or usage remains unknown. Authentication, observed quota/rate limits, bounded retries,
timeouts, context/output limits and task/effect ownership still apply. Runtime implementation
and real-provider acceptance of this policy remain in the active execution lane. The existing
later value-evaluation backlog includes value of accepted work produced per token; no new
metric is implemented by this change.

Dated host observation at 2026-09-11 07:15:15 UTC: the gateway unit was loaded but inactive,
with no TCP listener on 8787; the telemetry timer was active/waiting while its oneshot was
inactive. Running application containers used `9b44390…` images, not this candidate. This
supervising-assistant observation is recorded under SHA256
`8bc63e68f25b782e965ca992d3b005e8f6e2936aaa1d50abcd0911e999c4f7b6`.
Timer liveness does not establish gateway routing or candidate deployment. No activation
follows from this record.

## Selected Source And Planning Evidence

The isolated flow candidate connects committed source bytes to the existing native mint
owner through `aria-kernel/aria_kernel/snapshot.py`, `evidence_excerpts.py` and
`agent_invocations.py`. Three methods plus two subtests passed in 23.42 seconds; thirteen
existing excerpt, discovery and literal v1–v4 replay methods passed separately in 18.76 seconds
on source `f04f073f84d1e2772ad00a1fc8bff4ebee761084eb2ad98efd6ad4398b5b9a65`.
The actual 97-signature observation preserves all public names and ordered exports, with only
a private helper's optional argument added. [The architecture entries](./ARCHITECTURE.md#flow-aware-planning-selected-source-milestone)
record source hashes, callers, data ownership, freshness limits and independent review scope.

Existing mint-time qualification marks stale named pilot observations unknown and preserves
historical sealed evidence. A genuine planner result that selects justified edits/tests,
dispatch against the correct task revision, and a later decision using validated outcome
memory remain unproven. Source/context packaging is not model behavior or learning evidence.

The connected candidate now includes the existing same-plan comparison consumer in plan
evaluation, the round controller and convergence drainer. Isolated verification passed seven
methods with two subtests in 212.27 seconds and five unchanged compatibility methods separately
in 72.99 seconds. The native observation and baseline hashes reach the existing bounded
corrective request; historical evidence and terminal state protections remain intact. A fixture
source restoration followed by a clean comparison does not establish native change validation
or model-authored repair. Connected execution and that validation link remain required.

The separate runtime component produced a genuine contained managed-Codex response in
40.0283 seconds. This is provider/component evidence, not a connected planner or worker result.
Native claim/admission/result integration is still in progress. Four pre-merge predicates have
isolated native consumer coverage; operator authority, cycle/turn budget and expert consensus
remain fail-closed. The current subscription policy must apply at every downstream budget
consumer without replacing unknown usage with zero.

## State And Lifecycle

`state_manifest.py` is the inventory for write-driving ledgers, runtime state, indexes, locks, and
artifacts. Runtime writes that can drive future behavior must be declared there before they are
trusted by autonomy.

`runtime_profile.py` is the single write-authorization boundary for profile-aware surfaces. The live
profile taxonomy is `observe`, `standard`, `strict`, `frozen`, and `autonomous`.

`runtime_artifacts.py` owns artifact graph verification. Promotion evidence must be
artifact-bearing, hash-bound, path-contained, indexed, and connected to the relevant cycle/run
ledgers. Lifecycle-only cycles do not authorize promotion.

`ARIA Operational Proof` is the GitHub Actions proof lane for isolated temp-tools runtime
verification and strict/mock autonomy smoke. It must not write repo-local ARIA runtime state.

`agent_surface.py` owns request roles, invocation roles, dispatchable roles, bridge-required roles,
target-agent whitelist, role-target pairing, and derived request lifecycle labels. Callers must
consume that SSoT rather than maintaining local role sets.

`autonomy burn-in observe` is the first enterprise autonomy acceptance slice. It runs discovery,
memory, pressure, and triage for exactly 30 observe attempts with at least 20 valid cycles, and
fails if agent claims, tool runs, PR lifecycle, runtime promotions, or agent/skill materializations
are observed. It is not a full autonomous merge proof.

## Memory Reporting Increment (2026-09-10)

The local memory reporting path connects outer orchestrator `memory_hook` / `memory_completion`
results to `runtime_artifacts.autonomy_output_summary`, post-drain reflection and the stored daily
report. The existing local anchor publisher consumes that report body. Initial pending state,
individual completion errors, persisted receipts and replay receipts remain distinct and bounded;
the final CLI budget includes the artifact reference and newline. The exact contract and ordinary
test owners are in `CONTRACTS.md` §12.6.

This increment does not establish live monitoring or measured learning gain. The separate
`pr_ci_scan` / implementation-reconciliation summary path remains an open reporting obligation
owned by the cycle, bounded-summary and publisher consumers. Full signer compatibility, outcome
assessment/retention, revision-bound self-knowledge and end-to-end runtime
acceptance remain separate implementation-plan slices. Source presence does not establish deployed
or running status.

## Rejected-Submission Context Increment (2026-09-10)

The local invocation consumer now joins native rejected results to their original claims and
canonical requests in one verified tools-root snapshot. Fresh version 4 prompts capture related
episodes, explicit missing/unavailable history, provenance and display omissions. Later history
does not rewrite sealed requests; complete literal v1-v3 prompt bytes remain preserved. Production
and ordinary test owners are in `CONTRACTS.md` §12.7.

Recorded convention status is labelled without asserting revalidated merge lineage or measured
gain. This increment supplies the bounded rejected-history prompt connection, not
the broader outcome, retention, self-knowledge or runtime obligations. Full history scan cost,
archive-resolvable evidence and comparative usefulness still require their planned acceptance.

## Committed Snapshot Increment (2026-09-10)

The shared snapshot owner now selects committed membership, blob bytes and the reported revision
from one captured commit. Ordinary staged additions/deletions and a later HEAD change do not
replace that view. Missing commit/tree reads are visible, and unavailable committed blobs remain
unknown rather than using working bytes. Missing/non-file working inputs also remain unknown,
so an unstaged deletion cannot make discovery report complete input. Real discovery preserves these
snapshot/fates/completion facts in both returned data and its existing artifacts; `CONTRACTS.md`
§12.8 names the test owners.

This is the shared prerequisite for later assessment and self-feature freshness work. Working/no-Git
observations, live fingerprint/service-map reads, working-mode filename parsing and sequential
artifact publication retain their separate meanings; complete discovery immutability, deployed
capability status and measured learning utility are not established by this increment.

## Scoped Validation Input Increment (2026-09-10)

`aria-kernel/aria_kernel/validation.py::run_validation_commands` optionally observes explicit source/test/config/dependency
files before and after each executed command. The existing validation-run owner stores bounded v1
metadata and an owner-derived declared log reference; omitted inputs preserve historical behavior.
Known file/argv manifests, native results and the current verifier are the evidence chain described
in `CONTRACTS.md` §12.9. Batch HEAD admission and observed scoped stability retain distinct meanings.

Full snapshot IDs, installed dependency closure and runner environment remain unknown when not
observed. The bounded ENV increment below does not complete environment applicability. Portable
retained proof, outcome/reinstatement and S3 behavioral qualification
remain required before stronger current-demonstration claims. No live activation or measured
memory utility follows from this local provenance connection.

## Scoped Self-Feature Context Increment (2026-09-11)

`aria-kernel/aria_kernel/twin.py` now derives two named self-feature observations from the
selected discovery bytes: convention lookup and memory-result reporting. Scoped re-observation at
mint distinguishes changed source/test/config/dependency files and membership from current local
inputs. Static caller reachability, inferred test associations and source definitions remain
separate from configured, demonstrated and running status; those latter dimensions remain unknown.
This is a two-feature partial inventory, not a live registry of every ARIA capability.

The real outer orchestrator/drainer, legal later planner branches and `plan advance-rounds` carry
the explicit source root and hash-matched current body into native request context. Literal affected
paths are retrieval hints, separate from evidence and write scope. New version 5 prompts preserve
that observation and any omission status; issued v1-v4 bytes remain sealed. Full rendered-input
budgeting, replay and native audit linkage are described with ordinary test owners in
`CONTRACTS.md` §12.10.

Full discovery/history maintenance is separate from bounded mint reads. Canonical identity,
effective configuration, installed/loaded dependencies and actual runner evidence are not inferred
from a matching source hash. S2 assessment/retention, remaining S2-E-ENV applicability,
S3 Card 4 demonstration, S4 runtime/model propagation and S5 measured utility/teaching remain
required. The local source/planner candidate does not establish whole-system or final S3 acceptance.

## Partial Child Environment Observation (2026-09-11)

`aria-kernel/aria_kernel/validation.py::run_validation_commands` accepts an opt-in v2 scope for
explicit named unittest execution; v1 and omitted scopes keep their existing execution path.
The private child observes its own interpreter, five public environment values and at most eight
already-loaded named modules after the test. One bounded pipe receipt joins the existing native
run and hash-bound log. `aria-kernel/aria_kernel/experiment.py::run_experiment` forwards an explicit
scope or selects one from an opted-in recipe; its record-only outcome and call shape remain unchanged.

`CONTRACTS.md` §12.11 specifies shared read limits, active observation-time accounting, ordinary I/O
fallback and unknowns. Post-run source/cache hashes do not establish executed code bytes.
Control-profile observation remains unknown; action/profile and scheduler-ceiling owners are
unchanged. The recipe-to-stage/night connection is described below. Applicable
loaded-content/native-state proof, portable retained logs, S2 assessment/reinstatement, S3 Card 4,
runtime integration and measured utility remain open.

## Recipe Inputs in Normal Validation Callers (2026-09-11)

`aria-kernel/aria_kernel/experiment.py::register_recipe` can retain an optional canonical input
descriptor. Stage command resolution selects its contributing recipe rows once, forwards their
bounded union to baseline validation and stores it on the existing apply action. Candidate
validation reuses that selection after later recipe changes. The bench selects an opted-in recipe
when its scope argument is omitted/None, connecting both default night branches; an explicit scope
retains precedence. Legacy recipes, canonical commands, timeouts and injected runner contracts stay
unchanged. `CONTRACTS.md` §12.12 specifies exact source references, deterministic ordering, limits
and compact unknown results.

Local functional evidence includes actual offline Nx test/lint, TypeScript and named unittest
execution, a candidate after normal recipe re-registration, and native night problem/fix/regression
lineage. Selection status describes metadata selection, not full input applicability or measured
improvement. The bounded engineering copies of native rows/logs are review artifacts, not the
runtime retention mechanism. Retention, durable assessment, applicable loaded-code/native-state
proof, S3 Card 4, runtime/model propagation and measured learning utility remain required.

## Explicit Recipe Manifest Provisioning (2026-09-11)

`tools/aria-poc/seed_experiment_recipes.py::main` accepts an explicitly supplied optional
recipe `input_scope` and forwards it through the native recipe writer to existing automatic
bench selection. `tools/aria-poc/seed_experiment_recipes.py::seed` also preflights all non-null
descriptors for direct callers before either append loop, using the shared private experiment
validator and existing metadata cap. Missing/null retains legacy behavior; a later null reseed
turns opt-in off without rewriting earlier proof. `CONTRACTS.md` §12.13 defines this boundary
and its separate-append limits.

Local fixtures exercise real named unittest behavior through alternate-manifest provisioning,
native run/log verification and reseed continuity. Autonomous author reuse is declaration/planner
wiring only: its existing finding/service inputs do not justify inferred full scope. The default
manifest and production author remain unchanged, and no scheduled seeder call is established by
this increment. Retention, applicable loaded-code/native-state evidence, assessment, S3 behavioral
qualification, runtime integration and measured learning utility remain open.

## Retained Runtime References (R1, 2026-09-11)

`aria-kernel/aria_kernel/runtime_artifacts.py::resolve_artifact_payload` and the native runtime
verifier now retrieve exact retained versions after normal index/hot compaction. Authorized
restore retains the original source ledgers and native artifact index, and appends its existing
retention event; normal binding may refresh derived integrity metadata.
A later native publication at the same URI does not invalidate an archived full reference;
string-only restore remains ambiguous across versions. Native creation/retention/manifest
owners provide the identity joins, and existing snapshot ownership attests archive leaves.
The detailed bounds and legacy bridge are in `runtime-artifact-contract.md` under R1.
The supervising assistant independently accepted the same 10 methods and 9 passing subtests
in 84.73 seconds at full input `f150f61a4549b8091246ebeb40256eb7b6e3cc5ec07362e28de270e745fb994a`;
the API94 capture was byte-identical. The worker's identical selection is overlapping evidence,
not another 10 distinct cases. Acceptance receipt SHA256:
`6b008315ea73f2cfed8d0b4434d5d2c69f512ecb16fba30377cbc37512bae6bd`.

Focused current and genuine legacy fixtures exercise local retrieval, restore verification,
version continuity and large public hot reads. They are native state fixtures, not tool/model
execution or live activation. The bounded R2 receiving-hot-log increment is described below.
R3/R4 reference/prefix closure and
concurrent eviction, durable assessment/serving, behavioral applicability and measured utility
remain open. The integrated S4 offline profile/probe tests and farm producer/consumer test are
separate evidence: they do not establish adaptive provider admission or live service delivery.

## Hot Outcome Assessment Integration (S2-A, 2026-09-11)

`aria-kernel/aria_kernel/change_outcome.py` now separates immutable first outcomes from later
assessment rows in the existing outcome ledger. Its private capture uses verified native hot
prefixes, original merge/family/planned scope, and an explicit event-time cutoff; computation
uses captured data and the existing metric arithmetic. Exact retries return the original
assessment without another append or pressure-counter update. Host/Git authority checks run
before evidence transactions, with the same verified binding bytes rechecked inside.

The exact two-file reviewed export is integrated with original index/staged/HEAD preserved.
The [two addressable source/test entries](./catalogue-change-outcome.md) record full manual
reading, caller/dependency/state edges and 21 distinct controls from separately attributed
worker and supervising-assistant runs. The central exact 21-method run passed in 136.04 seconds
on source `960b57c74487d2dacc46ee57063748b7c913d6cf77ff7d67f122f450d7a0bd39`, with the
API76 and documentation checks independently reviewed. That run repeats the isolated selections;
it adds no distinct coverage. The cycle still calls only the
first-outcome evaluator. Private later assessment functions have test callers only: cold prefix
durability, fair runtime scheduling, effective serving/retraction, corrective lineage and
measured learning utility remain open. `retained_prefix_ref` remains null and durability
unavailable. No new memory store or live learning claim is supplied by this integration.

## Receiving-Hot Validation Log Continuity (R2, 2026-09-11)

The accepted two-file export now connects the native validation verifier to its existing
root-relative log reference after local state publication and receiving-root binding.
Original native rows, absolute historical paths, log hashes, signatures and legacy external-log
behavior are preserved. The exact source/test catalogue records the actual producer, shared
matrix/merge reader seam, normal snapshot/teardown/binding fixture and fresh-child origins.

Isolated verification passed two methods plus two subtests in 22.93 seconds, then six disjoint
compatibility methods in 21.12 seconds. These are eight distinct methods across two runs.
API94 preserved all observations except the explicitly recorded default manifest checkout path;
raw captures are not byte-identical across that relocation. Parent receipt is
`c87c3032db30f126a5b0035c3adeac2a1db1231ea43aa2d8079e1203843f1147`.
Central verification passed the same eight methods plus two subtests in 36.31 seconds on
`0b26d47c0161f36c016cfb441620997460c5006d219b166434872de34a7d77b2`. Its actual same-root
API94 capture is byte-identical to the accepted central capture (`441c7c90…`), with no
manifest-path adjustment. Four selected documentation checks, pin and diff checks also passed;
the preserved sandbox pin-check failure was retried without repeating the passing tests.
The final documentation-only evidence update retains those code/test inputs.
R3 cold validation-log/prefix closure, simultaneous
writer/eviction coordination, actual merge/learning consumers and whole-system usefulness remain
open. This fixture publishes only to its disposable local Git remote.

## Clean Trial Rule

A clean ARIA trial must run from an isolated worktree at the declared target commit. Existing
detached or dirty operator worktrees are not validation surfaces. Every runtime command in a trial
must receive an explicit bound `--tools-dir` and `--workspace-root`; repo-local shadow roots such as
`aria-kernel/aria-tools/` are invalid.

## Documentation State

An owned source change must refresh its addressable source-catalogue entry in the same work
item: behavior, callers/callees, state, contracts, tests, demonstrated evidence and exact source
digest. Changed edges or semantics also require the affected architecture/pipeline diagrams
and cross-file contracts to be updated. A different reviewer checks those meanings; refreshing
the authority hash does not establish semantic review. Partial reading remains labelled partial,
and later source changes invalidate the affected entries again. Existing architecture/pipeline
documents retain ownership, including generated JUDGE-DIGEST markers. Complete catalogue
coverage and a native manifest-to-entry freshness check remain tracked documentation work;
neither is claimed merely by an updated pin.

The ARIA docs set contains historical material. Sections still saying only the PoC exists, the
kernel does not exist, live runtime is Claude/Anthropic, or auto-merge is categorically impossible
are superseded unless explicitly restated by this file and the executable contracts above.

For the bilingual architecture explainer with diagrams, see `docs/aria/ARCHITECTURE.md`. That
document is explanatory only: it must defer to this file, executable contracts, and machine-checked
invariants whenever there is a conflict.

For the enterprise autonomy SSoT and burn-in acceptance matrix, see `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`.

On 2026-06-20, `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md` records the accepted
production-autonomy target decisions: full production autonomy, whole-repo
risk-gating, L3 two-stage human policy approval before ARIA merge execution,
rollback bundle plus incident ledger, L2 unlock after 30 supervised successes,
hybrid GitHub Actions plus private-runner runtime, hybrid GitHub App plus
`GITHUB_TOKEN` token model, kernel plus required-check plus CODEOWNERS merge
authority, and hybrid ledger/state authority. This record is not live merge
permission; live authority still requires the machine-readable policy files,
schemas, executable owners, required GitHub check, CODEOWNERS ownership,
state-manifest declarations, and invariants listed in that SSoT.
