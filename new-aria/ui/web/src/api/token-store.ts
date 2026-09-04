// Operator token store.
//
// WHY: the token is a bearer credential for a console that can pause the kernel.
// It lives ONLY in sessionStorage (tab-scoped, dropped on close) — never in
// persistent browser storage (survives forever, shared across tabs) and never in the URL
// (leaks through history, referrers and logs). React reads it through a
// subscription so the auth guard re-renders the moment the token changes.
// WHAT: get/set/clear plus a tiny external-store subscription for useSyncExternalStore.

const STORAGE_KEY = 'new-aria-ui.token';

type Listener = () => void;
const listeners = new Set<Listener>();

function readStorage(): string | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  return raw === null || raw.trim() === '' ? null : raw;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getToken(): string | null {
  return readStorage();
}

export function setToken(token: string): void {
  window.sessionStorage.setItem(STORAGE_KEY, token.trim());
  notify();
}

export function clearToken(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
  notify();
}

export function subscribeToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
