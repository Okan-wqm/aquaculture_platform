/**
 * Frontend authorization helpers — mirror of the backend permission
 * matrix + the `useCanMutate(name)` hook that gates rendering.
 *
 * Drift is locked by `__tests__/permission-matrix.parity.test.ts`:
 * reads the backend source at test time and asserts every mutation
 * in this file's matrix carries the SAME role set as the backend.
 */
export {
  FRONTEND_MUTATION_ROLES,
  type FrontendMutationName,
} from './permission-matrix';
export { useCanMutate } from './useCanMutate';
