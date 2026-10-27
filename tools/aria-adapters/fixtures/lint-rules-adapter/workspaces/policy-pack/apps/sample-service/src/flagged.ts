// Fixture for lint-rules-adapter: one deliberate finding per syntactic policy
// rule that can be written out whole in a committed file (a console call, an
// explicit `any`). The double assertion through `unknown` and the suppression
// comment are exercised by lint-rules-adapter.test.ts instead, which spells
// them in pieces.
export class OvertimeCalculator {
  public total(hours: readonly number[]): number {
    console.log('overtime recalculated');
    return hours.reduce((sum, value) => sum + value, 0);
  }

  public fail(reason: string): void {
    console.error(reason);
  }

  public describe(payload: any): string {
    return String(payload);
  }
}
