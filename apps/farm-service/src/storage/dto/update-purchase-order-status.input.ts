import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsEnum } from 'class-validator';
import { PurchaseOrderStatus } from '../entities/purchase-order.entity';

@InputType()
export class UpdatePurchaseOrderStatusInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => PurchaseOrderStatus)
  @IsEnum(PurchaseOrderStatus)
  status!: PurchaseOrderStatus;
}
