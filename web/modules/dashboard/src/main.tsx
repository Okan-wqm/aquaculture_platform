/**
 * Dashboard Module - Entry Point
 *
 * Dynamically imports bootstrap.tsx to allow Module Federation shared scope
 * initialisation before React renders. This is the standard MF pattern.
 */

import('./bootstrap');
