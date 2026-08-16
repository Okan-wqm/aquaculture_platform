import type {
  CreateDiscountCodeDto,
  UpdateDiscountCodeDto,
} from '../services/discount-code.service';
import type { CreatePlanDto, UpdatePlanDto } from '../services/plan-definition.service';
import type { PlanChangeRequest } from '../services/subscription-types';

/**
 * Browser-owned billing inputs.
 *
 * Actor fields belong to the authenticated request context and are added only
 * after authorization. Keeping that distinction in the backend HTTP contract
 * prevents generated clients from accepting spoofable server-owned fields.
 */
export type CreatePlanRequest = Omit<CreatePlanDto, 'createdBy'>;
export type UpdatePlanRequest = Omit<UpdatePlanDto, 'updatedBy'>;
export type CreateDiscountCodeRequest = Omit<CreateDiscountCodeDto, 'createdBy'>;
export type UpdateDiscountCodeRequest = Omit<UpdateDiscountCodeDto, 'updatedBy'>;
export type ChangeSubscriptionPlanRequest = Omit<PlanChangeRequest, 'changedBy'>;

