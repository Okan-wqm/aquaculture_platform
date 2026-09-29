export class ImmutableStringMap implements ReadonlyMap<string, string> {
  readonly #values: Map<string, string>;

  constructor(entries: readonly (readonly [string, string])[]) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: string): string | undefined {
    return this.#values.get(key);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[string, string]> {
    return new Map(this.#values).entries();
  }

  keys(): MapIterator<string> {
    return new Map(this.#values).keys();
  }

  values(): MapIterator<string> {
    return new Map(this.#values).values();
  }

  forEach(
    callbackfn: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ImmutableStringMap';
  }
}

Object.freeze(ImmutableStringMap.prototype);
Object.freeze(ImmutableStringMap);
