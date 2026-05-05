# ADR-030: Rust Binary Supply-Chain Hardening (SLSA-3 + cosign/sigstore + SBOM)

**Status:** Proposed
**Date:** 2026-04-22
**Deciders:** platform team, security team, SRE, edge-agent team (informed)
**Related:** `sens-api-gateway/deny.toml` IEC 62443 SL2 baseline, ADR-011, Rust plan `snappy-sniffing-pine.md` Kör Nokta 9-10, EDGE-SECURITY-001 orphan finding

## Context

The Rust plan's Faz 0 CI (`rust-ci.yml`) runs `cargo fmt`, `cargo clippy`, `cargo test`, `cargo deny check`. It does **not** sign binaries, generate SBOMs, or verify provenance. Meanwhile:

- The existing edge gateway (`sens-api-gateway/`) is IEC 62443 SL2 hardened at the dependency level (`deny.toml:1-111`) but also has no artifact-signing pipeline (EDGE-SECURITY-001).
- Cloud Docker images pushed to GHCR have no cosign signatures and no SLSA provenance attestation.
- Deploy-time (`deploy-digitalocean.yml`) pulls + runs images with no verification step.
- Secret management for the Rust sidecar (DB password, NATS client cert + key) is undocumented — the plan's secret-config section is blank.

Two problems are intertwined:
1. **Artifact integrity**: a compromised GHCR push (stolen token, CI poisoning, or namespace hijack) would silently deploy a malicious binary.
2. **Secret provisioning**: without a documented source for DB creds and mTLS material, operators will improvise (baked-in defaults, unencrypted env vars) — the exact class of incident CLAUDE.md's architectural discipline is meant to prevent.

This ADR covers both: supply chain AND secrets, because they share the same trust chain (signed artifacts + the secrets they consume must land through trusted paths).

## Decision

### Part A — Supply Chain

1. **SBOM generation** every release:
   ```
   cargo install cargo-sbom --locked
   cargo sbom --output-format spdx-json > sensor-ingestion.sbom.spdx.json
   ```
   SBOM attached as a GitHub release artifact AND pushed as an OCI artifact attestation.

2. **Container SBOM + provenance** via BuildKit:
   ```
   docker buildx build \
     --sbom=true \
     --provenance=mode=max \
     --tag ghcr.io/aqua/sensor-ingestion:${SHA} \
     .
   ```

3. **Keyless signing** with cosign (GitHub OIDC, no long-lived keys):
   ```
   cosign sign --yes ghcr.io/aqua/sensor-ingestion:${SHA}
   cosign attest --yes \
     --predicate sensor-ingestion.sbom.spdx.json \
     --type spdxjson \
     ghcr.io/aqua/sensor-ingestion:${SHA}
   ```
   The OIDC issuer is `https://token.actions.githubusercontent.com`; the signing identity is the workflow + repo ref, recorded in the Rekor transparency log.

4. **Deploy-time verification**: `deploy-digitalocean.yml` gates image pull behind:
   ```
   cosign verify \
     --certificate-identity-regexp \
       'https://github\.com/Okan-wqm/aquaculture[-_]platform/.+@refs/heads/main' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     ghcr.io/aqua/sensor-ingestion:${SHA}
   ```
   Verification failure aborts the deploy.

5. **SLSA-3 target**: tooling above covers SLSA-3 (build service, hermeticity where BuildKit allows, provenance, non-falsifiable identity). SLSA-4 (hermetic build, two-party review) is not in scope for Faz 0.

### Part B — Secrets + Cert Provisioning

1. **Config provider**: `apps/sensor-ingestion/src/config.rs` uses `figment` with precedence `env > file > default`. Secrets are only read via ENV to avoid file-system disk cache; config files carry non-secret defaults.

2. **Secret sources**:
   - **DB password** — `$DATABASE_PASSWORD` env, populated via Docker Swarm secret mount `/run/secrets/db_password` (compose `secrets:` block), or Kubernetes Secret mounted into ENV. Rotation: rolling restart with secret update.
   - **NATS client cert + key** — file paths `/etc/nats/certs/sensor-ingestion.crt` and `.key` mounted read-only from Docker Swarm secret / Kubernetes Secret. Rotation: minted by `scripts/generate-internal-certs.sh`, redeploy.
   - No secrets in git. `.claude/settings.json` deny-rule continues to block `.env` commits.

3. **Runbook** `docs/runbooks/sensor-ingestion-deployment.md`:
   - Initial deploy checklist (secret creation, cert mint, compose/k8s manifest).
   - Secret rotation procedure.
   - Cert rotation coordinated with `scripts/nats/generate-nats-conf.py` regeneration.

4. **Compose-side wiring** in `docker-compose.droplet.yml` + `docker-compose.prod.yml`:
   ```yaml
   sensor-ingestion:
     secrets:
       - db_password
     volumes:
       - type: bind
         source: /etc/aqua/nats-certs/sensor-ingestion.crt
         target: /etc/nats/certs/sensor-ingestion.crt
         read_only: true
       - type: bind
         source: /etc/aqua/nats-certs/sensor-ingestion.key
         target: /etc/nats/certs/sensor-ingestion.key
         read_only: true
   secrets:
     db_password:
       external: true
   ```

## Consequences

**Positive:**
- A stolen GHCR token cannot silently deploy malicious binaries — cosign verification fails, deploy aborts.
- SBOM attestation makes security-audit traceability automatic; vulnerability scanners (Trivy, Grype) consume it.
- Keyless signing (GitHub OIDC) has no long-lived key material to steal or rotate; per-build signing identity is ephemeral.
- Secret provisioning is documented; operator improvisation risk eliminated.

**Negative:**
- CI step adds ~1-2 minutes per build (cosign + attestation + SBOM). Acceptable given the budget analysis in the Rust plan (Kör Nokta 15).
- Every deploy path — DigitalOcean + future Kubernetes — must wire in verification. One-time cost; recovered after the first blocked bad artifact.
- Secret rotation runbooks add operator burden.

**Neutral:**
- Edge gateway (`sens-api-gateway/`) is **not** covered by this ADR; EDGE-SECURITY-001 tracks its separate plan (fleet update signing, anti-rollback) because the edge runtime has different constraints (offline tanks, OTA channel).

## Alternatives Considered

1. **Long-lived cosign key stored in GitHub Secrets** — rejected. Key-rotation surface + theft risk; keyless OIDC signing supersedes this.
2. **Rely on GHCR registry signing alone** — rejected. GHCR signatures do not cover SBOM attestation and do not record in a transparency log.
3. **Skip deploy-time verification, trust the registry** — rejected. This is the exact trust chain hole that motivated cosign. Registry compromise would go undetected.
4. **HashiCorp Vault for secrets** — deferred. Vault integration is a larger platform question (how do existing NestJS services source secrets? today, env vars). This ADR matches the existing platform pattern (ENV + Docker secret) so the Rust sidecar does not introduce a new secret-management surface. A platform-wide Vault ADR would supersede this section if adopted.

## Verification

- CI workflow output: `cosign sign`, `cosign attest` steps green; Rekor entry URL printed.
- Deploy workflow output: `cosign verify` + `cosign verify-attestation` green before pull.
- Manual verification:
  ```
  cosign verify ghcr.io/aqua/sensor-ingestion:${SHA}
  cosign tree ghcr.io/aqua/sensor-ingestion:${SHA}  # shows SBOM attestation
  ```
- `docker compose -f docker-compose.droplet.yml config | yq '.services."sensor-ingestion".secrets'` shows `db_password` wired.
- Runbook dry-run: a staging deploy with an intentionally invalid signature aborts cleanly with a clear error.
