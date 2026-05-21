# Platform Admin Shared UI Singleton Review

Date: 2026-05-21

Scope: live droplet `/admin` access failure for platform admin `by-okan@live.com`, shell host, admin-panel remote, and shared-ui runtime context boundaries.

## ADMIN-HIGH-002 — Shared UI source deep imports split Auth/Tenant contexts under Module Federation

The live account was valid platform admin (`SUPER_ADMIN`, `accessType=BOTH`, `tenantId=NULL`), and auth-service logged a successful login. The browser failure was a frontend runtime crash:

```text
useTenantContext must be used within a TenantProvider
```

Root cause: shell/admin runtime code consumed shared-ui through relative `shared-ui/src/...` imports while the shell bootstrap provided `AuthProvider` and `TenantProvider` through the federated `@aquaculture/shared-ui` package identity. Under Module Federation this creates a second module identity for React contexts: providers write to one context instance and hooks read another.

Required fix: runtime code in shell/remotes must import shared-ui only through the public `@aquaculture/shared-ui` entrypoint. Root TypeScript path resolution and Nx module-boundary policy must explicitly model that package as the singleton identity, and a CI invariant must reject future deep source imports from federated runtime code.
