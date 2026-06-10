import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { BigIntTransformer } from '../transformers/bigint.transformer';

@Entity('ledger_cursors', { schema: 'event_store' })
export class LedgerCursor {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'bigint', transformer: new BigIntTransformer() })
  nextPosition!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
