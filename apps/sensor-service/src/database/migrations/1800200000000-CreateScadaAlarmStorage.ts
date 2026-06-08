import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateScadaAlarmStorage1800200000000 implements MigrationInterface {
  name = 'CreateScadaAlarmStorage1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.scada_alarms (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        group_name TEXT,
        current_value DOUBLE PRECISION NOT NULL DEFAULT 0,
        threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
        on_time BIGINT NOT NULL,
        off_time BIGINT,
        ack_time BIGINT,
        ack_user_id TEXT,
        colors_bg TEXT,
        colors_text TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.scada_alarm_chronicle (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        group_name TEXT,
        current_value DOUBLE PRECISION NOT NULL DEFAULT 0,
        threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
        on_time BIGINT NOT NULL,
        off_time BIGINT,
        ack_time BIGINT,
        ack_user_id TEXT,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_scada_alarm_chronicle_on_time
        ON sensor.scada_alarm_chronicle (on_time DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_scada_alarm_chronicle_severity
        ON sensor.scada_alarm_chronicle (severity)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS sensor.idx_scada_alarm_chronicle_severity');
    await queryRunner.query('DROP INDEX IF EXISTS sensor.idx_scada_alarm_chronicle_on_time');
    await queryRunner.query('DROP TABLE IF EXISTS sensor.scada_alarm_chronicle');
    await queryRunner.query('DROP TABLE IF EXISTS sensor.scada_alarms');
  }
}
