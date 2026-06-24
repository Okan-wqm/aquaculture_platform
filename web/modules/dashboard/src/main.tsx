/**
 * Dashboard Module - Entry Point
 *
 * Dynamically imports bootstrap.tsx to allow Module Federation shared scope
 * initialisation before React renders. This is the standard MF pattern.
 */

// void: fire-and-forget — the dynamic import's side effect (rendering) is what
// matters; nothing here awaits the resolved module namespace.
void import('./bootstrap');
