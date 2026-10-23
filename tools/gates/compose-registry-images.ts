/**
 * The compose files the deploy-SSoT contract binds to registry images only.
 *
 * WHY this module exists: `docker-compose.droplet.yml` and `docker-compose.staging.yml` build
 * nothing and pull only from the registry; a `build:` section or a `${TAG:-latest}` default would
 * rebuild or float what production runs. The list lived inline in
 * tests/invariants/deploy-ssot-contract.spec.ts, which enforces the contract; the ARIA
 * infrastructure-policy adapter records which compose files it binds, so both read it here
 * (ARIA-HIGH-012 landing). Whether an image reference floats is image-reference.ts's verdict
 * (tools/gates/infra-policy), not a second regex here.
 */
export const REGISTRY_IMAGE_COMPOSES = [
  'docker-compose.droplet.yml',
  'docker-compose.staging.yml',
] as const;
