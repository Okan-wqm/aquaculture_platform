/**
 * Type declaration for the 'uuid' module.
 * The installed @types/uuid v11 is a stub (uuid v10+ ships its own types),
 * but this project uses uuid v9 which does not. This declaration bridges the gap.
 */
declare module 'uuid' {
  export function v4(options?: { random?: number[]; rng?: () => number[] }): string;
  export function v1(options?: { node?: number[]; clockseq?: number; msecs?: number; nsecs?: number }): string;
  export function v5(name: string, namespace: string | number[]): string;
  export function v3(name: string, namespace: string | number[]): string;
  export function validate(uuid: string): boolean;
  export function parse(uuid: string): Uint8Array;
  export function stringify(arr: Uint8Array, offset?: number): string;
  export function version(uuid: string): number;
  export const NIL: string;
}
