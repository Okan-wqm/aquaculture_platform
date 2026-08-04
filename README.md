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

| Command                               | Description                       | Speed            |
| ------------------------------------- | --------------------------------- | ---------------- |
| `npm run docker:fast`                 | Pre-build + parallel Docker build | **~3-5 min**     |
| `npm run docker:affected`             | Build only changed services       | **~1-3 min**     |
| `npm run docker:up:watch`             | Hot-reload development mode       | **Instant sync** |
| `npm run docker:build`                | Full Docker build (slow)          | ~20+ min         |
| `npm run docker:build:backend:simple` | Pre-built artifacts approach      | ~3 min           |

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

| Workflow                  | Trigger                        | Description                                 |
| ------------------------- | ------------------------------ | ------------------------------------------- |
| `deploy-digitalocean.yml` | Push to `main`                 | Production deployment with pre-built images |
| `cd-staging.yml`          | Push to `develop`, `feature/*` | Staging environment deployment              |
| `cd-production.yml`       | Tag `v*.*.*`                   | Production release with security scan       |

### Build Performance

| Method                                    | Build Time   | Cache     |
| ----------------------------------------- | ------------ | --------- |
| Legacy (rebuild on server)                | ~25-30 min   | None      |
| **Optimized (parallel + registry cache)** | **~5-8 min** | Unlimited |
| Incremental (affected only)               | ~2-4 min     | Unlimited |

### Required GitHub Secrets

```yaml
# Nx Cloud (free tier)
NX_CLOUD_ACCESS_TOKEN: 'your-nx-cloud-token'

# DigitalOcean Deployment
DROPLET_HOST: 'your-droplet-ip'
DROPLET_USER: 'root'
DROPLET_SSH_KEY: 'your-ssh-private-key'

# Kubernetes (optional - for cd-production.yml)
KUBE_CONFIG_STAGING: 'base64-encoded-kubeconfig'
KUBE_CONFIG_PRODUCTION: 'base64-encoded-kubeconfig'

# Notifications (optional)
SLACK_WEBHOOK_URL: 'your-slack-webhook'
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

| Service              | Port | Description                    |
| -------------------- | ---- | ------------------------------ |
| gateway-api          | 3000 | GraphQL Federation Gateway     |
| auth-service         | 3001 | Authentication & JWT tokens    |
| farm-service         | 3002 | Farm, Site, Batch management   |
| sensor-service       | 3003 | IoT data ingestion & MQTT      |
| alert-engine         | 3004 | Real-time alerting rules       |
| hr-service           | 3005 | Employee & attendance          |
| billing-service      | 3006 | Subscriptions & invoices       |
| notification-service | 3007 | Email, SMS, Push notifications |
| admin-api-service    | 3010 | Super admin operations         |

### Web Applications (`web/`)

| Module        | Port | Description            |
| ------------- | ---- | ---------------------- |
| shell         | 5173 | Main application shell |
| dashboard     | 5001 | Overview & widgets     |
| farm-module   | 5002 | Farm management UI     |
| hr-module     | 5003 | HR management UI       |
| sensor-module | 5004 | Sensor monitoring UI   |
| admin-panel   | 5005 | Administration UI      |
| tenant-admin  | 5006 | Tenant management UI   |

## Scripts Reference

### Development

| Command               | Description                 |
| --------------------- | --------------------------- |
| `npm run dev`         | Start all services          |
| `npm run dev:backend` | Start backend services only |
| `npm run dev:web`     | Start web applications only |

### Building

| Command             | Description             |
| ------------------- | ----------------------- |
| `npm run build`     | Build affected projects |
| `npm run build:all` | Build all projects      |
| `npm run build:web` | Build web applications  |

### Docker

| Command                   | Description               |
| ------------------------- | ------------------------- |
| `npm run docker:fast`     | Fast Docker build         |
| `npm run docker:affected` | Build affected services   |
| `npm run docker:up`       | Start containers          |
| `npm run docker:up:watch` | Start with hot reload     |
| `npm run docker:down`     | Stop containers           |
| `npm run docker:logs`     | View logs                 |
| `npm run infra:up`        | Start infrastructure only |
| `npm run infra:down`      | Stop infrastructure       |

### Testing

| Command            | Description            |
| ------------------ | ---------------------- |
| `npm run test`     | Run affected tests     |
| `npm run test:all` | Run all tests          |
| `npm run lint`     | Lint affected projects |
| `npm run lint:all` | Lint all projects      |

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

## Recent Updates (v1.5.0)

### Site Environmental Monitoring

**Farm Service**

- Site-scoped MET Norway forecasts and Frost station observations with provider provenance
- Regional Copernicus Marine model analysis/forecast values for waves, currents, temperature, salinity, dissolved oxygen, and model chlorophyll
- Exact CDSE Sentinel-2 acquisition metadata and authorized site-bound imagery
- Append-only canonical observations, bounded provider leases, a 15-minute scheduler, and 45-day retention
- Company-owned provider credentials in config-service; tenant browsers never receive or configure them

**Farm Module**

- One tenant-scoped Environment panel for current values, 7/30-day history, 7-day forecasts, and exact Sentinel-2 scenes
- Authorized SEA_CAGE site selection with complete paginated site loading
- Backend-owned scientific labels, units, provenance, quality, and availability states
- Explicit distinction between marine model output, satellite optical indicators, and on-site sensor measurements

### Water Chemistry Calculator (New)

**Farm Module - Advanced Water Chemistry**

- Full aquaculture water chemistry calculator (ported from Python PyQt5 scientific application)
- Millero thermodynamic equations for carbonate system calculations
- Deffeyes diagram visualization with pH-alkalinity isolines, toxic zones, safe zones, and reagent paths
- Un-ionized Ammonia (UIA) calculator with pH-dependent safety zones (Safe/Alert/Danger)
- H₂S / HS⁻ speciation vs pH with toxic thresholds
- CO₂ / HCO₃⁻ / CO₃²⁻ distribution charts
- Calcite & Aragonite saturation indices (Mucci 1983)
- Chemical dosing recipes for multiple reagents (Sodium Bicarbonate, NaOH, CO₂, etc.)
- Real-time calculations with adjustable inputs (temperature, pH, salinity, alkalinity, TAN, H₂S)
- Print report function with formatted output containing all charts and parameters

### Mobile App (AquaMobil) Overhaul

**Auth Service - Mobile Settings & Permissions**

- Mobile user settings entity with feature flags (mortality, cull, harvest, feeding, waterQuality, tankView)
- GraphQL endpoints for querying and managing mobile permissions (individual + bulk admin updates)
- Default configuration management per tenant

**AquaMobil PWA Enhancements**

- PWA install prompt for iOS (manual instructions) and Android/Chrome (native prompt)
- Mobile permissions system with IndexedDB offline caching
- Employee schedule page with week navigation, shift details, work hours summary, overtime display
- Redesigned UI with improved Tailwind configuration and mobile-optimized components
- Enhanced login page, home page, and record pages (mortality, cull, harvest)

### Company & Regulatory Management

**Farm Module - Company Page**

- Standalone company information management page
- Organisation number, address, and regulatory details
- Integrated with RegulatorySettings backend entity

**Report Settings Modal**

- Norwegian regulatory reporting configuration (Maskinporten OAuth2 integration)
- Default contact information management
- Site to Lokalitetsnummer (Norwegian locality code) mappings
- Slaughter facility approval number
- Connection test and status dashboard

### Backend & Infrastructure Improvements

**Feed Intelligence Enhancements**

- Enhanced feed selector service with improved scoring algorithms
- Feed consumption forecast service improvements
- Growth simulator updates for better prediction accuracy
- Feeding program entity and service refinements

**Process & Sensor Service**

- Process entity enhancements with additional fields
- Process service improvements
- Node components library updates (20+ aquaculture equipment nodes redesigned)
- Orthogonal and draggable edge improvements for process editor

**HR Module**

- Scheduling settings page with comprehensive configuration UI
- Weekly schedule page overhaul with improved UX
- GraphQL operations and hooks updates across all HR features

**Tenant Administration**

- Tenant settings page expansion with new configuration options
- Tenant users management improvements
- Edge device detail page updates

**Infrastructure**

- Docker Compose configuration updates
- Dockerfile optimizations for backend and AquaMobil
- Nginx configuration improvements for shell and AquaMobil
- Schema manager service updates for canonical environmental observation tables
- Shared UI utilities (api-client, graphql-utils) refinements
- Vite config updates across all frontend modules

---

## Previous Updates (v1.4.1)

### New Modules & Major Features

**Farm Service - Consumable Management Module (New)**

- Full CQRS module: commands, queries, handlers, resolver, DTOs, entities
- Consumable inventory tracking with category and supplier management

**Farm Service - Storage Management Module (New)**

- Complete storage module with locations, inventory tracking, and stock movements
- Purchase order management with create/receive delivery workflows
- Database migrations: storage management tables, purchase orders

**Farm Service - Worker Management Module (New)**

- Worker registry with resolver, handlers, DTOs, and entities
- Worker assignment and role tracking

**Farm Service - Feed & Chemical Enhancements**

- Feed entity: added `minFishWeight` field with migration
- Enhanced feed DTOs and handlers (create/update) with improved validation
- Chemical entity and DTO refinements
- Feeding module: new Protocols tab, updated resolvers

**HR Service - Employee Enhancements**

- New employee fields in entity and create DTO
- Updated HR resolver with additional query/mutation support
- Employee GraphQL operations and fragments updated on frontend

**Frontend - Storage Page Overhaul**

- Redesigned storage tabs: Feed Stock, Chemicals Stock, Consumables Stock, Healthcare Stock
- New Purchase Orders tab with CreatePurchaseOrderModal and ReceiveDeliveryModal
- Improved Overview, Stock Movements, Storage Locations, and Inventory Count tabs

**Frontend - New Hooks & Pages**

- New hooks: `useConsumables`, `usePurchaseOrders`, `useStorageInventory`, `useStorageLocations`, `useTenantUsers`, `useWorkers`
- Workers setup tab in farm setup page
- Feeding Protocols tab component
- Enhanced task management: AllTasksTab, TodayTab, TaskFormModal improvements
- Updated Chemicals, Consumables, and Feeds setup tabs

**Frontend - Production Page Cleanup**

- Removed legacy ProductionPage and related components (HarvestModal, FeedingTab, TankOperationsTab)
- Consolidated functionality into dedicated pages

**Infrastructure & Scripts**

- Database migrations for feed min fish weight, storage management, purchase orders
- Seed scripts: `seed-feeds.js`, `update-feeds-max-weight.js`
- Schema manager updates in backend-common
- Docker Compose configuration updates
- Updated package dependencies

---

## Previous Updates (v1.4.0)

### Platform-Wide Enhancements

**Admin API Service - Auth & Billing Improvements**

- Password reset module with dedicated controller and service
- Enhanced billing services: invoice management, pricing calculator, subscription plan changes
- Improved subscription renewal and module pricing logic
- Strengthened platform admin guard and IP access controls
- Schema management service improvements for multi-tenant databases
- Enhanced user management with updated controller, module, and service layer

**Sensor Service - Edge Device & Automation Expansion**

- Edge device self-registration with tenant provisioning keys
- Device event tracking entity for comprehensive audit trails
- Automation deployment log service for program lifecycle management
- Enhanced MQTT listener and ingestion pipeline
- Improved tenant-schema middleware for sensor data isolation
- VFD brand configuration refinements (ABB, Danfoss, Delta, Mitsubishi, Rockwell, Schneider, Siemens, Yaskawa)
- VFD types and enums consolidation
- PLC control DTO and telemetry improvements

**Farm Service - Equipment & Feeding Enhancements**

- Equipment service layer with dedicated business logic
- Enhanced equipment CQRS handlers (create, update, delete, list)
- Improved feeding table DTOs with better validation
- Equipment type seed data updates
- Regulatory settings entity refinements

**HR Service - Entity Standardization**

- Standardized column naming across all HR entities (explicit snake_case mappings)
- Updated entities: employee, payroll, attendance, schedule, shift, leave, training
- Aquaculture-specific entities: safety training records, work areas, work rotations
- Scheduling entities: holidays, weekly plans, scheduling settings

**Frontend - New Pages & UI Improvements**

- **Storage Management Page** - Inventory tracking with warehouse management
- **Task Management Page** - Task creation, assignment, and tracking
- **Edge Device Management** - Device listing, detail view, and installer key provisioning
- **Consumables Tab** - Consumable inventory management in farm setup
- **Fish Health Chemicals Tab** - Chemical tracking for fish health treatments
- Enhanced login page with improved UX
- Updated setup page with additional configuration tabs (Chemicals, Departments, Equipment, Feeds, Systems)
- Improved report tabs: Biomass, Cleaner Fish, Disease Outbreak, Escape, Sea Lice, Slaughter, Smolt, Welfare Events
- Enhanced admin panel: analytics dashboard, billing dashboard, system settings
- Tenant admin sidebar improvements with device management navigation

**Infrastructure & Common Libraries**

- Schema manager service updates for new entity tables
- Billing tables SQL migration scripts
- Module pricing seed data
- Docker Compose dev configuration updates
- Prebuilt Dockerfile optimizations
- Edge gateway self-registration flow documentation

---

## Previous Updates (v1.3.0)

### Major Platform Enhancements

**Farm Service - Sub-Equipment Management**

- Full CQRS implementation for sub-equipment (pumps, filters, valves, etc.)
- Hierarchical equipment structure (parent-child relationships)
- Sub-equipment types with customizable attributes
- Commands: `CreateSubEquipment`, `UpdateSubEquipment`, `DeleteSubEquipment`
- Queries: `GetSubEquipment`, `ListSubEquipment`, `GetSubEquipmentTypes`

**Farm Service - Feeding Protocol System**

- Complete feeding protocol management with scheduling support
- Multi-species feeding configurations
- Time-based and condition-based feeding triggers
- Protocol templates for common feeding patterns
- Integration with batch and tank assignments

**Farm Service - Fish Health Events**

- Health event tracking and management
- Disease outbreak monitoring
- Treatment recording and tracking
- Mortality event logging with cause analysis
- Health status dashboard integration

**Farm Service - Harvest Planning**

- Harvest plan creation with multi-batch support
- Planned vs actual harvest tracking
- Quality grading integration
- Logistics coordination features
- Regulatory compliance documentation

**Sensor Service - PLC Control Module**

- Complete PLC integration layer with DTOs, resolvers, and services
- PLC connection management (Siemens S7, Modbus, OPC-UA ready)
- PLC alarm monitoring and alerting
- PLC telemetry data collection
- Feeding parameter control via PLC

**Sensor Service - Automation Programs**

- Visual automation program editor (workflow builder)
- Step-based program execution
- Conditional transitions between steps
- Variable management within programs
- Action configuration (sensor triggers, PLC commands, notifications)

**Sensor Service - VFD Improvements**

- Enhanced VFD filtering with multiple criteria
- Better validation and error handling
- Improved command execution feedback
- Reading history with aggregation support

**Auth Service - GDPR Compliance Module**

- User consent management (tracking, versioning, withdrawal)
- Data export functionality (user data portability)
- Data anonymization for deleted accounts
- Consent audit logging
- Right to be forgotten implementation

**Frontend - New Pages**

- Automation Programs page with visual workflow editor
- Automation Program Editor with drag-and-drop steps
- Health Events management interface
- Harvest Planning page with calendar view
- Enhanced Tenant Database explorer

**Infrastructure**

- Pagination utilities in backend-common library
- Schema manager improvements for tenant isolation
- Enhanced resolver security across all services
- Improved tenant-schema middleware

---

## Previous Updates (v1.2.0)

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
