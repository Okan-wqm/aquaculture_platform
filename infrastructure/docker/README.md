# Docker Build Configuration

This directory contains all Dockerfiles and related configurations for the Aquaculture Platform.

## Directory Structure

```
infrastructure/docker/
├── Dockerfile.backend          # Production backend (multi-stage)
├── Dockerfile.backend.dev      # Development backend (hot-reload)
├── Dockerfile.backend.simple   # Pre-built backend (fast builds)
├── Dockerfile.frontend         # React SPA build
├── Dockerfile.microfrontend    # Microfrontend modules
├── Dockerfile.microfrontend.simple  # Pre-built microfrontend
├── Dockerfile.shell            # Host application (Module Federation)
├── Dockerfile.aquamobil        # PWA mobile application
├── nginx/                      # Nginx configurations
│   ├── nginx.conf              # Main config
│   ├── shell.conf              # Shell app routing
│   ├── microfrontend.conf      # MF module config
│   └── aquamobil.conf          # PWA config
└── init-scripts/               # Database initialization
```

## Dockerfiles Overview

### Backend Services

| Dockerfile | Use Case | Build Time | Features |
|------------|----------|------------|----------|
| `Dockerfile.backend` | Production/CI | ~5-10 min | Multi-stage, security hardening, non-root user |
| `Dockerfile.backend.dev` | Development | ~2-3 min | Hot-reload with NX serve |
| `Dockerfile.backend.simple` | Fast dev builds | ~30 sec | Uses pre-built artifacts from host |

**Usage:**
```bash
# Production build
docker build -f infrastructure/docker/Dockerfile.backend \
  --build-arg SERVICE_NAME=farm-service \
  -t farm-service:latest .

# Development with hot-reload
docker build -f infrastructure/docker/Dockerfile.backend.dev \
  --build-arg SERVICE_NAME=farm-service \
  -t farm-service:dev .

# Fast build (requires local npm run build first)
docker build -f infrastructure/docker/Dockerfile.backend.simple \
  --build-arg SERVICE_NAME=farm-service \
  -t farm-service:dev .
```

### Frontend Applications

| Dockerfile | Use Case | Description |
|------------|----------|-------------|
| `Dockerfile.frontend` | React SPA | Full build with MODULE_NAME argument |
| `Dockerfile.shell` | Host app | Module Federation host with runtime config |
| `Dockerfile.microfrontend` | MF modules | Remote module builds |
| `Dockerfile.microfrontend.simple` | Fast MF builds | Pre-built dist folder |
| `Dockerfile.aquamobil` | PWA | Mobile app with service worker |

**Usage:**
```bash
# Shell (host application)
docker build -f infrastructure/docker/Dockerfile.shell \
  -t aqua-shell:latest ./web/shell

# Microfrontend module
docker build -f infrastructure/docker/Dockerfile.microfrontend.simple \
  --build-arg MODULE_PATH=web/modules/farm-module \
  -t farm-module:latest .
```

## Compose Files (Root Directory)

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Main development (full build) |
| `docker-compose.dev.yml` | Fast dev (pre-built artifacts) |
| `docker-compose.infra.yml` | Infrastructure only (DB, Redis, NATS) |
| `docker-compose.prod.yml` | Production with replicas |
| `docker-compose.watch.yml` | Hot-reload development |

**Common Commands:**
```bash
# Start infrastructure only
docker-compose -f docker-compose.infra.yml up -d

# Start everything (development)
docker-compose -f docker-compose.dev.yml up -d

# Production deployment
docker-compose -f docker-compose.prod.yml up -d
```

## Nginx Configurations

- **nginx.conf**: Base configuration with gzip, rate limiting, JSON logging
- **shell.conf**: SPA routing, Module Federation proxies, API routing
- **microfrontend.conf**: CORS headers, remoteEntry.js caching
- **aquamobil.conf**: PWA-specific caching, service worker support

## Build Arguments

### Backend
- `SERVICE_NAME`: Target service (e.g., `farm-service`, `auth-service`)

### Frontend
- `MODULE_NAME`: Module to build (e.g., `tenant-admin`)
- `MODULE_PATH`: Path to module (e.g., `web/modules/farm-module`)

## HIZLI DEVELOPMENT REHBERİ

### Local Development (EN HIZLI - Docker build YOK!)
```bash
# Sadece infra başlat + NX ile servisleri çalıştır
npm run infra:up       # PostgreSQL, Redis, NATS, MinIO
npm run dev:backend    # Backend servisleri NX ile çalıştır
npm run dev:web        # Frontend NX ile çalıştır

# Veya tek komutla:
npm run dev:fast       # infra + backend
```

### Docker ile Development (Daha yavaş ama izole)
```bash
# Pre-built artifacts ile (daha hızlı)
npm run build:all                      # Önce build et
docker-compose -f docker-compose.dev.yml up -d

# Full build (EN YAVAŞ - sadece clean build gerekince)
docker-compose up -d
```

### Production Deployment (Digital Ocean)
```bash
# 1. Kodu GitHub'a push et (main branch)
git push origin main

# 2. GitHub Actions otomatik build eder (~10-15 dk)

# 3. Server'da sadece pull et (BUILD YOK!)
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d --no-build
```

### Build Süreleri Karşılaştırma
| Yöntem | Süre | Kullanım |
|--------|------|----------|
| `npm run dev:fast` | ~30 sn | Günlük development |
| `docker-compose.dev.yml` | ~2-5 dk | İzole test |
| `docker-compose.yml` | ~30-60 dk | CI/CD veya clean build |
| GitHub Actions → Pull | ~15 dk (paralel) | Production deploy |

---

## Environment Variables

Backend services expect:
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `NATS_URL`: NATS message broker URL
- `JWT_SECRET`: Authentication secret

## Notes

- All backend builds use shared `Dockerfile.backend*` with `SERVICE_NAME` argument
- Individual service directories do NOT contain Dockerfiles
- Build context is always the repository root
- Use `.dockerignore` to optimize build context
