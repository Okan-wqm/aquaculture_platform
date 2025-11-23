# Aquaculture Platform - Enterprise IoT & Process Management System

## Overview

Enterprise-grade aquaculture management platform built with microservices architecture, event-driven design, and microfrontend patterns. The system provides real-time monitoring, process automation, HR management, billing, and analytics for aquaculture operations.

## Architecture

### Technology Stack

**Backend:**
- NestJS microservices with CQRS/Event Sourcing
- PostgreSQL, MongoDB, Redis, TimescaleDB
- RabbitMQ for event bus
- Temporal for workflow orchestration
- gRPC and REST APIs

**Frontend:**
- React 18 with TypeScript
- Module Federation for microfrontends
- TanStack Query for state management
- Tailwind CSS for styling

**Infrastructure:**
- Kubernetes orchestration
- Terraform for IaC
- ArgoCD for GitOps
- Prometheus + Grafana + Loki observability stack
- Keycloak for authentication

### Monorepo Structure

```
aquaculture-platform/
├── apps/              # Microservices
├── web/               # Microfrontend applications
├── platform/libs/     # Shared platform libraries
├── libs/              # Common libraries
├── infra/             # Infrastructure as Code
├── database/          # Database migrations
├── docs/              # Documentation
└── tools/             # Development tools
```

## Getting Started

### Prerequisites

- Node.js 20.11.0 (LTS) - use `nvm use` to automatically switch
- Docker & Docker Compose
- Kubernetes (minikube or kind for local development)
- Terraform >= 1.6.0

### Installation

```bash
# Install dependencies
npm install

# Verify workspace setup
nx list

# Build all projects
npm run build:all

# Run tests
npm run test:all

# Lint code
npm run lint:all
```

### Local Development

```bash
# Start all services in development mode
npm run dev

# Start specific microservice
nx serve gateway-api

# Start web shell application
nx serve web-shell

# Run affected tests (only changed projects)
nx affected:test

# View dependency graph
npm run graph
```

### Docker Development

```bash
# Start infrastructure services (databases, message queue, etc.)
docker-compose -f docker/docker-compose.infra.yml up -d

# Start all application services
docker-compose -f docker/docker-compose.dev.yml up -d

# View logs
docker-compose logs -f
```

## Project Structure

### Microservices (`apps/`)

- **gateway-api** - API Gateway with GraphQL Federation
- **auth-service** - Authentication & authorization
- **farm-service** - Farm and facility management
- **sensor-service** - IoT sensor data ingestion
- **alert-engine** - Real-time alerting system
- **hr-service** - Human resources management
- **billing-service** - Billing and invoicing
- **notification-service** - Multi-channel notifications
- **config-service** - Centralized configuration
- **observability-service** - Metrics and monitoring
- **event-store-service** - Event sourcing store
- **admin-api-service** - Admin operations API

### Web Applications (`web/`)

- **shell** - Main application shell (Module Federation host)
- **modules/dashboard** - Dashboard module
- **modules/process-editor** - BPMN process editor
- **modules/admin-panel** - Administration interface
- **modules/farm-module** - Farm management UI
- **modules/hr-module** - HR management UI
- **modules/billing-module** - Billing management UI
- **shared-ui** - Shared UI components

### Platform Libraries (`platform/libs/`)

- **event-bus** - Event bus abstraction
- **cqrs** - CQRS infrastructure
- **domain** - Domain-driven design building blocks
- **shared-dtos** - Shared data transfer objects
- **validation** - Validation utilities
- **telemetry** - OpenTelemetry integration
- **observability** - Logging and monitoring
- **security** - Security utilities
- **temporal-workflows** - Temporal workflow definitions

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start all services in development mode |
| `npm run build` | Build current project |
| `npm run build:all` | Build all projects |
| `npm run test` | Run tests for current project |
| `npm run test:all` | Run all tests |
| `npm run lint` | Lint current project |
| `npm run lint:all` | Lint all projects |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check code formatting |
| `npm run type-check` | Run TypeScript type checking |
| `npm run graph` | View project dependency graph |
| `npm run affected:graph` | View affected projects graph |

## Development Workflow

1. **Feature Development**
   ```bash
   git checkout -b feature/your-feature
   # Make changes
   npm run lint
   npm run test
   npm run type-check
   git commit -m "feat: your feature description"
   ```

2. **Testing Changes**
   ```bash
   # Test affected projects
   nx affected:test
   
   # Test specific project
   nx test project-name
   ```

3. **Building for Production**
   ```bash
   # Build affected projects
   nx affected:build --prod
   
   # Build all projects
   npm run build:all
   ```

## Documentation

- [Architecture Overview](./docs/architecture/overview.md)
- [API Documentation](./docs/api/README.md)
- [Event Contracts](./docs/events/README.md)
- [Security Guidelines](./docs/security/README.md)
- [Developer Onboarding](./docs/onboarding/developer-setup.md)
- [Deployment Guide](./docs/deployment/README.md)

## Testing

```bash
# Unit tests
npm run test

# E2E tests
nx e2e project-name-e2e

# Coverage report
nx test project-name --coverage

# Watch mode
nx test project-name --watch
```

## Deployment

The platform uses GitOps with ArgoCD for continuous deployment.

```bash
# Deploy to development
kubectl apply -k infra/kubernetes/overlays/dev

# Deploy to production
kubectl apply -k infra/kubernetes/overlays/prod
```

See [Deployment Guide](./docs/deployment/README.md) for detailed instructions.

## Contributing

1. Follow the coding standards defined in `.eslintrc.json` and `.prettierrc`
2. Write tests for new features
3. Update documentation as needed
4. Ensure all checks pass before submitting PR

## License

MIT License - see [LICENSE](./LICENSE) file for details

## Support

For questions and support, please refer to the [documentation](./docs) or contact the development team.