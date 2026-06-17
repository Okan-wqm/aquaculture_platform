# Superadmin auth context bridge

**Date:** 2026-06-17 · **Agent:** frontend-expert · **Cycle:** 2026-06-17-superadmin-auth-context-bridge

## FE-MEDIUM-059 — Admin remotes fail closed when shared AuthContext is bypassed by federation aliasing

**State:** OPEN -> RESOLVED by this PR.

### Finding
Production logs showed a successful `SUPER_ADMIN` login followed by a frontend redirect
to `/unauthorized`. The backend returned GraphQL 200 responses and the user record was
active with `role=SUPER_ADMIN`, but the admin remote evaluated its own `useAuthContext`
fallback with `user=null`.

The root cause is the existing Module Federation alias warning for
`@aquaculture/shared-ui`: remotes can load a separate shared-ui/AuthContext instance,
so the shell `AuthProvider` is not always the React context instance the remote reads.
The previous fallback intentionally failed closed, which is correct for security but
caused a false deny for server-verified superadmin sessions.

### Resolution
Publish a server-verified auth snapshot from `AuthProvider` into a hidden same-window
bridge and let `useAuthContext` consume it only when an access token is present. The
fallback still fails closed when no provider or bridge exists, and it never authorizes
from client-decoded JWT claims.

The same change clears stale `tenant_id` when the backend explicitly returns
`tenantId: null`, preventing platform-scoped superadmin sessions from sending an old
tenant header after a previous tenant-scoped login.

### Verification
- `npm ci`
- `npm ls eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-react-hooks`
- `npx nx lint shared-ui`
- `npx tsc -p web/shared-ui/tsconfig.json --noEmit`
- `npx nx test shared-ui --runInBand`
- `npx nx run-many --target=build --projects=shared-ui,shell,admin-panel,tenant-admin`
