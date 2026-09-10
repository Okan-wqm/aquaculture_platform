/**
 * CreateBatchCommand
 *
 * Yeni bir üretim partisi (batch) oluşturur.
 * Batch, akuakültür tesisinde yetiştirilen belirli bir balık grubunu temsil eder.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import { BatchInputType, ArrivalMethod } from '../entities/batch.entity';
import { BatchDocumentType } from '../entities/batch-document.entity';
import { Role } from '@aquaculture/backend-common/decorators';

/**
 * Document data for batch creation
 */
export interface BatchDocumentData {
  documentType: BatchDocumentType;
  documentName: string;
  documentNumber?: string;
  storagePath: string;
  storageUrl: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  issueDate?: string;
  expiryDate?: string;
  issuingAuthority?: string;
  notes?: string;
}

/**
 * Initial location for batch allocation
 */
export interface InitialLocationData {
  locationType: 'tank' | 'pond';
  tankId?: string;
  pondId?: string;
  quantity: number;
  biomass: number;
  allocationDate?: string;
}

export interface CreateBatchPayload {
  batchNumber?: string; // Otomatik oluşturulabilir
  name?: string; // Opsiyonel gösterim adı
  description?: string;
  speciesId: string; // Tür ID (zorunlu)
  strain?: string; // Irk/çeşit
  inputType: BatchInputType; // Girdi tipi (eggs, larvae, fry, etc.)
  initialQuantity: number; // Başlangıç adedi
  initialAvgWeightG: number; // Başlangıç ortalama ağırlık (gram)
  stockedAt: Date; // Stoklama tarihi
  supplierId?: string; // Tedarikçi ID
  supplierBatchNumber?: string; // Tedarikçi parti numarası
  purchaseCost?: number; // Satın alma maliyeti
  currency?: string; // Para birimi (default: TRY)
  arrivalMethod?: ArrivalMethod; // Ulaşım yöntemi
  targetFCR?: number; // Hedef FCR (default: tür bazlı)
  expectedHarvestDate?: Date; // Beklenen hasat tarihi (otomatik hesaplanabilir)
  healthCertificates?: BatchDocumentData[]; // Sağlık sertifikaları
  importDocuments?: BatchDocumentData[]; // İthalat belgeleri
  initialLocations?: InitialLocationData[]; // Tank/pond allocations
  notes?: string;
}

export class CreateBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateBatchPayload,
    public readonly createdBy: string,
    /**
     * SEC-HIGH-167: the caller's authority, needed because `initialLocations`
     * stocks tanks and stocking a tank requires the SEC-HIGH-051 site gate.
     * This command carried only `tenantId`, `payload` and `createdBy`, so the
     * check could not even be written — a caller barred from a site could stock
     * its tanks by creating a batch instead of allocating to them.
     *
     * Positional with an `[]` default, matching the ten other farm commands that
     * carry caller authority (allocate-to-tank, record-mortality, record-cull,
     * transfer-batch, create-harvest-record, the storage commands). The default
     * is fail-closed: a construction site that forgets to thread identity denies
     * a MODULE_USER rather than waving them through.
     */
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
  ) {}
}
