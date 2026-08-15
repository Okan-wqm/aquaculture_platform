// Semantic fixture TP: a LIVE hazardous migration with no test coverage —
// the adapter must keep flagging this after the archive-exclusion fix.
export class LiveHazard1800000000000 {
  public async up(queryRunner: { query(sql: string): Promise<void> }): Promise<void> {
    await queryRunner.query('DROP TABLE billing_shadow_ledger');
  }
}
