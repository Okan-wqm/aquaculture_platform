/**
 * Shell Application - Entry Point
 *
 * Dynamic import of bootstrap defers module execution until the Module Federation
 * runtime has had a chance to negotiate shared singletons, preventing
 * "Shared module is not available for eager consumption" errors.
 */

import('./bootstrap');
