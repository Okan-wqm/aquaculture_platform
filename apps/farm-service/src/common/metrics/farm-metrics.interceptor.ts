/**
 * FarmMetricsInterceptor
 *
 * Wraps every GraphQL resolver invocation (query + mutation) so
 * `farm_mutation_duration_seconds` and `farm_mutation_errors_total`
 * stay accurate without requiring each resolver to record timings
 * by hand. A single APP_INTERCEPTOR registration in AppModule
 * instruments the entire surface.
 *
 * The interceptor deliberately scopes to GraphQL only — HTTP is
 * already measured by `ServiceMetricsService` in
 * `@aquaculture/backend-common/metrics`. GraphQL introspection
 * queries are skipped so pinging the schema does not inflate the
 * `operation=IntrospectionQuery` label.
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Observable, tap } from 'rxjs';

import { FarmDomainMetricsService } from './farm-domain-metrics.service';

interface GraphQLContextRequest {
  headers?: Record<string, string | string[] | undefined>;
}

const SETUP_OPERATION_SURFACES: Readonly<Record<string, string>> = {
  createSite: 'site',
  updateSite: 'site',
  deleteSite: 'site',
  restoreSite: 'site',
  site: 'site',
  sites: 'site',
  activeSites: 'site',
  siteDeletePreview: 'site',
  upsertSiteContacts: 'site_contacts',
  siteContacts: 'site_contacts',

  createDepartment: 'department',
  updateDepartment: 'department',
  deleteDepartment: 'department',
  restoreDepartment: 'department',
  department: 'department',
  departments: 'department',
  departmentsBySite: 'department',
  departmentDeletePreview: 'department',

  createSystem: 'system',
  updateSystem: 'system',
  deleteSystem: 'system',
  restoreSystem: 'system',
  system: 'system',
  systems: 'system',
  systemsBySite: 'system',
  systemsByDepartment: 'system',
  rootSystems: 'system',
  childSystems: 'system',
  systemDeletePreview: 'system',

  createEquipment: 'equipment',
  updateEquipment: 'equipment',
  deleteEquipment: 'equipment',
  restoreEquipment: 'equipment',
  equipment: 'equipment',
  equipmentList: 'equipment',
  equipmentByDepartment: 'equipment',
  equipmentTypes: 'equipment_type',
  equipmentDeletePreview: 'equipment',

  createSubEquipment: 'sub_equipment',
  updateSubEquipment: 'sub_equipment',
  deleteSubEquipment: 'sub_equipment',
  subEquipment: 'sub_equipment',
  subEquipmentList: 'sub_equipment',
  subEquipmentByParent: 'sub_equipment',
  subEquipmentTypes: 'sub_equipment_type',
  subEquipmentTypesForEquipment: 'sub_equipment_type',
  subEquipmentType: 'sub_equipment_type',

  saveFeederCalibrations: 'feeder_calibration',
  feederCalibrations: 'feeder_calibration',

  createTank: 'tank',
  updateTank: 'tank',
  updateTankStatus: 'tank',
  deleteTank: 'tank',
  tank: 'tank',
  tanks: 'tank',
  tanksByDepartment: 'tank',
  availableTanks: 'tank',

  createSupplier: 'supplier',
  updateSupplier: 'supplier',
  deleteSupplier: 'supplier',
  restoreSupplier: 'supplier',
  setSupplierApprovedSites: 'supplier_sites',
  supplier: 'supplier',
  suppliers: 'supplier',
  supplierTypes: 'supplier_type',
  supplierSites: 'supplier_sites',

  createChemical: 'chemical',
  updateChemical: 'chemical',
  deleteChemical: 'chemical',
  restoreChemical: 'chemical',
  addChemicalDocument: 'chemical_document_jsonb',
  removeChemicalDocument: 'chemical_document_jsonb',
  chemical: 'chemical',
  chemicals: 'chemical',
  chemicalsBySite: 'chemical',
  chemicalsByType: 'chemical',
  lowStockChemicals: 'chemical',
  chemicalTypes: 'chemical_type',

  createFeed: 'feed',
  updateFeed: 'feed',
  deleteFeed: 'feed',
  restoreFeed: 'feed',
  feed: 'feed',
  feeds: 'feed',
  feedsBySite: 'feed',
  feedsByType: 'feed',
  lowStockFeeds: 'feed',
  feedTypes: 'feed_type',

  createFeedingProtocol: 'feeding_protocol',
  updateFeedingProtocol: 'feeding_protocol',
  deleteFeedingProtocol: 'feeding_protocol',
  feedingProtocol: 'feeding_protocol',
  feedingProtocols: 'feeding_protocol',

  createWorker: 'farm_workers',
  updateWorker: 'farm_workers',
  deleteWorker: 'farm_workers',
  workers: 'farm_workers',

  farms: 'legacy_farms',
  farm: 'legacy_farms',
  ponds: 'legacy_ponds',
  pond: 'legacy_ponds',
};

@Injectable()
export class FarmMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: FarmDomainMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return next.handle();
    }

    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo<{
      fieldName?: string;
      operation?: { operation?: string; name?: { value?: string } };
      parentType?: { name?: string };
    }>();

    const parentTypeName = info?.parentType?.name;
    // Only measure root-level operations — field resolvers on child
    // types would multiply the counter per row and drown the
    // operation-level signal in noise.
    if (parentTypeName !== 'Mutation' && parentTypeName !== 'Query') {
      return next.handle();
    }

    const operationName = info?.fieldName ?? info?.operation?.name?.value ?? 'unknown';

    // Skip introspection so schema checks do not inflate metrics.
    if (operationName.startsWith('__')) {
      return next.handle();
    }

    const ctx = gqlContext.getContext<{ req?: GraphQLContextRequest }>();
    const tenantHeader = ctx?.req?.headers?.['x-tenant-id'];
    const tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined;

    const startHrTime = process.hrtime.bigint();
    this.recordSetupRuntimeUsage(parentTypeName, operationName, tenantId);

    return next.handle().pipe(
      tap({
        next: () => {
          this.record(operationName, startHrTime, 'success', tenantId);
        },
        error: (err: unknown) => {
          this.record(operationName, startHrTime, 'error', tenantId);
          const errorClass = this.classifyError(err);
          this.metricsService.recordMutationError({
            operation: operationName,
            errorClass,
            tenantId,
          });
        },
      }),
    );
  }

  private recordSetupRuntimeUsage(
    parentTypeName: string | undefined,
    operation: string,
    tenantId?: string,
  ): void {
    const surface = SETUP_OPERATION_SURFACES[operation];
    if (!surface) return;

    if (parentTypeName === 'Mutation') {
      this.metricsService.recordSetupLegacyWrite({
        surface,
        operation,
        contract: 'graphql',
        tenantId,
      });
      return;
    }

    if (parentTypeName === 'Query') {
      this.metricsService.recordSetupLegacyRead({
        surface,
        operation,
        contract: 'graphql',
        tenantId,
      });
    }
  }

  private record(
    operation: string,
    startHrTime: bigint,
    outcome: 'success' | 'error',
    tenantId?: string,
  ): void {
    const endHrTime = process.hrtime.bigint();
    const durationSeconds = Number(endHrTime - startHrTime) / 1_000_000_000;
    this.metricsService.recordMutation({
      operation,
      durationSeconds,
      outcome,
      tenantId,
    });
  }

  private classifyError(err: unknown): string {
    if (err && typeof err === 'object' && 'constructor' in err) {
      const ctor = (err as { constructor?: { name?: string } }).constructor;
      if (ctor?.name) return ctor.name;
    }
    return 'UnknownError';
  }
}
