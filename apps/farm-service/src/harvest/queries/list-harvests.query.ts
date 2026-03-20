/**
 * ListHarvestsQuery
 *
 * Query for listing harvest records with filtering and pagination.
 *
 * @module Harvest/Queries
 */
import { HarvestRecordStatus, QualityGrade } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';

export interface HarvestFilterCriteria {
  batchId?: string;
  batchIds?: string[];
  tankId?: string;
  tankIds?: string[];
  pondId?: string;
  siteId?: string;
  status?: HarvestRecordStatus;
  statuses?: HarvestRecordStatus[];
  qualityGrade?: QualityGrade;
  qualityGrades?: QualityGrade[];
  method?: HarvestMethod;
  productForm?: ProductForm;
  startDate?: Date;
  endDate?: Date;
  qualityApproved?: boolean;
  harvestedBy?: string;
  search?: string;
  minBiomass?: number;
  maxBiomass?: number;
  minAverageWeight?: number;
  maxAverageWeight?: number;
  minQuantity?: number;
  maxQuantity?: number;
}

export interface HarvestPaginationOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListHarvestsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: HarvestFilterCriteria,
    public readonly pagination?: HarvestPaginationOptions,
  ) {}
}
