import { ObjectType, Field, Float, Int, ID } from '@nestjs/graphql';
import { StandardPaginatedResponse } from '@aquaculture/backend-common';
import { PurchaseOrderCategory, PurchaseOrderStatus } from '../entities/purchase-order.entity';

@ObjectType()
export class PurchaseOrderItemResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  itemId!: string;

  @Field()
  itemName!: string;

  @Field({ nullable: true })
  itemCode?: string;

  @Field(() => Float)
  quantity!: number;

  @Field()
  unit!: string;

  @Field(() => Float, { nullable: true })
  unitPrice?: number;

  @Field(() => Float, { nullable: true })
  totalPrice?: number;

  @Field(() => Float)
  quantityReceived!: number;

  @Field()
  isFullyReceived!: boolean;

  @Field({ nullable: true })
  notes?: string;
}

@ObjectType()
export class PurchaseOrderResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  orderNumber!: string;

  @Field(() => PurchaseOrderCategory)
  category!: PurchaseOrderCategory;

  @Field()
  supplierName!: string;

  @Field({ nullable: true })
  supplierContact?: string;

  @Field(() => PurchaseOrderStatus)
  status!: PurchaseOrderStatus;

  @Field({ nullable: true })
  expectedDeliveryDate?: Date;

  @Field({ nullable: true })
  actualDeliveryDate?: Date;

  @Field({ nullable: true })
  notes?: string;

  @Field(() => Float, { nullable: true })
  totalAmount?: number;

  @Field()
  currency!: string;

  @Field(() => [PurchaseOrderItemResponse])
  items!: PurchaseOrderItemResponse[];

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class PaginatedPurchaseOrdersResponse extends StandardPaginatedResponse(PurchaseOrderResponse) {}
