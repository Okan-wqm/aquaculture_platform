# 2026-05-05 - Shared UI Auth Global State Test Isolation

## Affected Area
- `web/shared-ui/src/utils/api-client.ts`
- `web/shared-ui/src/test-setup.ts`
- `web/shared-ui/src/utils/__tests__/api-client.spec.ts`
- `web/shared-ui/src/contexts/__tests__/AuthContext.spec.tsx`

## Observed Issue
CI `shared-ui:test` failed because access token state leaked between tests. The same run also showed REST mutating method tests passing only when stale auth state was present, and AuthContext failure tests asserted rejected `act(...)` promises before React state updates were committed.

## Root Cause
The Module Federation auth bridge used a non-configurable `window.__AQUACULTURE_AUTH__` object whose functions could keep reading from an older module instance closure after module resets. That is a runtime/HMR/MF risk, not just a test issue. The test harness also did not clear the new global auth state between tests.

## Architectural Fix
- Introduce a versioned shared auth state object for access token and tenant id so frozen MF getters read current shared state, not stale module closures.
- Clear the shared auth state in Vitest setup before each test.
- Make REST mutating method tests declare their auth precondition explicitly with `setTokens(...)`.
- Make AuthContext rejected-login tests catch the thrown error inside `act(...)` and assert reducer state after React commits.

## Verification
- `npm --workspace @aquaculture/shared-ui run test -- --run src/utils/__tests__/api-client.spec.ts src/contexts/__tests__/AuthContext.spec.tsx`

## Status
Fixed on 2026-05-05.
