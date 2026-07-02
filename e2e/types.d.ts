declare module 'uuid' {
  export function v4(): string;
}

// @types/js-yaml is declared in e2e/package.json but CI's lint job only runs
// the root `npm ci` (e2e's own deps are installed separately, only in the
// farm-water-chemistry-e2e job) — so this ambient declaration must not depend
// on the package actually being installed.
declare module 'js-yaml' {
  export function load(input: string): unknown;

  const yaml: {
    load: typeof load;
  };

  export default yaml;
}
