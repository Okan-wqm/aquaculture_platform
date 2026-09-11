# Codex runtime prerequisite publication review

## ARIA-MEDIUM-062

The explicit Codex profile could not pass the existing closed model/effort
validator, and the standalone adapter had no explicit effort argument. The
configured-provider probe also looked in HOME instead of HOME/.codex and
replaced an explicitly empty PATH with ambient PATH. Those two probe causes
were independently reproduced: three failing methods, with the third exercising
the same missing-Codex cause through the real mixed-assignment consumer.

The change preserves the existing owners: optional runtime in the kernel profile
and its resolver; optional effort in the three existing Codex adapter calls;
an exact Astra provider alias; and corrected home/PATH lookup. Omitted runtime
and effort retain existing behavior. No shipped profile, credential, budget,
cap, write grant or role assignment is changed.

### Source and provenance

Initial verification base: `fea5890da74f6a8b253c06af765a77c3b5b958e7`.
Publication base: `53d3e82d4b500cabc034fe5874df066f2e1af24d`. The upstream
change updates registry/debt closure records; all six before-file blobs remain
identical. The finding was allocated against the updated canonical registry
through its existing writer; the earlier uncommitted allocation is preserved
in external evidence and is not published. The publication branch applies only accepted exports
`98764ee5570b11883f9add4f64a684b22a4d576ebb8ad48f83794edf69a56040`
then `2a6a12df10ae297280eb28613084f09b4feaf787052c41363ab37b433cb6c1be`.
The inherited ten-file memory patch and central staged work are excluded.
The [six addressable source entries](../../aria/catalogue-codex-runtime.md)
record full digests, callers, data/state, tests and reading limits.

### Validation and independent review

The author and distinct Astra Ultra reviewer inspected actual changed source,
reached assertions and raw results. The supervising assistant independently
executed the original offline twelve and probe seven selections. They overlap
once: eighteen distinct methods, not nineteen. These historical runs used the
accepted dirty engineering baseline.

The clean publication worktree independently collected exactly the same eighteen
IDs and passed all eighteen plus seven subtests in 0.72 seconds, exit zero.
Before/after input identity was
`7fecacc2edb134e12af29beb644b2a2c09e767d9d967973f195679fe9feecd1b`.
Raw output SHA256 and exact commands are preserved in the external publication
evidence directory `/tmp/codex-aria-delivery-20260911-v71xqq39`.

An actual cold API capture before and after the source change preserved all
964 root names and 1,576 ordered exports at this clean HEAD. All 94 observed
signatures retain old callability; exactly two trailing runtime defaults and
three optional effort arguments are added. The larger dirty engineering
baseline's 966/1,579 counts are a different source context, not this PR's API.
Repository hooks and GitHub Actions have separate outcomes in the PR; neither
is inferred green from this local selection.

### Limits and remaining owned work

The launch tests use the real adapter with a simulated subprocess collaborator.
Filesystem marker probes do not authenticate a provider. Requested model fields
are not provider-observed model/effort. Native CI/worker route selection, managed
Codex/Claude auth enforcement, Z.ai's distinct API transport, quota/failover,
usage accounting and autonomous merge remain in the root-owned S4 execution
plan. This bounded finding closes only the offline prerequisite described above.
No live model, service activation or autonomous merge is part of this PR.

### Normal hook naming correction

The first commit attempt was rejected by the existing phrase gate. Three local
fixture identifiers were renamed without changing any assertion, callback or
`tempfile` behavior; two catalogue descriptions use different wording. The
four production files still equal the accepted exports. Exact AST comparison
after undoing only the identifier rename proves the test structure unchanged.
The same eighteen methods passed with seven subtests in 0.68 seconds after this
correction, source identity `6a6a4ba148aae50f8f0828e1927fc321445412095562665ad56c4eebf920554d`.
The original hook failure, original exports and corrected raw results are kept.
No hook exemption or bypass was introduced.
