type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null
        ? string | null
        : T;

export type MutableFixture<T> = T extends readonly (infer Item)[]
  ? readonly MutableFixture<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: MutableFixture<T[Key]> }
    : Widen<T>;
