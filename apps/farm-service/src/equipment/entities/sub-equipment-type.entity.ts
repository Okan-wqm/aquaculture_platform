/**
 * SubEquipmentType Entity - Alt ekipman tipleri
 * Ana ekipmanlara bağlanabilecek alt bileşenler
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { SpecificationSchema } from './equipment-type.entity';

@Entity('sub_equipment_types')
@Index(['code'], { unique: true })
@Index(['isActive'])
export class SubEquipmentType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ length: 50, unique: true })
  code!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 50, nullable: true })
  icon?: string;

  /**
   * WHAT: the `EquipmentType.code` values this sub-equipment type can attach to,
   * e.g. ['tank-circular', 'tank-raceway'].
   *
   * WHY a real `text[]` and not TypeORM's `simple-array`: `simple-array`
   * serialises the list into ONE comma-joined string, which forces callers to
   * match it as text. `GetSubEquipmentTypesHandler` did exactly that with
   * `LIKE '%<code>%'`, so any code that is a substring of another matched
   * wrongly — 'valve' matched 'inlet-valve' / 'outlet-valve' /
   * 'backwash-valve', 'aerator' matched nothing it should not only by luck.
   * A genuine array makes the containment operator (`@>`) the natural query and
   * makes substring matching inexpressible. The other half of this same
   * relation, `EquipmentType.allowedSubEquipmentTypes`, is already `text[]`;
   * this aligns the two halves.
   */
  @Column('text', { array: true })
  compatibleEquipmentTypes!: string[];

  @Column({ type: 'jsonb' })
  specificationSchema!: SpecificationSchema;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isSystem!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
