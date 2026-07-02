# Post-deploy farm-contract canary: accept masked guarded-read rejection

## INFRA-MEDIUM-038 — farm-contract canary over-specified the rejection error code → flaky-red on every farm deploy
**Severity:** MEDIUM · **Layer:** 1 (deploy gate) · **Owner:** infra-expert

### Problem
`scripts/deploy/post-deploy-verify.sh` runs a SEMANTIC farm-contract canary after every deploy: an
UNAUTHENTICATED `farms` read through nginx /graphql, expecting the guarded read to REJECT it (no
data) and the field to be composed. The acceptance required the rejection error to carry an
**unmasked** `UNAUTHENTICATED`/`FORBIDDEN` code (or an auth-worded message). But production runs
with `disableErrorMessages`, and the gateway maps a subgraph verified-user-assertion rejection to a
generic `INTERNAL_SERVER_ERROR` / "400: Bad Request". So a legitimate masked rejection
(`data:null` + masked error) was treated as a contract failure, marking the deploy unhealthy. This
made the post-deploy gate flaky-red on EVERY farm-affecting deploy (#758/#761/#763/#767/#768 all
failed post-deploy-verify) even though the deploy succeeded and the security property held. Verified
live: 6/6 anonymous `farms` probes return `data:null` (no tenant-isolation breach) with
`code=INTERNAL_SERVER_ERROR`.

### Fix (consistent with the by-design error masking)
Accept the masked rejection: the security-meaningful properties (`data.farms` empty = no breach;
field composed = no `GRAPHQL_VALIDATION_FAILED`) are still hard-required; the remaining requirement
is simply that the read was REJECTED (≥1 error present). A clean auth code is preferred (logged via
a note) but not required, because demanding an unmasked code contradicts `disableErrorMessages`.
Breach (data populated), composition failure, no-error-at-all, and non-JSON/502 all still FAIL.

### Verification
6 adversarial cases pass (masked-rejection→PASS; breach/composition/null-no-error/non-JSON→FAIL);
`bash -n` clean. (No runtime auth behaviour changed — this is a deploy-gate correctness fix.)
