# Research: Docker Multi-Stage Hardening — Non-Root, dumb-init PID 1, HEALTHCHECK

**Topic:** Production Docker image hardening — multi-stage builds, non-root USER, dumb-init signal handling, HEALTHCHECK, pinned base images, secret hygiene, `.dockerignore` discipline.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [Docker Docs: Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker Docs: Dockerfile best practices](https://docs.docker.com/build/building/best-practices/)
- [Docker Docs: HEALTHCHECK reference](https://docs.docker.com/reference/dockerfile/#healthcheck)
- [NIST SP 800-190 Application Container Security Guide](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-190.pdf)
- [CIS Docker Benchmark v1.6.0 (cisecurity.org)](https://www.cisecurity.org/benchmark/docker)
- [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
- [Yelp dumb-init: A minimal init system for Linux containers](https://github.com/Yelp/dumb-init)
- [Yelp Engineering Blog: Introducing dumb-init](https://engineeringblog.yelp.com/2016/01/dumb-init-an-init-for-docker.html)
- [Peter Malmgren: PID 1 Signal Handling in Docker](https://petermalmgren.com/signal-handling-docker/)
- [Snyk: 10 Docker Image Security Best Practices](https://snyk.io/blog/10-docker-image-security-best-practices/)

## Key Findings

1. **Multi-stage separation of concerns.** A production Dockerfile MUST use at least three stages: `deps` (install all deps for compile), `builder` (compile TypeScript/bundle assets), `prod-deps` (clean npm ci --omit=dev for runtime), and `runner` (final minimal image). devDependencies, build tools, and source maps MUST NOT ship to the runtime image — they inflate attack surface and image size.
2. **Non-root USER is mandatory.** NIST SP 800-190 §4.4.4 and CIS Docker Benchmark 4.1 require a dedicated UID ≥ 1000 for application processes. Create with `addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs nestjs`, then `USER nestjs` before `CMD`. Running as UID 0 (root) = CRITICAL — a container escape or kernel CVE becomes host root.
3. **dumb-init as PID 1 is not optional for Node.js.** Node does not install default signal handlers when running as PID 1 because the Linux kernel applies special rules to PID 1 (no default SIGTERM handler). Without an init, `docker stop` sends SIGTERM, the node process ignores it, then SIGKILL lands after 10s grace — graceful shutdown, database flush, and outbox drain never run. `dumb-init` (or `tini` via `docker run --init`) reaps zombies and forwards signals correctly.
4. **JSON-form ENTRYPOINT/CMD is required for dumb-init.** Shell-form `ENTRYPOINT dumb-init node server.js` spawns `/bin/sh -c` as PID 1 and makes dumb-init useless. Always use exec-form: `ENTRYPOINT ["dumb-init", "--"]` then `CMD ["node", "dist/main.js"]`.
5. **Base images pinned to digest, not tag.** `node:22-alpine` is mutable; Docker Hub can repoint it. Use `node:22.12.0-alpine3.20@sha256:<64-hex>` for supply-chain integrity. `latest` = CRITICAL; unpinned tags = HIGH. Update cadence via Renovate/Dependabot.
6. **HEALTHCHECK is mandatory for orchestrator liveness feedback.** Every Dockerfile MUST declare `HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 CMD node -e "require('http').get('http://localhost:PORT/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"`. Missing HEALTHCHECK prevents orchestrators (Compose, Swarm) from detecting zombie processes; in Kubernetes the equivalent is `livenessProbe` in the pod spec.
7. **`--chown=user:group` on COPY.** Files copied without `--chown` default to root:root and are unreadable by the non-root runtime user — or worse, writable if permissions leak. Always `COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist`.
8. **No secrets in ENV or ARG.** `ENV DATABASE_URL=postgres://...` and `ARG API_KEY` both persist in image layers and `docker history`. Secrets MUST come from Docker Secrets, Kubernetes Secrets, AWS Secrets Manager, or env vars injected at runtime. Hardcoded secrets in Dockerfile = CRITICAL.
9. **`NODE_ENV=production` set explicitly.** Prevents Express/NestJS stack traces leaking on error responses, disables dev-only middleware, and triggers framework performance paths.
10. **`.dockerignore` must be present and complete.** Minimum exclusions: `node_modules`, `.git`, `.env*`, `coverage`, `dist`, `*.md`, `.vscode`, `.idea`, `test/`, `tests/`, `*.test.ts`, `*.spec.ts`. Without `.dockerignore`, `COPY . .` bakes the local `.env` file and git history into the image — CRITICAL.
11. **Read-only root filesystem at runtime.** Compose/K8s should run containers with `read_only: true` and mount tmpfs for `/tmp`, writable volume for data. Prevents runtime malware from modifying binaries.
12. **Drop Linux capabilities.** `cap_drop: [ALL]` then `cap_add` only what is required (rarely anything for Node). Combined with `no-new-privileges: true`, blocks privilege escalation paths.
13. **Layer cache discipline.** `COPY package*.json ./ && npm ci` before `COPY . .` so dependency layer caches until package.json changes. Reversing this invalidates the cache on every source change — slow CI.
14. **Image scanning in CI.** Every image push MUST be scanned (Trivy, Grype, Snyk) with fail-on HIGH/CRITICAL. Unscanned images in production = HIGH.

## Security Concerns
- Container running as root (`USER` not set, or `USER root`) = CRITICAL.
- Dockerfile with no HEALTHCHECK = HIGH.
- Base image pinned only to major tag (`node:22`) or `latest` = CRITICAL.
- Secrets in ENV or ARG layers = CRITICAL.
- Missing `.dockerignore` or incomplete exclusion of `.env*` / `.git` = CRITICAL.
- `COPY . .` in production stage (ships source, tests, dotfiles) = HIGH.
- Shell-form ENTRYPOINT preventing signal propagation = HIGH (graceful shutdown broken).
- No dumb-init / tini / `--init` in Node.js containers = HIGH (zombie reap + signal handling).
- Missing `--chown` on COPY = MEDIUM (permission fragility) or HIGH (world-writable app dir).
- `HEALTHCHECK` that uses `curl` in an image without curl installed = MEDIUM (silent misconfig).
- devDependencies shipped to runtime image = HIGH (attack surface bloat).

## Performance Concerns
- Missing layer cache discipline (source copied before package.json) = MEDIUM (slow CI).
- Alpine vs. Debian-slim base image: Alpine is smaller but `musl` can cause Node native module issues; Debian slim is safer for Node/Python native modules = MEDIUM.
- Single-stage build shipping full `node_modules` with devDependencies = HIGH (image 3-5x larger).
- `apt-get update && apt-get install` without `--no-install-recommends` and cache cleanup = MEDIUM.

## Architectural Implications for infra-expert reviews
- Every Dockerfile MUST have: multi-stage (min 3 stages), non-root USER with explicit UID, pinned base image by digest, HEALTHCHECK, dumb-init/tini in ENTRYPOINT, `.dockerignore`, NODE_ENV=production.
- Any Dockerfile running as root = CRITICAL block-deploy finding.
- Any Dockerfile with secrets in ENV/ARG = CRITICAL.
- Any Dockerfile without HEALTHCHECK = HIGH.
- Any Dockerfile missing dumb-init for Node.js = HIGH (graceful shutdown risk).
- Any `latest` tag in base image or Compose = CRITICAL.
- Any Compose service lacking `read_only`, `cap_drop`, `no-new-privileges` = HIGH for production compose.

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → Docker (Critical)`:
- Every Dockerfile MUST use multi-stage builds with a dedicated `prod-deps` stage; shipping devDependencies to runtime = HIGH.
- Every container MUST run as a non-root user with explicit UID ≥ 1000; missing `USER` directive = CRITICAL.
- Node.js / Python containers MUST use `dumb-init` (or `tini`) as PID 1 via JSON-form ENTRYPOINT; shell-form ENTRYPOINT = HIGH.
- Every Dockerfile MUST have a `HEALTHCHECK` instruction; missing = HIGH.
- Base images MUST be pinned to exact version + digest (`image@sha256:...`); floating tags = CRITICAL.
- `COPY` to application directories MUST use `--chown`; missing = MEDIUM.
- Secrets MUST NOT appear in `ENV` or `ARG`; found in layers = CRITICAL.
- Every repo MUST ship a `.dockerignore` excluding `.env*`, `.git`, `node_modules`, `coverage`, test files; missing = CRITICAL.
- Production Compose services SHOULD set `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`; missing = HIGH for prod compose.
