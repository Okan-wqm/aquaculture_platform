/**
 * DeleteConfirmationDialog
 * Cascade delete işlemleri için önizleme ve onay dialogu
 *
 * @description
 * Silme işlemlerinden önce kullanıcıya etkilenecek tüm öğeleri gösterir.
 * Blocker'lar varsa silme işlemi engellenir.
 */

import React from 'react';
import { Modal } from './Modal';
import { Button } from '../Button/Button';
import { Ban, Box, Building2, Cpu, Database, Menu, Settings, TriangleAlert } from 'lucide-react';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface AffectedItemSummary {
  id: string;
  name: string;
  code?: string;
  status?: string;
  hasBlocker?: boolean;
  blockerReason?: string;
}

export interface AffectedItemGroup {
  type: string;
  label: string;
  items: AffectedItemSummary[];
}

export interface DeletePreviewData {
  canDelete: boolean;
  blockers: string[];
  affectedItems: AffectedItemGroup[];
  totalCount: number;
}

export interface DeleteConfirmationDialogProps {
  /** Dialog açık mı */
  isOpen: boolean;
  /** Kapatma işleyicisi */
  onClose: () => void;
  /** Onay işleyicisi */
  onConfirm: () => void;
  /** Dialog başlığı */
  title: string;
  /** Silinecek öğenin adı */
  entityName: string;
  /** Silinecek öğenin türü (Site, Department, etc.) */
  entityType: string;
  /** Önizleme verisi */
  preview: DeletePreviewData | null;
  /** Yükleniyor durumu (preview için) */
  isLoading?: boolean;
  /** Silme işlemi yükleniyor durumu */
  isDeleting?: boolean;
}

// ============================================================================
// İkonlar
// ============================================================================

const WarningIcon: React.FC<{ className?: string }> = ({ className }) => (
  <TriangleAlert className={className} aria-hidden="true" />
);

const BlockerIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Ban className={className} aria-hidden="true" />
);

const DepartmentIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Building2 className={className} aria-hidden="true" />
);

const SystemIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Database className={className} aria-hidden="true" />
);

const EquipmentIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Settings className={className} aria-hidden="true" />
);

const TankIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Box className={className} aria-hidden="true" />
);

const SubSystemIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Cpu className={className} aria-hidden="true" />
);

const DefaultIcon: React.FC<{ className?: string }> = ({ className }) => (
  <Menu className={className} aria-hidden="true" />
);

// İkon seçici
const getIconForType = (type: string): React.FC<{ className?: string }> => {
  const iconMap: Record<string, React.FC<{ className?: string }>> = {
    department: DepartmentIcon,
    departments: DepartmentIcon,
    system: SystemIcon,
    systems: SystemIcon,
    childSystems: SubSystemIcon,
    equipment: EquipmentIcon,
    childEquipment: EquipmentIcon,
    subEquipment: EquipmentIcon,
    tank: TankIcon,
    tanks: TankIcon,
  };
  return iconMap[type] || DefaultIcon;
};

// ============================================================================
// Ana Bileşen
// ============================================================================

export const DeleteConfirmationDialog: React.FC<DeleteConfirmationDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  entityName,
  entityType,
  preview,
  isLoading = false,
  isDeleting = false,
}) => {
  const hasBlockers = preview && preview.blockers.length > 0;
  const canDelete = preview?.canDelete ?? false;
  const totalAffected = preview?.totalCount ?? 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      closeOnOverlayClick={!isDeleting}
      closeOnEscape={!isDeleting}
    >
      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <span className="ml-3 text-gray-600 dark:text-gray-400">Yükleniyor...</span>
        </div>
      )}

      {/* Content */}
      {!isLoading && preview && (
        <div className="space-y-4">
          {/* Entity being deleted */}
          <div className="flex items-start p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
            <WarningIcon className="w-6 h-6 text-error-600 dark:text-error-400 flex-shrink-0 mt-0.5" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-error-800 dark:text-error-200">
                {entityType} Silme Onayı
              </h3>
              <p className="mt-1 text-sm text-error-700 dark:text-error-300">
                <strong>"{entityName}"</strong> {entityType.toLowerCase()}'ını silmek istediğinizden
                emin misiniz?
              </p>
            </div>
          </div>

          {/* Blockers */}
          {hasBlockers && (
            <div className="p-4 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg">
              <div className="flex items-center mb-2">
                <BlockerIcon className="w-5 h-5 text-warning-600 dark:text-warning-400" />
                <h4 className="ml-2 text-sm font-medium text-warning-800 dark:text-warning-200">
                  Silme Engelleyicileri
                </h4>
              </div>
              <ul className="list-disc list-inside space-y-1">
                {preview.blockers.map((blocker, index) => (
                  <li key={index} className="text-sm text-warning-700 dark:text-warning-300">
                    {blocker}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Affected items */}
          {totalAffected > 0 && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Etkilenecek Öğeler
                  <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                    {totalAffected}
                  </span>
                </h4>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Aşağıdaki öğeler de silinecektir (soft delete)
                </p>
              </div>

              <div className="max-h-64 overflow-y-auto">
                {preview.affectedItems.map((group) => {
                  if (group.items.length === 0) return null;

                  const IconComponent = getIconForType(group.type);

                  return (
                    <div
                      key={group.type}
                      className="border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                    >
                      {/* Group header */}
                      <div className="flex items-center px-4 py-2 bg-gray-50 dark:bg-gray-800">
                        <IconComponent className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                        <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                          {group.label}
                        </span>
                        <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200">
                          {group.items.length}
                        </span>
                      </div>

                      {/* Group items */}
                      <ul className="divide-y divide-gray-50">
                        {group.items.map((item) => (
                          <li
                            key={item.id}
                            className={`px-4 py-2 flex items-center justify-between ${
                              item.hasBlocker ? 'bg-warning-50 dark:bg-warning-900/30' : ''
                            }`}
                          >
                            <div className="flex items-center min-w-0">
                              <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                                {item.name}
                              </span>
                              {item.code && (
                                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                                  ({item.code})
                                </span>
                              )}
                            </div>
                            {item.hasBlocker && (
                              <span className="ml-2 text-xs text-warning-600 dark:text-warning-400 flex-shrink-0">
                                {item.blockerReason}
                              </span>
                            )}
                            {item.status && !item.hasBlocker && (
                              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                                {item.status}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* No affected items */}
          {totalAffected === 0 && !hasBlockers && (
            <div className="p-4 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg">
              <p className="text-sm text-success-700 dark:text-success-300">
                Bu {entityType.toLowerCase()} silindığında başka hiçbir öğe etkilenmeyecektir.
              </p>
            </div>
          )}

          {/* Warning message */}
          <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              <strong>Not:</strong> Silme işlemi soft delete olarak yapılacaktır. Veriler tamamen
              silinmez, sadece gizlenir ve gerektiğinde geri alınabilir.
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="secondary" onClick={onClose} disabled={isDeleting}>
          İptal
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          disabled={!canDelete || isDeleting}
          isLoading={isDeleting}
        >
          {hasBlockers ? 'Silinemez' : 'Sil'}
        </Button>
      </div>
    </Modal>
  );
};

export default DeleteConfirmationDialog;
