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
 *
 * The theme is applied here, before that import (FE-MEDIUM-349). Importing the
 * bootstrap chunk requests the design system's stylesheet, and the boot splash
 * paints from the console tokens it defines once `data-theme` is on <html>. When
 * the theme waited for the bootstrap chunk (~1.2 MB of JS), the stylesheet
 * arrived first and a dark-OS user's splash went dark → light → dark.
 */

import { installRemoteIntegrityGuard } from './utils/remoteIntegrity';
import {
  applyThemePreference,
  followSystemThemePreference,
  getStoredThemePreference,
} from './utils/theme';

// SECURITY: Install BEFORE any other code runs — this patches
// Document.prototype.createElement and Element.prototype.setAttribute
// to intercept unauthorized remote script injection.
installRemoteIntegrityGuard();

// The theme lives on <html> (utils/theme.ts, which imports nothing and runs
// nothing on load): apply the stored preference, and let the OS colour scheme
// move it while that preference is "system" — one listener for the app's
// lifetime, whichever page is open.
applyThemePreference(getStoredThemePreference());
followSystemThemePreference();

import('./bootstrap');
