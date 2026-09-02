// Fixture: migration-shaped path with NO binding to the touched entity —
// the witness must keep migration:farm-service uncovered.
export class Unrelated1800000000001 {
  public async up(): Promise<void> {
    // ALTER TABLE something_else ...
  }
}
