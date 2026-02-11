# =============================================================================
# Aquaculture Platform - Docker Bake Configuration
# Enables parallel building of all services with shared cache
#
# Usage:
#   docker buildx bake                    # Build everything
#   docker buildx bake backend            # Build all backend services
#   docker buildx bake frontend           # Build all frontend modules
#   docker buildx bake auth-service       # Build single service
#   docker buildx bake --load             # Build and load to local Docker
#   docker buildx bake --push             # Build and push to registry
#
# Environment variables:
#   TAG         - Image tag (default: latest)
#   REGISTRY    - Registry prefix (default: empty for local)
# =============================================================================

variable "TAG" {
  default = "latest"
}

variable "REGISTRY" {
  default = ""
}

# Cache registry for CI/CD (e.g., ghcr.io/username/aqua-cache)
variable "CACHE_REGISTRY" {
  default = ""
}

# Git branch for cache isolation
variable "BRANCH" {
  default = "main"
}

# Cache mode: "local", "registry", or "gha" (GitHub Actions)
variable "CACHE_MODE" {
  default = "local"
}

# Helper function for registry prefix
function "registry_prefix" {
  params = []
  result = REGISTRY != "" ? "${REGISTRY}/" : ""
}

# Helper function for cache sources (supports local, registry, or GHA)
function "cache_from_backend" {
  params = []
  result = CACHE_MODE == "gha" ? [
    "type=gha,scope=backend"
  ] : CACHE_REGISTRY != "" ? [
    "type=local,src=.docker-cache/backend",
    "type=registry,ref=${CACHE_REGISTRY}:backend-${BRANCH}",
    "type=registry,ref=${CACHE_REGISTRY}:backend-main"
  ] : [
    "type=local,src=.docker-cache/backend"
  ]
}

function "cache_to_backend" {
  params = []
  result = CACHE_MODE == "gha" ? [
    "type=gha,scope=backend,mode=max"
  ] : CACHE_REGISTRY != "" ? [
    "type=local,dest=.docker-cache/backend,mode=max",
    "type=registry,ref=${CACHE_REGISTRY}:backend-${BRANCH},mode=max"
  ] : [
    "type=local,dest=.docker-cache/backend,mode=max"
  ]
}

# Helper function for frontend cache
function "cache_from_frontend" {
  params = []
  result = CACHE_MODE == "gha" ? [
    "type=gha,scope=frontend"
  ] : CACHE_REGISTRY != "" ? [
    "type=local,src=.docker-cache/frontend",
    "type=registry,ref=${CACHE_REGISTRY}:frontend-${BRANCH}"
  ] : [
    "type=local,src=.docker-cache/frontend"
  ]
}

function "cache_to_frontend" {
  params = []
  result = CACHE_MODE == "gha" ? [
    "type=gha,scope=frontend,mode=max"
  ] : CACHE_REGISTRY != "" ? [
    "type=local,dest=.docker-cache/frontend,mode=max",
    "type=registry,ref=${CACHE_REGISTRY}:frontend-${BRANCH},mode=max"
  ] : [
    "type=local,dest=.docker-cache/frontend,mode=max"
  ]
}

# =============================================================================
# Groups - Build multiple targets at once
# =============================================================================

group "default" {
  targets = ["backend", "frontend"]
}

group "backend" {
  targets = [
    "gateway-api",
    "auth-service",
    "farm-service",
    "sensor-service",
    "alert-engine",
    "billing-service",
    "hr-service",
    "notification-service",
    "admin-api-service"
  ]
}

group "frontend" {
  targets = [
    "shell",
    "dashboard",
    "farm-module",
    "hr-module",
    "sensor-module",
    "admin-panel",
    "tenant-admin"
  ]
}

group "infrastructure" {
  targets = ["postgres", "redis", "nats", "minio"]
}

# =============================================================================
# Backend Services - Common Configuration
# =============================================================================

target "_backend-common" {
  dockerfile = "infrastructure/docker/Dockerfile.backend"
  context    = "."
  platforms  = ["linux/amd64"]

  # BuildKit cache configuration (local + optional registry)
  cache-from = cache_from_backend()
  cache-to   = cache_to_backend()
}

target "_backend-simple-common" {
  dockerfile = "infrastructure/docker/Dockerfile.backend.simple"
  context    = "."
  platforms  = ["linux/amd64"]
  
  cache-from = [
    "type=local,src=.docker-cache/backend-simple"
  ]
  cache-to = [
    "type=local,dest=.docker-cache/backend-simple,mode=max"
  ]
}

# =============================================================================
# Backend Services - Individual Targets (Full Build)
# =============================================================================

target "gateway-api" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "gateway-api"
  }
  tags = ["${registry_prefix()}aqua-gateway:${TAG}"]
}

target "auth-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "auth-service"
  }
  tags = ["${registry_prefix()}aqua-auth:${TAG}"]
}

target "farm-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "farm-service"
  }
  tags = ["${registry_prefix()}aqua-farm:${TAG}"]
}

target "sensor-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "sensor-service"
  }
  tags = ["${registry_prefix()}aqua-sensor:${TAG}"]
}

target "alert-engine" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "alert-engine"
  }
  tags = ["${registry_prefix()}aqua-alert:${TAG}"]
}

target "billing-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "billing-service"
  }
  tags = ["${registry_prefix()}aqua-billing:${TAG}"]
}

target "hr-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "hr-service"
  }
  tags = ["${registry_prefix()}aqua-hr:${TAG}"]
}

target "notification-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "notification-service"
  }
  tags = ["${registry_prefix()}aqua-notification:${TAG}"]
}

target "admin-api-service" {
  inherits = ["_backend-common"]
  args = {
    SERVICE_NAME = "admin-api-service"
  }
  tags = ["${registry_prefix()}aqua-admin-api:${TAG}"]
}

# =============================================================================
# Backend Services - Simple Build (Pre-built artifacts)
# Use these when you've already built services on host with `npm run build:all`
# =============================================================================

group "backend-simple" {
  targets = [
    "gateway-api-simple",
    "auth-service-simple",
    "farm-service-simple",
    "sensor-service-simple",
    "alert-engine-simple",
    "billing-service-simple",
    "hr-service-simple",
    "notification-service-simple",
    "admin-api-service-simple"
  ]
}

target "gateway-api-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "gateway-api"
  }
  tags = ["${registry_prefix()}aqua-gateway:${TAG}"]
}

target "auth-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "auth-service"
  }
  tags = ["${registry_prefix()}aqua-auth:${TAG}"]
}

target "farm-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "farm-service"
  }
  tags = ["${registry_prefix()}aqua-farm:${TAG}"]
}

target "sensor-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "sensor-service"
  }
  tags = ["${registry_prefix()}aqua-sensor:${TAG}"]
}

target "alert-engine-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "alert-engine"
  }
  tags = ["${registry_prefix()}aqua-alert:${TAG}"]
}

target "billing-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "billing-service"
  }
  tags = ["${registry_prefix()}aqua-billing:${TAG}"]
}

target "hr-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "hr-service"
  }
  tags = ["${registry_prefix()}aqua-hr:${TAG}"]
}

target "notification-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "notification-service"
  }
  tags = ["${registry_prefix()}aqua-notification:${TAG}"]
}

target "admin-api-service-simple" {
  inherits = ["_backend-simple-common"]
  args = {
    SERVICE_NAME = "admin-api-service"
  }
  tags = ["${registry_prefix()}aqua-admin-api:${TAG}"]
}

# =============================================================================
# Frontend Modules - Common Configuration
# =============================================================================

target "_frontend-common" {
  dockerfile = "infrastructure/docker/Dockerfile.microfrontend.simple"
  context    = "."
  platforms  = ["linux/amd64"]
}

target "_shell-common" {
  dockerfile = "infrastructure/docker/Dockerfile.shell"
  context    = "."
  platforms  = ["linux/amd64"]
}

# =============================================================================
# Frontend Modules - Individual Targets
# =============================================================================

target "shell" {
  inherits = ["_shell-common"]
  tags = ["${registry_prefix()}aqua-shell:${TAG}"]
}

target "dashboard" {
  inherits = ["_frontend-common"]
  args = {
    MODULE_PATH = "web/modules/dashboard"
  }
  tags = ["${registry_prefix()}aqua-dashboard:${TAG}"]
}

target "farm-module" {
  inherits = ["_frontend-common"]
  args = {
    MODULE_PATH = "web/modules/farm-module"
  }
  tags = ["${registry_prefix()}aqua-farm-module:${TAG}"]
}

target "hr-module" {
  inherits = ["_frontend-common"]
  args = {
    MODULE_PATH = "web/modules/hr-module"
  }
  tags = ["${registry_prefix()}aqua-hr-module:${TAG}"]
}

target "sensor-module" {
  inherits = ["_frontend-common"]
  args = {
    MODULE_PATH = "web/modules/sensor-module"
  }
  tags = ["${registry_prefix()}aqua-sensor-module:${TAG}"]
}

target "admin-panel" {
  inherits = ["_frontend-common"]
  args = {
    MODULE_PATH = "web/modules/admin-panel"
  }
  tags = ["${registry_prefix()}aqua-admin-panel:${TAG}"]
}

target "tenant-admin" {
  inherits = ["_frontend-common"]
  args = {
    MODULE_PATH = "web/modules/tenant-admin"
  }
  tags = ["${registry_prefix()}aqua-tenant-admin:${TAG}"]
}
