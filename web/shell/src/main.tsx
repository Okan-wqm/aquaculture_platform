/**
 * Shell Application - Entry Point
 *
 * SECURITY: The remote integrity guard MUST be installed before ANY other
 * imports — including the dynamic bootstrap import that loads React/ReactDOM.
 * This ensures the createElement and setAttribute prototype patches are active
 * before any library code executes, closing the timing window where unguarded
 * script injection was possible (FE-CRITICAL-003).
 *
 * Dynamic import of bootstrap defers module execution until the Module Federation
 * runtime has had a chance to negotiate shared singletons, preventing
 * "Shared module is not available for eager consumption" errors.
 */

import { installRemoteIntegrityGuard } from './utils/remoteIntegrity';

// SECURITY: Install BEFORE any other code runs — this patches
// Document.prototype.createElement and Element.prototype.setAttribute
// to intercept unauthorized remote script injection.
installRemoteIntegrityGuard();

import('./bootstrap');
