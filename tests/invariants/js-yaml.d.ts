declare module 'js-yaml' {
  export function load(input: string): unknown;
  export function loadAll(input: string, iterator?: (document: unknown) => void): unknown[];

  const yaml: {
    load: typeof load;
    loadAll: typeof loadAll;
  };

  export default yaml;
}
