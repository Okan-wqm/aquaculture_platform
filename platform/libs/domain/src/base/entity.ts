/**
 * Base Entity - Foundation for all domain entities
 * Provides identity, timestamps, and equality operations
 * Enterprise-grade implementation for 10K+ tenant scale
 */
export abstract class Entity<TId = string> {
  protected readonly _id: TId;
  protected _createdAt: Date;
  protected _updatedAt: Date;
  protected _version: number;

  constructor(id: TId, createdAt?: Date, updatedAt?: Date, version?: number) {
    this._id = id;
    this._createdAt = createdAt ?? new Date();
    this._updatedAt = updatedAt ?? new Date();
    this._version = version ?? 1;
  }

  get id(): TId {
    return this._id;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get version(): number {
    return this._version;
  }

  /**
   * Check equality by identity
   */
  equals(other: Entity<TId> | null | undefined): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (this === other) {
      return true;
    }
    if (!(other instanceof Entity)) {
      return false;
    }
    return this._id === other._id;
  }

  /**
   * Update the timestamp on modification
   */
  protected touch(): void {
    this._updatedAt = new Date();
    this._version += 1;
  }

  /**
   * Generate a hash code for the entity
   */
  hashCode(): string {
    return String(this._id);
  }
}
