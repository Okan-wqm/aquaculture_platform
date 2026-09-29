export class ImmutableByteMap implements ReadonlyMap<string, Uint8Array> {
  readonly #values: Map<string, Buffer>;

  constructor(entries: readonly (readonly [string, Uint8Array])[]) {
    this.#values = new Map(entries.map(([key, value]) => [key, Buffer.from(value)]));
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: string): Uint8Array | undefined {
    const value = this.#values.get(key);
    return value === undefined ? undefined : Buffer.from(value);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[string, Uint8Array]> {
    return new Map(
      Array.from(this.#values, ([key, value]) => [key, Buffer.from(value)] as const),
    ).entries();
  }

  keys(): MapIterator<string> {
    return this.#values.keys();
  }

  values(): MapIterator<Uint8Array> {
    return new Map(
      Array.from(this.#values, ([key, value]) => [key, Buffer.from(value)] as const),
    ).values();
  }

  forEach(
    callbackfn: (value: Uint8Array, key: string, map: ReadonlyMap<string, Uint8Array>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callbackfn.call(thisArg, Buffer.from(value), key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ImmutableByteMap';
  }
}

Object.freeze(ImmutableByteMap.prototype);
Object.freeze(ImmutableByteMap);
