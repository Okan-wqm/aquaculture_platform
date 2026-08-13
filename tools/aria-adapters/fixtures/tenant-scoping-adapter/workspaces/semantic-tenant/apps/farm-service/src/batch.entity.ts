function Entity(name: string) {
  return () => undefined;
}
@Entity('batches')
export class Batch {
  id!: string;
  tenantId!: string;
}
