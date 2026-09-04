// Path + query helpers bound to the contract's `:param` templates.
//
// WHY: endpoint paths are declared once in the shared contract; the client must
// derive concrete URLs from those templates instead of re-typing strings that
// could drift from the server.
// WHAT: fillPath replaces `:name` segments (URL-encoded), withQuery appends only
// defined query params so `?limit=undefined` can never reach the server.

export type QueryValue = string | number | boolean | undefined;

export function fillPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Path parametresi eksik: ${name} (${template})`);
    }
    return encodeURIComponent(value);
  });
}

export function withQuery(path: string, params: Readonly<Record<string, QueryValue>> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? path : `${path}?${encoded}`;
}
