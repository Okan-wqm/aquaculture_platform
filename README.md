# Aquaculture Platform - Enterprise IoT & Process Management System

## Overview

Enterprise-grade aquaculture management platform built with microservices architecture, event-driven design, and microfrontend patterns. The system provides real-time monitoring, process automation, HR management, billing, and analytics for aquaculture operations.

## Architecture

### Technology Stack

**Backend:**
- NestJS microservices with CQRS/Event Sourcing
- PostgreSQL with TimescaleDB for time-series data
- Redis for caching and session management
- NATS for event-driven messaging
- GraphQL Federation for API Gateway

**Frontend:**
- React 18 with TypeScript
- Module Federation for microfrontends
- TanStack Query for state management
- Tailwind CSS + shadcn/ui for styling

**Infrastructure:**
- Docker with BuildKit optimization
- Docker Compose for local development
- Kubernetes orchestration (production)
- Terraform for IaC

### Monorepo Structure

```
aquaculture-platform/
├── apps/                    # Backend microservices
│   ├── gateway-api/         # GraphQL Federation Gateway
│   ├── auth-service/        # Authentication & Authorization
│   ├── farm-service/        # Farm & Facility Management
│   ├── sensor-service/      # IoT Sensor Data Ingestion
│   ├── alert-engine/        # Real-time Alerting
│   ├── hr-service/          # Human Resources
│   ├── billing-service/     # Billing & Invoicing
│   ├── notification-service/# Multi-channel Notifications
│   └── admin-api-service/   # Admin Operations
├── web/                     # Frontend applications
│   ├── shell/               # Main app shell (MF host)
│   ├── modules/             # Microfrontend remotes
│   └── shared-ui/           # Shared UI components
├── libs/                    # Shared libraries
├── infrastructure/          # Docker & deployment configs
└── docs/                    # Documentation
```

## Getting Started

### Prerequisites

- Node.js 20.11.0+ (LTS)
- Docker & Docker Compose
- npm 10.0.0+

### Installation

```bash
# Install dependencies
npm install

# Build all projects
npm run build:all

# Run tests
npm run test:all
```

## Docker Development

### Quick Start (Recommended)

```bash
# 1. Start infrastructure (PostgreSQL, Redis, NATS)
npm run infra:up

# 2. Fast Docker build (pre-build + simple Dockerfile)
npm run docker:fast

# 3. Start all services
npm run docker:up
```

### Docker Commands

| Command | Description | Speed |
|---------|-------------|-------|
| `npm run docker:fast` | Pre-build + parallel Docker build | **~3-5 min** |
| `npm run docker:affected` | Build only changed services | **~1-3 min** |
| `npm run docker:up:watch` | Hot-reload development mode | **Instant sync** |
| `npm run docker:build` | Full Docker build (slow) | ~20+ min |
| `npm run docker:build:backend:simple` | Pre-built artifacts approach | ~3 min |

### Development Modes

#### Option 1: Docker Compose Watch (Hot Reload)
```bash
# Start with automatic file sync
npm run docker:up:watch
```
- Changes to source files sync instantly
- No manual rebuild needed
- Best for active development

#### Option 2: Local Services + Docker Infrastructure
```bash
# Start only infrastructure
npm run infra:up

# Run services locally with hot reload
npm run dev:backend
```

#### Option 3: Full Docker (Production-like)
```bash
# Build everything
npm run docker:fast

# Start all containers
npm run docker:up

# View logs
npm run docker:logs
```

### Docker Build Optimization

The platform uses optimized Docker builds with:

- **BuildKit cache mounts** for npm and NX cache
- **Multi-stage builds** for smaller production images
- **Registry cache support** for CI/CD pipelines
- **Parallel builds** with docker buildx bake

```bash
# CI/CD with registry cache
CACHE_REGISTRY=ghcr.io/org/cache docker buildx bake backend-simple --load

# Build specific service
npm run docker:fast:service --service=auth-service
```

## CI/CD Pipeline

### Overview

The platform uses an optimized CI/CD pipeline with:
- **Parallel Docker builds** via GitHub Actions matrix strategy (9 backend + 7 frontend)
- **Registry cache** for unlimited cache size (no 10GB GHA limit)
- **Nx Cloud** for remote build caching
- **Pre-built images** - no rebuild on production server

### Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `deploy-digitalocean.yml` | Push to `main` | Production deployment with pre-built images |
| `cd-staging.yml` | Push to `develop`, `feature/*` | Staging environment deployment |
| `cd-production.yml` | Tag `v*.*.*` | Production release with security scan |

### Build Performance

| Method | Build Time | Cache |
|--------|------------|-------|
| Legacy (rebuild on server) | ~25-30 min | None |
| **Optimized (parallel + registry cache)** | **~5-8 min** | Unlimited |
| Incremental (affected only) | ~2-4 min | Unlimited |

### Required GitHub Secrets

```yaml
# Nx Cloud (free tier)
NX_CLOUD_ACCESS_TOKEN: "your-nx-cloud-token"

# DigitalOcean Deployment
DROPLET_HOST: "your-droplet-ip"
DROPLET_USER: "root"
DROPLET_SSH_KEY: "your-ssh-private-key"

# Kubernetes (optional - for cd-production.yml)
KUBE_CONFIG_STAGING: "base64-encoded-kubeconfig"
KUBE_CONFIG_PRODUCTION: "base64-encoded-kubeconfig"

# Notifications (optional)
SLACK_WEBHOOK_URL: "your-slack-webhook"
```

### Manual Deployment

```bash
# Trigger deployment via GitHub Actions
gh workflow run "Deploy to DigitalOcean (Optimized)" --ref main

# Or trigger staging
gh workflow run "CD - Staging" --ref develop
```

### Docker Bake (Local CI/CD)

```bash
# Build all with local cache
docker buildx bake

# Build with registry cache (CI/CD)
CACHE_MODE=registry CACHE_REGISTRY=ghcr.io/org/aqua-cache docker buildx bake

# Build with GitHub Actions cache
CACHE_MODE=gha docker buildx bake

# Build specific group
docker buildx bake backend    # 9 backend services
docker buildx bake frontend   # 7 frontend modules
```

## Local Development

```bash
# Start all services in development mode
npm run dev

# Start specific backend services
npm run dev:backend

# Start web applications
npm run dev:web

# Start individual service
npm run local:auth      # Auth service
npm run local:farm      # Farm service
npm run local:gateway   # Gateway API
```

## Project Structure

### Microservices (`apps/`)

| Service | Port | Description |
|---------|------|-------------|
| gateway-api | 3000 | GraphQL Federation Gateway |
| auth-service | 3001 | Authentication & JWT tokens |
| farm-service | 3002 | Farm, Site, Batch management |
| sensor-service | 3003 | IoT data ingestion & MQTT |
| alert-engine | 3004 | Real-time alerting rules |
| hr-service | 3005 | Employee & attendance |
| billing-service | 3006 | Subscriptions & invoices |
| notification-service | 3007 | Email, SMS, Push notifications |
| admin-api-service | 3010 | Super admin operations |

### Web Applications (`web/`)

| Module | Port | Description |
|--------|------|-------------|
| shell | 5173 | Main application shell |
| dashboard | 5001 | Overview & widgets |
| farm-module | 5002 | Farm management UI |
| hr-module | 5003 | HR management UI |
| sensor-module | 5004 | Sensor monitoring UI |
| admin-panel | 5005 | Administration UI |
| tenant-admin | 5006 | Tenant management UI |

## Scripts Reference

### Development
| Command | Description |
|---------|-------------|
| `npm run dev` | Start all services |
| `npm run dev:backend` | Start backend services only |
| `npm run dev:web` | Start web applications only |

### Building
| Command | Description |
|---------|-------------|
| `npm run build` | Build affected projects |
| `npm run build:all` | Build all projects |
| `npm run build:web` | Build web applications |

### Docker
| Command | Description |
|---------|-------------|
| `npm run docker:fast` | Fast Docker build |
| `npm run docker:affected` | Build affected services |
| `npm run docker:up` | Start containers |
| `npm run docker:up:watch` | Start with hot reload |
| `npm run docker:down` | Stop containers |
| `npm run docker:logs` | View logs |
| `npm run infra:up` | Start infrastructure only |
| `npm run infra:down` | Stop infrastructure |

### Testing
| Command | Description |
|---------|-------------|
| `npm run test` | Run affected tests |
| `npm run test:all` | Run all tests |
| `npm run lint` | Lint affected projects |
| `npm run lint:all` | Lint all projects |

## Environment Variables

Create `.env` file in root directory:

```env
# Database
DATABASE_URL=postgres://aquaculture:devpassword@localhost:5432/aquaculture

# Redis
REDIS_URL=redis://:devpassword@localhost:6379

# NATS
NATS_URL=nats://localhost:4222

# JWT
JWT_SECRET=your-secret-key

# Services
AUTH_SERVICE_URL=http://localhost:3001/graphql
FARM_SERVICE_URL=http://localhost:3002/graphql
SENSOR_SERVICE_URL=http://localhost:3003/graphql
```

## API Documentation

### GraphQL Playground
- Gateway: http://localhost:3000/graphql
- Auth Service: http://localhost:3001/graphql
- Farm Service: http://localhost:3002/graphql

### Health Checks
All services expose health endpoints:
- `/health/live` - Liveness probe
- `/health/ready` - Readiness probe

## Contributing

1. Follow the coding standards in `.eslintrc.json` and `.prettierrc`
2. Write tests for new features
3. Run `npm run lint` and `npm run test` before committing
4. Update documentation as needed

## Recent Updates (v1.2.0)

### Security Hardening

**Authorization & Access Control**
- Global `RolesGuard` enforcement across all microservices
- Role-based access control (RBAC) on all mutations
- JWT-only tenant/user verification (removed header-based trust)
- IDOR protection on self-service operations (clock-in/out, leave requests, training enrollment)

**GraphQL Security**
- Query depth limiting (max 10 levels) to prevent DoS attacks
- Query complexity limiting (max 1000) to prevent resource exhaustion
- Introspection disabled in production

**Tenant Isolation**
- All database queries enforce `tenantId` filtering
- Cross-tenant data access prevention
- Defense-in-depth on all data operations

**Input Validation**
- Comprehensive DTO validation with class-validator
- Coordinate validation (lat/long bounds)
- Date format validation (ISO 8601)
- Numeric bounds on financial and time fields
- Enum validation on categorical fields

**Transaction Safety**
- ACID transactions on all state-changing operations
- Proper rollback handling on errors
- Race condition prevention on unique constraints

**Error Handling**
- PII removal from error messages
- Consistent error logging with stack traces
- Generic error responses to prevent information leakage

---

## Previous Updates (v1.1.0)

### Backend Enhancements

**Scheduler Module**
- Added `SchedulerModule` with cron job support for automated tasks
- `CronJobsService` for scheduled maintenance and alert generation
- `FeedingSchedulerService` for automated feeding schedule management
- Integration with `@nestjs/schedule` and `EventEmitter2`

**Maintenance Module**
- Complete CRUD operations for Work Orders, Maintenance Schedules, and Spare Parts
- GraphQL resolvers with tenant isolation
- Stock movement tracking for spare parts inventory
- Automated work order generation from maintenance schedules

**Sensor Enhancements**
- Extended `SensorType` enum with: `FLOW_RATE`, `CONDUCTIVITY`, `ORP`, `CHLORINE`, `CO2`
- Unified `SensorStatus` across all services: `active`, `inactive`, `maintenance`, `error`, `offline`

**User Entity Extensions**
- Added profile fields: `profileImageUrl`, `phoneNumber`, `preferredLanguage`
- MFA support: `mfaEnabled`, `mfaSecret`

### Frontend Enhancements

**Maintenance Management Pages**
- `WorkOrdersPage` - Full CRUD with status management, filtering, and statistics
- `MaintenanceSchedulesPage` - Schedule management with pause/resume functionality
- `SparePartsPage` - Inventory management with stock movement tracking

**React Hooks**
- `useWorkOrders`, `useCreateWorkOrder`, `useUpdateWorkOrder`, `useDeleteWorkOrder`
- `useMaintenanceSchedules`, `useCreateMaintenanceSchedule`, `useUpdateMaintenanceSchedule`, `useDeleteMaintenanceSchedule`
- `useSpareParts`, `useCreateSparePart`, `useUpdateSparePart`, `useDeleteSparePart`
- `useStockSummary`, `useLowStockAlerts`, `useRecordStockMovement`

**Type Consistency**
- Synchronized `SensorType` across `shared-ui`, `scadaStore`, and `AlertRuleBuilder`
- Updated `SENSOR_TYPE_OPTIONS` with Turkish labels and units
- Aligned `SensorStatus` with backend enum values

### Architecture Improvements
- Multi-tenant support with `tenantId` in all GraphQL queries
- Proper entity exports from maintenance module
- Event-driven maintenance scheduling

## License

**PROPRIETARY SOFTWARE - ALL RIGHTS RESERVED**

This software is proprietary and confidential. Unauthorized copying, distribution, modification, or use of this software is strictly prohibited. See [LICENSE](./LICENSE) file for details.
