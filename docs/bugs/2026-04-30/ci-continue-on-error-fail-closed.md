# CI continue-on-error fail-closed cleanup

Date: 2026-04-30

## Problem

Some CI workflows still tolerated failed artifact downloads, report uploads, or
container image pulls with `continue-on-error: true`. That weakens the CI signal:
the build can appear green while required evidence or security scan inputs are
missing.

## Root Cause

Earlier workflow steps treated missing artifacts and missing pre-built images as
non-critical convenience failures. That is not enterprise-grade for this
repository because CI artifacts are part of the verification chain and security
scans require a real image input.

## Fix

- Removed tolerated frontend artifact download failures from staging and
  DigitalOcean deployment workflows.
- Removed tolerated Trivy image-pull failure and made missing GHCR image input
  block the scan.
- Removed tolerated E2E report upload failure so missing test evidence is
  visible.

## Verification

Server/local build and test execution was not run. GitHub Actions owns build,
test, security scan, and artifact verification.

Lightweight check performed:

- Confirmed no workflow still contains `continue-on-error: true`.
- Confirmed no workflow still contains `legacy-peer-deps`.
- Confirmed no workflow still contains `npm audit ... || true`.
