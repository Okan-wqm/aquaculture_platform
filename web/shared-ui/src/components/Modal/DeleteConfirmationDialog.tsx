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
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);

const BlockerIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
    />
  </svg>
);

const DepartmentIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
    />
  </svg>
);

const SystemIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
    />
  </svg>
);

const EquipmentIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
    />
  </svg>
);

const TankIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
    />
  </svg>
);

const SubSystemIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
    />
  </svg>
);

const DefaultIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 6h16M4 12h16M4 18h16"
    />
  </svg>
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
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">Yükleniyor...</span>
        </div>
      )}

      {/* Content */}
      {!isLoading && preview && (
        <div className="space-y-4">
          {/* Entity being deleted */}
          <div className="flex items-start p-4 bg-red-50 border border-red-200 rounded-lg">
            <WarningIcon className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {entityType} Silme Onayı
              </h3>
              <p className="mt-1 text-sm text-red-700">
                <strong>"{entityName}"</strong> {entityType.toLowerCase()}'ını silmek istediğinizden emin misiniz?
              </p>
            </div>
          </div>

          {/* Blockers */}
          {hasBlockers && (
            <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-center mb-2">
                <BlockerIcon className="w-5 h-5 text-yellow-600" />
                <h4 className="ml-2 text-sm font-medium text-yellow-800">
                  Silme Engelleyicileri
                </h4>
              </div>
              <ul className="list-disc list-inside space-y-1">
                {preview.blockers.map((blocker, index) => (
                  <li key={index} className="text-sm text-yellow-700">
                    {blocker}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Affected items */}
          {totalAffected > 0 && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                <h4 className="text-sm font-medium text-gray-900">
                  Etkilenecek Öğeler
                  <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-800">
                    {totalAffected}
                  </span>
                </h4>
                <p className="mt-1 text-xs text-gray-500">
                  Aşağıdaki öğeler de silinecektir (soft delete)
                </p>
              </div>

              <div className="max-h-64 overflow-y-auto">
                {preview.affectedItems.map((group) => {
                  if (group.items.length === 0) return null;

                  const IconComponent = getIconForType(group.type);

                  return (
                    <div key={group.type} className="border-b border-gray-100 last:border-b-0">
                      {/* Group header */}
                      <div className="flex items-center px-4 py-2 bg-gray-25">
                        <IconComponent className="w-4 h-4 text-gray-500" />
                        <span className="ml-2 text-sm font-medium text-gray-700">
                          {group.label}
                        </span>
                        <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                          {group.items.length}
                        </span>
                      </div>

                      {/* Group items */}
                      <ul className="divide-y divide-gray-50">
                        {group.items.map((item) => (
                          <li
                            key={item.id}
                            className={`px-4 py-2 flex items-center justify-between ${
                              item.hasBlocker ? 'bg-yellow-25' : ''
                            }`}
                          >
                            <div className="flex items-center min-w-0">
                              <span className="text-sm text-gray-900 truncate">
                                {item.name}
                              </span>
                              {item.code && (
                                <span className="ml-2 text-xs text-gray-500">
                                  ({item.code})
                                </span>
                              )}
                            </div>
                            {item.hasBlocker && (
                              <span className="ml-2 text-xs text-yellow-600 flex-shrink-0">
                                {item.blockerReason}
                              </span>
                            )}
                            {item.status && !item.hasBlocker && (
                              <span className="ml-2 text-xs text-gray-500 flex-shrink-0">
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
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm text-green-700">
                Bu {entityType.toLowerCase()} silindığında başka hiçbir öğe etkilenmeyecektir.
              </p>
            </div>
          )}

          {/* Warning message */}
          <div className="p-3 bg-gray-50 rounded-lg">
            <p className="text-xs text-gray-500">
              <strong>Not:</strong> Silme işlemi soft delete olarak yapılacaktır.
              Veriler tamamen silinmez, sadece gizlenir ve gerektiğinde geri alınabilir.
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-gray-200">
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={isDeleting}
        >
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
