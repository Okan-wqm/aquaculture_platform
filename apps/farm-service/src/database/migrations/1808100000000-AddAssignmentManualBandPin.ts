import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAssignmentManualBandPin (FARM-MEDIUM-251)
 *
 * ## The manual transition that undid itself
 *
 * `transitionUnitFeed` records an operator's explicit feed choice by writing
 * `currentBandIndex`, then calls `recalcForUnit` in the same transaction to
 * reprice the remaining meals. But `currentBandIndex` is the HYSTERESIS ANCHOR —
 * "which band are we on" — and the resolver treats it as nothing more than that.
 *
 * A manual transition is allowed to target the NEIGHBOUR band (the operator
 * moves a unit onto the next pellet a few days early, which is normal husbandry).
 * That is exactly the case the resolver then reverses: the weight-resolved band
 * differs from the anchor, hysteresis asks whether the fish have crossed the
 * boundary by more than `transitionBufferG` — they have, they are sitting inside
 * the weight band — and it returns the weight band. Inside the transition's own
 * transaction the recalc therefore:
 *
 *   - overwrote `currentFeedId` back to the automatic feed,
 *   - overwrote every remaining meal's `feedId` back,
 *   - repriced those meals at the automatic band's rate,
 *   - emitted a SECOND `FeedTypeTransitioned` contradicting the first.
 *
 * The mutation still returned `TRANSITIONED` and logged the operator's feed, so
 * the surface reported success while the database held the opposite.
 *
 * ## Why a column and not a smarter comparison
 *
 * The two facts are genuinely different and both are needed: "the band in effect"
 * (anchor for hysteresis) and "the band a human pinned" (an explicit decision).
 * Overloading one field is what produced the defect; no amount of comparison
 * logic recovers a fact that was never stored. `manualBandIndex` holds the pin,
 * and the resolver honours it until the fish grow PAST it — at which point the
 * automatic transition supersedes the operator's choice and clears the pin.
 *
 * Additive and nullable: existing assignments read as "no pin", which is their
 * behaviour today. Blue-green safe.
 *
 * Tenant-aware table: DDL is schema-unqualified; search_path routes each pass
 * into its own tenant schema.
 */
export class AddAssignmentManualBandPin1808100000000 implements MigrationInterface {
  name = 'AddAssignmentManualBandPin1808100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "feeding_protocol_assignments"
         ADD COLUMN IF NOT EXISTS "manualBandIndex" integer`,
    );
  }

  /**
   * The column exists and holds no impossible pin. A negative index can never
   * name a band, so its presence would mean something other than
   * `transitionUnitFeed` wrote here.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'feeding_protocol_assignments'
              AND column_name = 'manualBandIndex'
         )
         AND NOT EXISTS (
           SELECT 1 FROM "feeding_protocol_assignments" WHERE "manualBandIndex" < 0
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "feeding_protocol_assignments" DROP COLUMN IF EXISTS "manualBandIndex"`,
    );
  }
}
