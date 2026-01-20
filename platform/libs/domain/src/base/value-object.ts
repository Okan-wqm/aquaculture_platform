/**
 * Base Value Object - Immutable objects defined by their attributes
 * Provides equality by value and immutability guarantees
 */
export abstract class ValueObject<TProps extends Record<string, unknown>> {
  protected readonly props: Readonly<TProps>;

  constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  /**
   * Check equality by value (all properties must match)
   */
  equals(other: ValueObject<TProps> | null | undefined): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (this === other) {
      return true;
    }
    return this.shallowEquals(this.props, other.props);
  }

  /**
   * Shallow comparison of two objects
   */
  private shallowEquals(
    obj1: Readonly<TProps>,
    obj2: Readonly<TProps>,
  ): boolean {
    const keys1 = Object.keys(obj1) as Array<keyof TProps>;
    const keys2 = Object.keys(obj2) as Array<keyof TProps>;

    if (keys1.length !== keys2.length) {
      return false;
    }

    return keys1.every((key) => obj1[key] === obj2[key]);
  }

  /**
   * Get a copy of the props
   */
  getProps(): Readonly<TProps> {
    return { ...this.props };
  }

  /**
   * Generate hash code from props
   */
  hashCode(): string {
    return JSON.stringify(this.props);
  }
}
