import type { SelectQueryBuilder } from 'typeorm';

import type { HealthEventFilterInput } from '../dto/health-event-filter.input';
import {
  HealthEventStatus,
  HealthSeverity,
  type HealthEvent,
} from '../entities/health-event.entity';

/**
 * The one health-event filter SSoT (FARM-HIGH-060), applied to a query
 * builder over the `he` alias.
 *
 * WHY a module function and not a static on HealthEventService: the
 * ListHealthEvents query handler — reached by the AI listHealthEvents subject —
 * may read only through its TenantScope (K10 layer 4). A static on a service
 * that holds repositories would make that service part of the AI-reachable
 * code; a pure function keeps it out.
 */
export function applyHealthEventFilters(
  query: SelectQueryBuilder<HealthEvent>,
  filter?: HealthEventFilterInput,
): void {
  if (!filter) return;

  // Location filters
  if (filter.batchId) {
    query.andWhere('he.batchId = :batchId', { batchId: filter.batchId });
  }
  if (filter.batchIds?.length) {
    query.andWhere('he.batchId IN (:...batchIds)', { batchIds: filter.batchIds });
  }
  if (filter.tankId) {
    query.andWhere('he.tankId = :tankId', { tankId: filter.tankId });
  }

  // Event type filters
  if (filter.eventType) {
    query.andWhere('he.eventType = :eventType', { eventType: filter.eventType });
  }
  if (filter.eventTypes?.length) {
    query.andWhere('he.eventType IN (:...eventTypes)', { eventTypes: filter.eventTypes });
  }

  // Severity and status filters
  if (filter.severity) {
    query.andWhere('he.severity = :severity', { severity: filter.severity });
  }
  if (filter.severities?.length) {
    query.andWhere('he.severity IN (:...severities)', { severities: filter.severities });
  }
  if (filter.status) {
    query.andWhere('he.status = :status', { status: filter.status });
  }
  if (filter.statuses?.length) {
    query.andWhere('he.status IN (:...statuses)', { statuses: filter.statuses });
  }

  // Disease filters
  if (filter.diseaseCategory) {
    query.andWhere('he.diseaseCategory = :diseaseCategory', {
      diseaseCategory: filter.diseaseCategory,
    });
  }
  if (filter.diseaseName) {
    query.andWhere('he.diseaseName ILIKE :diseaseName', { diseaseName: `%${filter.diseaseName}%` });
  }

  // Date filters
  if (filter.fromDate) {
    query.andWhere('he.eventDate >= :fromDate', { fromDate: filter.fromDate });
  }
  if (filter.toDate) {
    query.andWhere('he.eventDate <= :toDate', { toDate: filter.toDate });
  }

  // Treatment filters
  if (filter.isUnderTreatment !== undefined) {
    query.andWhere('he.isUnderTreatment = :isUnderTreatment', {
      isUnderTreatment: filter.isUnderTreatment,
    });
  }
  if (filter.isQuarantined !== undefined) {
    query.andWhere('he.isQuarantined = :isQuarantined', { isQuarantined: filter.isQuarantined });
  }

  // Special filters
  if (filter.activeOnly) {
    query.andWhere('he.status IN (:...activeStatuses)', {
      activeStatuses: [HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING],
    });
  }
  if (filter.criticalOnly) {
    query.andWhere('he.severity IN (:...criticalSeverities)', {
      criticalSeverities: [HealthSeverity.CRITICAL, HealthSeverity.SEVERE],
    });
  }

  // Text search
  if (filter.searchText) {
    query.andWhere(
      '(he.title ILIKE :search OR he.description ILIKE :search OR he.notes ILIKE :search)',
      { search: `%${filter.searchText}%` },
    );
  }
}
