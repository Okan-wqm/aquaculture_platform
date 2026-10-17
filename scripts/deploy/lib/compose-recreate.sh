#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/lib/compose-recreate.sh
#
# The one way the droplet deploy replaces running application containers
# (INFRA-HIGH-230). Sourced by scripts/deploy/droplet-up.sh and the rollback
# library; defines functions only.
#
# compose_recreate_services <image-tag> <service>...
#   1. scripts/deploy/compose-container-preflight.ts decides, before anything is
#      stopped, whether every target container name is free for compose: a name
#      held by a container this project does not own fails the call; temp
#      containers (`<id12>_<name>`) left by an interrupted recreate are removed.
#   2. `docker compose up --no-deps --no-build --force-recreate` with TAG set to
#      <image-tag>, so the caller chooses the image generation by NAME (the
#      release SHA, or the rollback generation) and no tag is rewritten to make
#      compose pick an image.
# =============================================================================

compose_recreate_services() {
  local image_tag="${1:-}"
  if [ -z "${image_tag}" ] || [ "$#" -lt 2 ]; then
    echo "::error::compose_recreate_services requires an image tag and at least one service."
    return 1
  fi
  shift

  if ! TAG="${image_tag}" node scripts/deploy/compose-container-preflight.ts "$@"; then
    echo "::error::Compose recreate preflight refused: $*"
    return 1
  fi
  TAG="${image_tag}" docker compose -f docker-compose.droplet.yml \
    up -d --no-deps --no-build --force-recreate "$@"
}
