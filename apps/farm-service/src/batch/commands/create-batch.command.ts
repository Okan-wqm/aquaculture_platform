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
  batchNumber?: string;           // Otomatik oluşturulabilir
  name?: string;                  // Opsiyonel gösterim adı
  description?: string;
  speciesId: string;              // Tür ID (zorunlu)
  strain?: string;                // Irk/çeşit
  inputType: BatchInputType;      // Girdi tipi (eggs, larvae, fry, etc.)
  initialQuantity: number;        // Başlangıç adedi
  initialAvgWeightG: number;      // Başlangıç ortalama ağırlık (gram)
  stockedAt: Date;                // Stoklama tarihi
  supplierId?: string;            // Tedarikçi ID
  supplierBatchNumber?: string;   // Tedarikçi parti numarası
  purchaseCost?: number;          // Satın alma maliyeti
  currency?: string;              // Para birimi (default: TRY)
  arrivalMethod?: ArrivalMethod;  // Ulaşım yöntemi
  targetFCR?: number;             // Hedef FCR (default: tür bazlı)
  expectedHarvestDate?: Date;     // Beklenen hasat tarihi (otomatik hesaplanabilir)
  healthCertificates?: BatchDocumentData[]; // Sağlık sertifikaları
  importDocuments?: BatchDocumentData[];     // İthalat belgeleri
  initialLocations?: InitialLocationData[];  // Tank/pond allocations
  notes?: string;
}

export class CreateBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateBatchPayload,
    public readonly createdBy: string,
  ) {}
}
