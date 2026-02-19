---
name: shared-ui
description: Knowledge base for the shared-ui frontend library
---

# Shared UI Knowledge Base

## Overview

`@aquaculture/shared-ui` is the internal shared component library consumed by all frontend modules (shell, dashboard, farm-module, hr-module, sensor-module, tenant-admin, admin-panel, hydroponics-module). It provides: authentication context, tenant context, API client (GraphQL + REST), shared components (Button, Input, Modal, Table, Charts, Form, etc.), shared hooks (`useAuth`, `useTenant`, `useGraphQL`), formatting utilities, and Tailwind theme configuration.

## Directory Structure

```
web/shared-ui/src/
  index.ts                        # Main barrel export
  styles/
    theme.ts                      # Tailwind theme tokens (colors, spacing, etc.)
  contexts/
    AuthContext.tsx                # AuthProvider + useAuthContext hook (full implementation)
    TenantContext.tsx              # TenantProvider + useTenantContext hook
  hooks/
    useAuth.ts                    # Simpler auth hook: { token, tenantId }
    useTenant.ts                  # Tenant context hook
    useGraphQL.ts                 # GraphQL fetch hook wrapper
    index.ts
  utils/
    api-client.ts                 # GraphQLClient + RestClient singletons
    graphql-utils.ts              # GraphQL helpers
    date-utils.ts                 # Date formatting utilities
    validation.ts                 # Field validator functions
    format.ts                     # Number/currency/weight formatters
    error-types.ts                # Error type definitions
    specificationValidation.ts    # Equipment spec validation
    index.ts
  components/
    Alert/
      Alert.tsx                   # Alert/notification banner
      index.ts
    ApiError/
      ApiError.tsx                # API error display component
      index.ts
    Button/
      Button.tsx                  # Primary button component
      index.ts
    Card/
      Card.tsx                    # Content card container
      index.ts
    Charts/
      ChartContainer.tsx          # Recharts wrapper with responsive container
      ChartTooltip.tsx            # Custom tooltip component
      ChartLegend.tsx             # Custom legend component
      AreaChart.tsx               # Area chart (Recharts)
      LineChart.tsx               # Line chart (Recharts)
      BarChart.tsx                # Bar chart (Recharts)
      PieChart.tsx                # Pie chart (Recharts)
      DonutChart.tsx              # Donut chart (Recharts)
      SparklineChart.tsx          # Mini sparkline chart
      index.ts
    DataTable/
      DataTable.tsx               # Sortable/filterable data table
      index.ts
    Form/
      Input.tsx                   # Text input with label + error
      Select.tsx                  # Select dropdown
      MultiSelect.tsx             # Multi-select dropdown
      Checkbox.tsx                # Checkbox input
      NumberInput.tsx             # Numeric input with validation
      DatePicker.tsx              # Single date picker
      DateRangePicker.tsx         # Date range picker
      FileUpload.tsx              # File upload input
      SearchInput.tsx             # Search input with debounce
      FormField.tsx               # Form field wrapper with label/error/hint
      DynamicSpecificationForm.tsx # JSON-schema-driven spec form (for equipment)
      index.ts
    KpiCard/
      KpiCard.tsx                 # KPI metric display card
      index.ts
    Layout/
      Header.tsx                  # App header with user menu + notifications
      Sidebar.tsx                 # Collapsible sidebar with nav items
      index.ts
    Loading/
      Loading.tsx                 # Loading spinner component
      index.ts
    Modal/
      Modal.tsx                   # Dialog modal with overlay
      DeleteConfirmationDialog.tsx # Confirm-delete modal
      index.ts
    Table/
      Table.tsx                   # HTML table component
      index.ts
    ConfiguredBrowserRouter.tsx   # BrowserRouter with base path config
    index.ts
  types/
    index.ts                      # Shared type exports (NavigationItem, SidebarTheme, HeaderTheme, etc.)
```

## Key Components

### AuthContext (`contexts/AuthContext.tsx`)
Full implementation — see `shell.md` for complete details.

Exports:
- `AuthProvider` — wraps app with auth state
- `useAuthContext()` — safe hook with MF fallback (decodes JWT when context unavailable)
- Types: `UserRole`, `UserModule`, `AuthUser`, `AuthContextValue`

### TenantContext (`contexts/TenantContext.tsx`)
- `TenantProvider` — fetches and provides tenant data
- `useTenantContext()` — returns `{ tenant, isLoading }`

### API Client (`utils/api-client.ts`)
Two singleton clients:

**GraphQLClient** (`graphqlClient`):
- All requests to `VITE_GRAPHQL_URL || '/graphql'`
- Auto-attaches `Authorization: Bearer <token>` from memory + localStorage fallback (MF compatible)
- Auto-attaches `X-Tenant-Id` header from memory + localStorage
- Adds `X-Request-Id` for tracing
- 401 handling: auto-refreshes token via `POST /api/auth/refresh`, then retries once
- 30 second default timeout
- Throws `GraphQLClientError` on GraphQL errors or network errors

**RestClient** (`restClient`):
- All requests to `VITE_API_URL || '/api'`
- Same auth header injection
- Shorthand methods: `.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`

Token management functions (exported):
- `setTokens(access, refresh)` — stores to memory + localStorage
- `clearTokens()` — clears memory + localStorage
- `loadTokensFromStorage()` — reads from localStorage into memory
- `getAccessToken()` — returns current access token
- `setTenantId(id)` / `getTenantId()` — tenant ID management

### Hooks

**`useAuth()`** (`hooks/useAuth.ts`):
- Simple hook returning `{ token: string|null, tenantId: string|null, isAuthenticated: boolean }`
- Used by farm-module and other modules for simple auth checks in data fetching hooks

**`useTenant()`** (`hooks/useTenant.ts`):
- Returns `{ tenant, isLoading }` from TenantContext

**`useGraphQL()`** (`hooks/useGraphQL.ts`):
- Thin wrapper around `graphqlClient.request()`

### Components

**Button** (`Button.tsx`):
- Props: `variant` (`primary`|`secondary`|`outline`|`ghost`|`danger`), `size` (`sm`|`md`|`lg`), `loading`, `disabled`, `fullWidth`, `type`

**Input** (`Form/Input.tsx`):
- Props: `label`, `error`, `hint`, `type`, `required`, standard HTML input props

**Modal** (`Modal/Modal.tsx`):
- Overlay portal modal with close button, title, children
- `DeleteConfirmationDialog` wraps Modal for delete confirmation pattern

**Sidebar** (`Layout/Sidebar.tsx`):
- Props: `items: NavigationItem[]`, `activePath: string`, `collapsed: boolean`, `onNavigate`, `onCollapsedChange`, `theme: SidebarTheme`, `logo`
- `NavigationItem`: `{ id, label, path, icon, children?: NavigationItem[] }`
- `SidebarTheme`: `'default' | 'admin' | 'tenant'`
- Supports nested nav with expand/collapse

**Header** (`Layout/Header.tsx`):
- Props: `user`, `tenant`, `onSearch`, `notificationCount`, `onNotificationsClick`, `userMenuItems`, `onLogout`, `theme: HeaderTheme`, `leftContent`
- `HeaderTheme`: `'default' | 'admin' | 'tenant'`

**Charts** (all from `recharts`):
- `ChartContainer` wraps `ResponsiveContainer`
- `AreaChart`, `LineChart`, `BarChart`, `PieChart`, `DonutChart`, `SparklineChart` — pre-styled Recharts wrappers
- `ChartTooltip` — custom tooltip with themed styling
- `ChartLegend` — custom legend

**DataTable**:
- Sortable columns, optional filtering, pagination
- Props: `data`, `columns`, `loading`, `onSort`, `onFilter`

**KpiCard**:
- Title, value, optional trend %, icon, description

**DynamicSpecificationForm**:
- Renders a form from a JSON specification schema (used for equipment specs)
- Validates using `specificationValidation.ts`

## Utilities

### `validation.ts`
Validator factory functions:
- `required()` — checks non-empty
- `email()` — email format check
- `minLength(n)` — minimum length
- `maxLength(n)` — maximum length
- `validateField(value, validators[])` — returns `{ valid: boolean, error?: string }`

### `format.ts`
- `formatNumber(value, decimals?)` — locale number formatting
- `formatCurrency(value, currency?)` — currency formatting
- `formatWeight(kg)` — kg/ton formatting
- `formatPercent(value)` — percentage formatting

### `date-utils.ts`
- `formatRelativeTime(date)` — "2 hours ago" style
- `formatDate(date, format?)` — date formatting
- `isToday(date)`, `isFuture(date)`, `isPast(date)`

### `error-types.ts`
Error type union for UI error display.

### `graphql-utils.ts`
Helpers for extracting error messages from GraphQL error responses.

## Theme (`styles/theme.ts`)
Tailwind-compatible theme tokens:
- Color palette: `aqua` (primary blue), `success`, `warning`, `danger`, `neutral`
- Spacing, font sizes, border radii matching the design system

## Known Gotchas

- `useAuthContext()` has a **Module Federation fallback** — when called inside a remote module without the AuthProvider in scope, it decodes the JWT from `localStorage`. The fallback always returns `hasModuleAccess() = true`.
- `graphqlClient` reads tokens from **both** module-level variable AND `localStorage` on every request. This is intentional for MF cross-boundary compatibility.
- `getTenantId()` reads from memory first, then localStorage — caches on first read. If tenant changes without reload, memory value persists.
- Validation functions (`required()`, `email()`, etc.) return factory functions — call them as `required()` not `required`.
- `DynamicSpecificationForm` requires a specific JSON schema format — see `specificationValidation.ts` for the schema type.
- The `ConfiguredBrowserRouter` sets the basename — needed for the shell's routing to work correctly at different base paths.
- `Sidebar` items with `path: ''` (empty string) act as dividers/headers — they receive no click handler.
- Chart components require `recharts` to be installed in the consuming module — it's a peer dependency.
- Some components export from both `components/ComponentName/index.ts` AND from `components/index.ts` — use the main `@aquaculture/shared-ui` import path.

## Related Backend Services

- **auth-service** — AuthContext login/logout/me queries
- **gateway-api** — all GraphQL requests route through here
- All modules consume this library — changes here affect every frontend module
