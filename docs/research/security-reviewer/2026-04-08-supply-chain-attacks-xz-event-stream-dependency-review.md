# Research: Supply Chain Attacks — xz, event-stream, ua-parser-js, Dependency Review, SBOM, Sigstore

**Topic:** Recent supply chain incidents (xz utils, event-stream, ua-parser-js, node-ipc), npm dependency review, SHA-pinning, `npm ci --ignore-scripts`, SBOM generation, Sigstore
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP Top 10 — A06:2021 Vulnerable and Outdated Components](https://owasp.org/Top10/A06_2021-Vulnerable_and_Outdated_Components/)
- [OWASP Top 10 — A08:2021 Software and Data Integrity Failures](https://owasp.org/Top10/A08_2021-Software_and_Data_Integrity_Failures/)
- [NIST SP 800-218 — SSDF (Secure Software Development Framework)](https://csrc.nist.gov/pubs/sp/800/218/final)
- [NIST SP 800-204D — Strategies for Software Supply Chain Security](https://csrc.nist.gov/pubs/sp/800/204/d/final)
- [CISA — Securing the Software Supply Chain](https://www.cisa.gov/resources-tools/resources/securing-software-supply-chain-recommended-practices-developers)
- [Executive Order 14028 — Improving the Nation's Cybersecurity](https://www.whitehouse.gov/briefing-room/presidential-actions/2021/05/12/executive-order-on-improving-the-nations-cybersecurity/)
- [SLSA Framework v1.0](https://slsa.dev/spec/v1.0/)
- [Sigstore — Cosign / Rekor / Fulcio](https://www.sigstore.dev/)
- [in-toto Attestations](https://in-toto.io/)
- [CycloneDX SBOM Specification](https://cyclonedx.org/)
- [SPDX SBOM Specification](https://spdx.dev/)
- [GitHub — About Dependency Review](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review)
- [Sonatype State of the Software Supply Chain Report](https://www.sonatype.com/state-of-the-software-supply-chain/introduction)
- [The xz Backdoor — Andres Freund's discovery (CVE-2024-3094)](https://www.openwall.com/lists/oss-security/2024/03/29/4)
- [event-stream incident (2018)](https://github.com/dominictarr/event-stream/issues/116)
- [ua-parser-js compromise (2021)](https://github.com/faisalman/ua-parser-js/issues/536)
- [node-ipc protestware incident (2022)](https://snyk.io/blog/peacenotwar-malicious-npm-node-ipc-package-vulnerability/)
- [GitHub Security Lab — Supply Chain Attack Research](https://securitylab.github.com/)
- [Microsoft Security Response Center — Supply Chain Threats](https://msrc.microsoft.com/blog/categories/supply-chain/)

## Key Findings

### 1. xz utils (CVE-2024-3094) — the patient-attacker model is now mainstream
The xz backdoor (March 2024) was inserted by a contributor who spent **two years** building trust as a co-maintainer of a niche but ubiquitous dependency. The malicious code:
- Was hidden in test fixtures (binary blobs marked as "test data").
- Activated only on specific architectures during the build (x86_64 Linux with specific glibc versions).
- Hooked sshd via a poisoned liblzma loaded indirectly through libsystemd.
- Was discovered by accident — Andres Freund noticed sshd login was 500ms slower than usual.

Lessons:
- **Maintainer trust does not survive social engineering at scale.** A single trusted maintainer is a single point of failure. Multi-maintainer review of every commit is the only structural defense.
- **Build-time code is execution.** Test data, build scripts, and configure scripts run with full developer/CI permissions and must be reviewed with the same rigor as runtime code.
- **Behavioral baselines matter.** Andres caught xz because of a 500ms regression. Production systems need behavioral monitoring (CPU, network, file access) at the binary level — not just APM at the application level.
- **Distribution discipline:** the malicious xz never made it into Debian stable. Rolling releases (Arch, Fedora) shipped it. For aqua-saas: prefer LTS distros for production base images, lock to known-good versions.

### 2. event-stream (2018) — the dependency-of-a-dependency attack
event-stream was a popular Node package with millions of downloads. The original maintainer handed it over to a stranger who then added a malicious dependency (`flatmap-stream`) which targeted a specific cryptocurrency wallet (Copay) at runtime. The attack:
- Was deeply nested — most consumers had no idea they pulled in event-stream.
- Targeted only one downstream application via UA-string sniffing.
- Was detected by chance because of an unrelated deprecation warning.

Lessons:
- **Transitive dependency review is mandatory.** `npm ls` or `cargo tree` shows what you actually pull in. A SaaS reviewer must demand a tree analysis on every PR that touches `package.json` / `Cargo.toml`.
- **Maintainer changes are a CRITICAL signal.** A package whose maintainership recently changed deserves immediate audit. Tools like `npm-audit-resolver` and `socket.dev` flag maintainer changes.
- **Conditional payloads survive automated review.** Static analyzers fail when malicious code activates only under runtime conditions. Behavioral analysis (sandbox the install, sandbox the build) is the only structural defense.

### 3. ua-parser-js (2021), node-ipc (2022), and 2023's chain of incidents
- **ua-parser-js (Oct 2021):** maintainer's npm credentials were stolen; attacker published malicious versions with crypto miners and Windows credential stealers. Discovered within 4 hours but installed in CI pipelines worldwide.
- **node-ipc (March 2022):** maintainer added "protestware" that wiped files on systems with Russian/Belarusian IPs. Not a credential breach — the maintainer themselves became the threat.
- **colors / faker (Jan 2022):** maintainer self-sabotaged in protest, breaking thousands of CI pipelines.
- **2023 wave:** typosquatting (`reactnativte`, `axioss`), dependency confusion (private package names registered on public npm), starjacking (forking popular repos and renaming).

Lessons:
- **`npm ci --ignore-scripts` is non-negotiable in CI.** Arbitrary install scripts are an arbitrary code execution surface.
- **Lockfile discipline:** `package-lock.json` MUST be committed and CI MUST fail on lockfile mismatch.
- **MFA on package registry accounts.** npm 2FA is the bare minimum.
- **Pinning to specific versions** (no `^` or `~`) for production dependencies, with Renovate / Dependabot driving updates through review.
- **Private package namespaces** to defeat dependency confusion (e.g., `@aqua/some-internal-pkg`, never just `some-internal-pkg`).

### 4. SLSA v1.0 — the build provenance ladder
SLSA defines four levels of build integrity:
- **Level 1:** Build process is documented and produces provenance metadata.
- **Level 2:** Build runs on a hosted build platform that generates signed provenance.
- **Level 3:** Build platform is hardened against tampering, provenance is non-forgeable.
- **Level 4 (deprecated, now part of L3):** Two-person review, hermetic builds.

For aqua-saas: SLSA L2 is achievable today with GitHub Actions (`actions/attest-build-provenance`). SLSA L3 requires a hardened builder (e.g., Buildkite hosted runners with attestation, or self-hosted GitHub runners with isolation).

### 5. SBOM generation is now table stakes
Executive Order 14028 mandates SBOMs for federal software. Even outside federal compliance, SBOMs are the only way to answer "are we affected by CVE-X?" in minutes instead of hours.
- **CycloneDX** (preferred for security): JSON schema, supports VEX (Vulnerability Exploitability eXchange) annotations.
- **SPDX** (preferred for license compliance): ISO standard, broader tooling.
- Generate from the package manager: `cyclonedx-npm`, `cdxgen`, `syft` (cross-language).
- Store SBOMs alongside the build artifact, not in a wiki. Sign with Sigstore Cosign.
- Re-generate per build, not per release — dependencies drift between builds.

### 6. Sigstore — keyless signing for CI/CD
Sigstore replaces long-lived signing keys with ephemeral certificates issued by Fulcio against an OIDC identity (e.g., GitHub Actions OIDC token). Workflow:
1. CI workflow has an OIDC identity (`id-token: write`).
2. Cosign requests a short-lived cert from Fulcio bound to that identity.
3. Cosign signs the artifact (Docker image, npm tarball, SBOM).
4. Signature + cert + log entry are written to Rekor (transparency log).
5. Verifiers check the signature against the expected OIDC subject (e.g., `repo:Okan-Wqm/aqua-saas:ref:refs/heads/main`).

Effects:
- No key management (no leaked signing keys).
- Bound to the build context — a signature claiming to be from `main` was made by a workflow on `main`.
- Tamper-evident via Rekor transparency log.

For aqua-saas: every Docker image and every npm package built in CI MUST be Cosign-signed and verified at deploy time.

### 7. GitHub Actions SHA-pinning is the floor, not the ceiling
`uses: actions/checkout@v4` is a tag, and tags can be moved. An attacker who gains write access to the action repo can move `v4` to a malicious commit, and every CI pipeline using the tag pulls the malicious code.

Required: pin to a full commit SHA: `uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11`.
- Renovate can manage SHA pins (`# v4.1.1` comment for human readability).
- Dependabot's "actions" ecosystem also handles this.
- For third-party actions (not from `actions/`, `github/`, `docker/`), SHA-pinning is non-negotiable — these are the highest-risk supply chain surface in CI.

### 8. Dependency review action — last-mile gate
GitHub's `actions/dependency-review-action` runs on every PR and:
- Compares the dependency tree before/after the PR.
- Flags new dependencies with known vulnerabilities (GHSA database).
- Flags license violations.
- Blocks the PR on configurable severity threshold.

Configuration:
```yaml
- uses: actions/dependency-review-action@<sha>
  with:
    fail-on-severity: high
    deny-licenses: GPL-3.0, AGPL-3.0
    comment-summary-in-pr: true
```

This is the difference between "we'll catch it in the next monthly audit" and "the PR can't merge today."

## Security Concerns

- **No SBOM generation in CI = HIGH** — incident response cannot answer "are we affected" in minutes.
- **Docker images / npm packages not Cosign-signed = HIGH** — no verifiable provenance.
- **GitHub Actions not SHA-pinned (any third-party action by tag) = HIGH** — moveable tag attack surface.
- **`npm ci` without `--ignore-scripts` in CI = HIGH** — arbitrary code execution at install time.
- **Lockfile not committed OR CI not failing on lockfile mismatch = HIGH**.
- **Dependency review action not in PR pipeline = HIGH** — vulnerable dependency merged.
- **Production dependencies with floating version (`^`, `~`) = MEDIUM** — non-deterministic builds (CRITICAL if combined with no lockfile).
- **`npm install` instead of `npm ci` in production builds = HIGH**.
- **Internal package names registered without `@scope/` prefix = HIGH** — dependency confusion surface.
- **Docker base images by tag (`node:22`) instead of digest (`node:22@sha256:...`) = MEDIUM** — base image swap attack.
- **No build provenance (SLSA L2 minimum) = HIGH** — cannot prove the artifact came from the source.
- **Cargo dependencies with `git = "..."` referencing a branch (not a SHA) = HIGH** — same as actions tag attack.

## Performance Concerns

- SBOM generation per-build adds 30–60s; cache by lockfile hash to avoid regeneration on unchanged dependencies.
- Cosign signing latency is dominated by Fulcio request (~1s); negligible compared to image push.
- Dependency review action latency is proportional to dependency tree size; optimize by failing fast on the first HIGH severity.

## Architectural Implications for security-reviewer

When reviewing CI/CD, Dockerfiles, and dependency manifests, the agent MUST verify:
1. Every GitHub Actions `uses:` is pinned to a full commit SHA (with version comment for readability).
2. CI uses `npm ci --ignore-scripts` (or `pnpm install --frozen-lockfile --ignore-scripts`).
3. `package-lock.json` / `pnpm-lock.yaml` / `Cargo.lock` is committed and CI fails on mismatch.
4. `actions/dependency-review-action` is enabled on every PR with `fail-on-severity: high`.
5. Docker base images are pinned by digest, not tag.
6. Production npm dependencies are exact-pinned (no `^`/`~`) OR managed by Renovate / Dependabot with explicit review.
7. Internal packages use `@scope/` prefix to defeat dependency confusion.
8. SBOM is generated per build (CycloneDX preferred) and stored alongside the artifact.
9. Build artifacts (Docker images, npm tarballs) are Cosign-signed against the GitHub Actions OIDC identity.
10. Deployment verifies signatures before pulling images (admission controller, image policy).
11. Build provenance metadata (SLSA L2 minimum) is generated and verifiable.
12. Cargo dependencies referencing git use full commit SHAs.
13. New dependencies in a PR trigger maintainer-change review (socket.dev, npm-audit-resolver, manual diff).

## Domain Rule Additions for security-reviewer

- GitHub Actions `uses:` referencing a tag instead of a commit SHA (any third-party action) = HIGH.
- `npm install` (not `npm ci`) OR missing `--ignore-scripts` in CI = HIGH.
- Lockfile not committed OR CI not enforcing lockfile match = HIGH.
- Missing `actions/dependency-review-action` in PR pipeline OR `fail-on-severity` set higher than `high` = HIGH.
- Docker base image by tag instead of digest = MEDIUM (HIGH if production-deployed).
- Production dependency with floating version range (`^`, `~`) = MEDIUM (HIGH without lockfile).
- Internal package without `@scope/` prefix = HIGH (dependency confusion).
- No SBOM generated in CI = HIGH (incident response blind spot).
- Build artifacts not Cosign-signed = HIGH.
- Deployment not verifying image signatures = HIGH.
- Build does not produce SLSA L2-compatible provenance = HIGH.
- Cargo `git = "..."` dependency without explicit SHA = HIGH.
- New dependency added in PR without maintainer-change review = MEDIUM.
- Build-time scripts (postinstall, build.rs) executing untrusted code = HIGH.
