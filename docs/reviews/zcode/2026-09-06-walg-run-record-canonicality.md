# WAL-G run records are accepted as bytes, not as parses — 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `f4b1c50c1`.

Re-derived from `fix/production-host-control-plane`. That branch cannot be merged: it is 972
commits behind main and `git merge-tree` conflicts in 45 files, six of them production deploy
workflows, plus billing and sensor specs and an unrelated `billing-scheduler.service.ts` rewrite.
Its WAL-G evidence work is nevertheless a strict superset of main's — main's invariant cases are
all present on the branch, which adds eleven more — so it is being ported slice by slice. This is
the first slice, chosen because it touches only the attestation tool and its invariant, not the
deploy workflows the conflicts live in.

## INFRA-HIGH-161 — the signer trusted anything that parsed

**Severity:** HIGH. **Owner:** infra-expert. **State:** IN-PROGRESS.

**Evidence.** `tools/scripts/database/walg-evidence-attestation.mjs` read the run record — the
input the OIDC/Rekor signature is minted over — through `readJson`, which proves only that the
file is valid JSON containing an object. `validateWorkflowRecord` then checked the value of every
field it knows about and said nothing about the fields it does not.

Three records pass that bar and should not:

- `{...record, "unsigned_payload": "…"}` — an appended field the validator never reads. It is
  inside the signed bytes, and any consumer that does read it sees content nobody validated.
- The same fields pretty-printed. Different bytes, same parse; the signature covers bytes.
- A duplicated key — `…,"mode":"full_backup","mode":"wal_archive"}`. `JSON.parse` keeps the last
  occurrence, so a reader that scans the text and a reader that parses it disagree about which
  mode was signed.

Main already writes these records canonically: `writeExclusive` emits exactly
`JSON.stringify(value) + '\n'`. The strictness was missing only on the read side, which is the
side an attacker who can write the file controls.

Separately, the signing job had no way to reject a substituted record without a GitHub API round
trip, even though it already holds the authoritative run context in its own environment.

**Rule violated.** A record this tool signs is accepted only as the exact bytes this tool writes,
against a closed schema, and only after it is bound to the live run context.

**Fix.** `readCanonicalJson` re-serialises the parsed value and compares bytes, which rejects all
three tampering classes at once plus a BOM or a missing or doubled trailing newline; it is applied
to the run-record reads in `verify-run` and `extract-evidence` and deliberately NOT to the GitHub
API responses, which are not ours to canonicalise. `requireExactKeys` closes the run-record schema
(top level and the nested `workflow` object) against both unexpected and missing fields.
`verify-local-run` binds a record to the live signer context — workflow file and name, repository,
ref, SHA, run id, attempt, event, result and mode — before any network call.

**Closure criterion.** Verified in both directions. Against main's script the two new invariant
cases fail; against the fixed script all five pass, the three pre-existing cases included, so the
added strictness did not narrow what legitimate records are accepted. The accepted baseline is
asserted inside the tampering case itself, so a fixture that stopped being valid could not make
the rejections vacuous.

**Not in this slice.** The branch's raw-artifact digest binding, evidence lifecycle validation and
mirror publication separation depend on `backup-production.yml`, which is one of the conflicting
files; they land with the workflow-wiring slice.
