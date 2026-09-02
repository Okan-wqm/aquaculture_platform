// Content-bound fixture (ARIA-AUDIT-056): mentions `batch`, the touched
// entity's stem, so the witness's migration coverage sees a real schema
// coupling rather than a path that merely looks like one.
export class AddBatchColumn1800000000000 {
  public async up(): Promise<void> {
    // ALTER TABLE batch ...
  }
}
