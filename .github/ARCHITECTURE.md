# Architecture Overview

This document provides a high-level overview of the aquaculture platform architecture.

## System Components
- Frontend (Web UI): React/Vite-based SPA served via CDN or Nginx
- Backend (API): Python (FastAPI) / Node (NestJS) microservices
- Database: PostgreSQL as primary relational store
- Cache/Queue: Redis for caching and background jobs
- Object Storage: S3-compatible storage for assets and data dumps
- Infrastructure: Terraform-managed AWS resources (EKS, RDS, S3, CloudFront)

## Data Flow
1. Users interact with the SPA, which communicates with backend APIs
2. APIs read/write to PostgreSQL and publish events to Redis/queues
3. Background workers process jobs and update system state
4. Metrics and logs are shipped to centralized observability stack

## Deployment
- CI: GitHub Actions (`ci-affected.yml`, `ci-full.yml`)
- CD: GitHub Actions DigitalOcean droplet path (`deploy-digitalocean.yml`,
  `deploy-staging.yml`). Auto-fires from `ci-affected.yml`'s final `deploy:`
  job via `workflow_call` (replaced the previous `workflow_run` chain in
  TRACK A). Staging is shelf-ready; gated behind `vars.STAGING_ENABLED`.
  K8s migration deferred — the previously-shelf K8s workflows
  (`cd-production.yml`, `cd-staging.yml`) were deleted in TRACK B; recreate
  from git history when EKS lands.
- Container Registry: GHCR (ghcr.io)
- Orchestration: DigitalOcean Droplet (current) → Kubernetes (planned)

## Security
- Snyk and Trivy scans
- Dependency review on PRs
- Least-privilege IAM roles and sealed secrets

## Observability
- Centralized logging (e.g., Loki/CloudWatch)
- Metrics (Prometheus/Grafana)
- Tracing (OpenTelemetry)

## Conventions
- Semantic versioning for releases
- Conventional commits for commit messages
- Code owners enforce reviews

## Future Work
- Blue/green deployments
- Canary releases
- Automated rollbacks with SLOs
