# Deploy starvation and droplet capacity (2026-10-28)

Found while landing the module-boundaries release R1 on 2026-10-27. The droplet still ran the
`855d5818dd` images, built on 2026-10-22, after R1, the Inter typography change and the mono-font
audit had all reached `main`. Verified against `origin/main` `cbcf90a0f`.

## DEPLOY-HIGH-031 — a deploy is refused once main has moved on

The development deploy refuses a run whose commit is no longer the head of `main`, and a CI run
takes longer than the interval between merges, so a merged commit can wait days for a deploy.

**Where:** `.github/workflows/deploy-development.yml:70,156`.

**Root cause chain (each link verified):**

1. `capacity-preflight` reads the current head of `main` and fails with the error "Refusing
   stale development deploy" when it differs from `GITHUB_SHA`.
2. A `CI - Affected` run on the single self-hosted runner takes one to two hours. `main` moved
   every one to two hours on 2026-10-27, so the run for `3c9daf3a6b` (R1) failed this check when
   `11fe762dce` (Inter) merged, and the run for `11fe762dce` failed it when `141202cd4` merged.
3. The refusal names no retry. The next run is itself refused when `main` moves again, so deploys
   starve whenever merges are frequent, and a deploy needs a quiet window longer than one run.

**Not done:** the check is unchanged. The direction is to deploy the newest commit of `main`
whose checks passed, so a later merge supersedes an earlier deploy instead of cancelling it.

## DEPLOY-HIGH-032 — the droplet disk cannot hold a full deploy

The droplet disk is 91% used with 21.5 GiB free of 227 GiB. The full-deploy gate asked for 35 GiB
free, 10% free and 20 GiB left after an estimated 20 GiB pull, about 42 GiB in all.

**Where:** `scripts/deploy/droplet-capacity.sh:67,79,88,93`.

**Measured:** `docker system df -v` shows 16 backend images with about 1.0 GB of layers of their
own over a shared 322 MB base, and web images of about 0.1 GB, so a pull that reuses no layer is
about 16.2 GiB. The gate estimated 20 GiB.

**Owner decision (Okan, 2026-10-28):** lower the floors to 20 GiB absolute, 5% and a 3 GiB
reserve, with the pull estimate set to 17 GiB. After the worst-case pull about 4.5 GiB (2%) stays
free. The superseded generation is untagged afterwards and `safe-image-gc` returns its space.

**Not done:** the disk is not enlarged. Postgres, Redis and NATS volumes share this filesystem, so
a pull that overruns the estimate fills the disk under production. Enlarging the DigitalOcean disk
or moving the image store to a volume removes the cause; the lowered floors only admit the deploy.
