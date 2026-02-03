# Aquaculture Platform - Deployment Guide

## Quick Reference

| Environment | Command | Description |
|-------------|---------|-------------|
| Local Dev | `npm run infra:up && npm run dev:backend` | Infra in Docker, services local |
| Docker Dev | `docker-compose -f docker-compose.dev.yml up -d` | Everything in Docker |
| Production | Push to `main` branch | GitHub Actions auto-deploy |

---

## 1. Local Development (Recommended - Fastest)

### Prerequisites
- Node.js 20+
- Docker Desktop
- npm installed

### Start Development

```bash
# Step 1: Start infrastructure only (Docker)
npm run infra:up

# This starts:
# - PostgreSQL (TimescaleDB) on port 5432
# - Redis on port 6379
# - NATS on port 4222
# - MinIO on port 9000
# - Adminer on port 8080
# - MailHog on port 8025

# Step 2: Wait for containers to be healthy (~10 seconds)
docker-compose -f docker-compose.infra.yml ps

# Step 3: Start backend services locally (fast hot-reload)
npm run dev:backend

# Step 4: (Optional) Start frontend in another terminal
npm run dev:web
```

### One-Command Start
```bash
npm run dev:fast    # Starts infra + backend
```

### Stop Development
```bash
npm run infra:down  # Stops Docker containers
# Ctrl+C to stop NX processes
```

---

## 2. Docker Development (Isolated)

Use when you need full isolation or testing Docker builds.

```bash
# Option A: Pre-built artifacts (faster, requires local build first)
npm run build:all
docker-compose -f docker-compose.dev.yml up -d

# Option B: Full Docker build (slow, ~30-60 min first time)
docker-compose up -d
```

### Stop Docker Development
```bash
docker-compose down
# or
docker-compose -f docker-compose.dev.yml down
```

---

## 3. Production Deployment (Digital Ocean)

### Automatic Deployment via GitHub Actions

1. **Push to main branch**
   ```bash
   git push origin main
   ```

2. **GitHub Actions automatically:**
   - Runs tests and linting (~2-3 min)
   - Builds Docker images in parallel (~10 min)
   - Pushes to GitHub Container Registry
   - SSHs to Digital Ocean droplet
   - Pulls new images and restarts services

3. **Monitor deployment:**
   - Go to: https://github.com/Okan-wqm/aquaculture_platform/actions
   - Check "Deploy to DigitalOcean" workflow

### Manual Deployment (On Server)

SSH into your Digital Ocean droplet:

```bash
ssh root@your-droplet-ip
cd /var/aqua-saas

# Login to GitHub Container Registry
echo "YOUR_GITHUB_TOKEN" | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Pull latest images (NO rebuild!)
docker-compose -f docker-compose.prod.yml pull

# Deploy with zero downtime
docker-compose -f docker-compose.prod.yml up -d --no-build --remove-orphans

# Verify
docker-compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

---

## 4. Environment Variables

### Required for Backend Services
```env
DATABASE_URL=postgres://user:pass@localhost:5432/aquaculture
REDIS_URL=redis://:password@localhost:6379
NATS_URL=nats://localhost:4222
JWT_SECRET=your-secret-key
```

### MinIO (Object Storage)
```env
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
```

### Production Secrets (GitHub)
Set these in GitHub Repository Settings > Secrets:
- `DROPLET_HOST` - Digital Ocean IP
- `DROPLET_USER` - SSH user (usually `root`)
- `DROPLET_SSH_KEY` - Private SSH key
- `SLACK_WEBHOOK_URL` - (Optional) Slack notifications

---

## 5. Docker Compose Files

| File | Use Case |
|------|----------|
| `docker-compose.yml` | Full development (builds everything) |
| `docker-compose.dev.yml` | Uses pre-built artifacts (faster) |
| `docker-compose.infra.yml` | Infrastructure only (DB, Redis, etc.) |
| `docker-compose.prod.yml` | Production (pulls from registry) |
| `docker-compose.watch.yml` | Hot-reload development |

---

## 6. Ports Reference

| Service | Port | URL |
|---------|------|-----|
| Gateway API | 3000 | http://localhost:3000/graphql |
| PostgreSQL | 5432 | - |
| Redis | 6379 | - |
| NATS | 4222 | - |
| NATS Monitor | 8222 | http://localhost:8222 |
| MinIO API | 9000 | http://localhost:9000 |
| MinIO Console | 9001 | http://localhost:9001 |
| Adminer | 8080 | http://localhost:8080 |
| MailHog | 8025 | http://localhost:8025 |
| Shell (Frontend) | 4200 | http://localhost:4200 |

---

## 7. Troubleshooting

### Container name conflict
```bash
docker-compose down --remove-orphans
docker-compose -f docker-compose.infra.yml up -d
```

### Port already in use
```bash
# Find process using port
netstat -ano | findstr :3000
# Kill process
taskkill /PID <pid> /F
```

### Database connection error
```bash
# Check if PostgreSQL is running
docker-compose -f docker-compose.infra.yml ps postgres
# Check logs
docker logs aqua-postgres
```

### Clear everything and start fresh
```bash
docker-compose down -v --remove-orphans
docker system prune -f
npm run infra:up
```

---

## 8. Build Times Reference

| Method | Time | When to Use |
|--------|------|-------------|
| `npm run dev:fast` | ~30 sec | Daily development |
| `docker-compose.dev.yml` | ~2-5 min | Isolated testing |
| `docker-compose.yml` | ~30-60 min | Clean Docker build |
| GitHub Actions | ~15 min | Production deploy |

---

## 9. CI/CD Pipeline

### Workflow Overview
```
Push to main
    ↓
CI - Affected (lint, test) ~11 sec
    ↓
Security Scans (Trivy, Snyk) ~30 sec
    ↓
Build & Test ~5-10 min
    ↓
Build Docker Images (parallel matrix) ~10 min
    ↓
Push to GHCR
    ↓
Deploy to DigitalOcean ~2 min
    ↓
Health Check + Notification
```

### Key Features
- **Parallel builds**: 9 backend + 7 frontend built simultaneously
- **Registry cache**: Images cached in GitHub Container Registry
- **Pre-built artifacts**: Docker uses compiled JS, not source
- **Zero-downtime**: Rolling updates on production
- **Auto-cancel**: New push cancels old deployment
