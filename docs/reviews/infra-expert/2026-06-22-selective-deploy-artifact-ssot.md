# Selective Deploy Artifact SSoT Finding

Scope: `.github/workflows/deploy-digitalocean.yml`, `scripts/deploy/droplet-up.sh`,
`docker-compose.droplet.yml`, backend Redis module wiring, and deploy invariant coverage.

## DEPLOY-HIGH-003

Manual selective production deploy can advance schema and restart services with images that were
not proven to come from the requested source revision.

The 2026-06-22 production deploy run `27951623826` failed after `db-migrate` completed and the
critical health gate started. The observed runtime failures were three symptoms of the same
control-plane split:

- `farm-service` image for the deployed SHA contained compiled `MarineDataService` files that did
  not exist in `origin/main` at that SHA. The backend artifact lane allowed restored Nx output to
  flow into Docker image construction without proving every emitted `dist/apps/<service>/.../src`
  file had a matching tracked source file.
- `admin-api-service` was restarted against a forward admin schema while the manual service list
  omitted it. The release included admin migrations, but specific-service dispatch treated the user
  list as exhaustive instead of expanding it through the migration-owner SSoT.
- `sensor-service` rejected Redis config because compose supplied `REDIS_URL` and host-style
  Redis variables together. Runtime validation was correct; production env assembly was double
  sourced.
- Selective rollback recreated the broad compose app surface, so services outside the requested
  deploy scope could be retagged and restarted during a failed selective release.

Root cause: production deploy authority was split across operator-supplied service names, restored
build caches, compose env wiring, and a global rollback path. The deploy catalog was not the single
source for migration-owner expansion, artifact provenance, Redis connection shape, and selective
rollback scope.

Architectural requirement:

- Backend production artifacts are built with local Nx cache disabled and rejected unless emitted
  app JavaScript maps back to current source files.
- Manual selective deploy requests are treated as deployment intent. The workflow expands that set
  with catalog-derived migration owner services before image build, digest verification, and droplet
  mutation.
- Selective rollback retags and recreates only the services changed by the current release; full
  deploy rollback remains all application image services except the one-shot migration runner.
- Droplet Redis env has one source per service, and URL-aware Nest modules consume the shared
  backend-common Redis options builder.
- Invariant coverage pins each deploy contract so the control plane cannot drift back into split
  authority.
