// Semantic fixture known-FP trap (archived_dead_corpus): identical hazard, but
// retired into the `.archive/<timestamp>/` snapshot corpus — the adapter must
// NOT flag it (E13 spot-audit FP class 2).
export class ArchivedHazard1700000000000 {
  public async up(queryRunner: { query(sql: string): Promise<void> }): Promise<void> {
    await queryRunner.query('DROP TABLE billing_retired_ledger');
  }
}
