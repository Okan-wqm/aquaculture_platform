/**
 * SubEquipmentSection — Tier 3 Sub-Equipment CRUD (Scope C PR-9)
 *
 * Embedded inside `EquipmentTab` when editing an existing equipment.
 * Closes the gap that the original Scope C plan misread as "already
 * wired": the dual-mode `SubEquipmentModal` and the
 * `useSubEquipmentByParent` / `useUpdateSubEquipment` /
 * `useDeleteSubEquipment` hooks were all shipped, but no page ever
 * imported them, so the sub-equipment CRUD UI was unreachable end-
 * to-end. Same orphan-component pattern that FE-MEDIUM-001 closed
 * for the Tier 1 modals.
 *
 * What ships
 * ----------
 *   - List view fed by `useSubEquipmentByParent(parentEquipmentId)`
 *   - "Yeni Alt Ekipman" button (gated on `createSubEquipment`
 *     permission) opens `SubEquipmentModal` in create mode
 *   - Per-row "Düzenle" (gated on `updateSubEquipment`) opens the
 *     modal in edit mode
 *   - Per-row "Sil" (gated on `deleteSubEquipment`) triggers
 *     `ConfirmModal` then `useDeleteSubEquipment`
 *
 * Why a single component (not three siblings on EquipmentTab)
 * ----------------------------------------------------------
 * EquipmentTab is already ~1500 LOC. Putting list + create + edit +
 * delete state into the parent would balloon it. This section is
 * self-contained: hooks, modal state, confirm state all live here,
 * the parent only passes the parentEquipmentId.
 *
 * Distinction from EquipmentTab's existing "Sub-Equipment" panel
 * --------------------------------------------------------------
 * The pre-existing read-only panel in EquipmentTab.tsx:1115 lists
 * `equipment.childEquipment` — peer Equipment rows whose
 * `parentEquipmentId` points at this row. That's a DIFFERENT data
 * model from SubEquipment (which is a separate table for discrete
 * sub-components like sensors, valves, motors). This section
 * surfaces the SubEquipment table; the legacy childEquipment panel
 * stays untouched.
 */
import React, { useState } from 'react';
import {
  ConfirmModal,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import {
  type SubEquipment,
  useDeleteSubEquipment,
  useSubEquipmentByParent,
} from '../../../hooks/useSubEquipment';
import { SubEquipmentModal } from './SubEquipmentModal';

interface SubEquipmentSectionProps {
  parentEquipmentId: string;
  parentEquipmentTypeCode?: string;
}

const STATUS_BADGES: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  INACTIVE: 'bg-gray-100 text-gray-800',
  RETIRED: 'bg-red-100 text-red-800',
};

export const SubEquipmentSection: React.FC<SubEquipmentSectionProps> = ({
  parentEquipmentId,
  parentEquipmentTypeCode,
}) => {
  const { toast } = useToast();
  const canCreate = useCanMutate('createSubEquipment');
  const canUpdate = useCanMutate('updateSubEquipment');
  const canDelete = useCanMutate('deleteSubEquipment');

  const subEquipmentQuery = useSubEquipmentByParent(parentEquipmentId);
  const deleteMutation = useDeleteSubEquipment();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SubEquipment | null>(null);
  const [deleting, setDeleting] = useState<SubEquipment | null>(null);

  const items = subEquipmentQuery.data ?? [];

  const handleConfirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast({
        title: 'Alt ekipman silindi',
        description: `${deleting.name} (${deleting.code}) kaldırıldı.`,
        variant: 'success',
      });
      setDeleting(null);
    } catch (err) {
      toast({
        title: 'Silme başarısız',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium text-gray-700">
          Alt Ekipmanlar
        </label>
        {canCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            + Yeni Alt Ekipman
          </button>
        )}
      </div>

      <div className="border border-gray-200 rounded-md overflow-hidden">
        {subEquipmentQuery.isLoading ? (
          <div className="p-3 text-sm text-gray-500">Yükleniyor…</div>
        ) : subEquipmentQuery.isError ? (
          <div className="p-3 text-sm text-red-700">
            Alt ekipmanlar yüklenemedi.
          </div>
        ) : items.length === 0 ? (
          <div className="p-3 text-sm text-gray-500">
            Bu ekipmana bağlı alt ekipman yok.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase">
                  Ad
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase">
                  Tür
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase">
                  Durum
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase">
                  İşlem
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-sm">
                    <div className="font-medium text-gray-900">
                      {item.name}
                    </div>
                    <div className="text-xs text-gray-500">{item.code}</div>
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-700">
                    {item.subEquipmentType?.name ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full ${
                        STATUS_BADGES[item.status ?? 'ACTIVE'] ?? 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {item.status ?? 'ACTIVE'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-sm">
                    <div className="flex items-center justify-end gap-3">
                      {canUpdate && (
                        <button
                          type="button"
                          onClick={() => setEditing(item)}
                          className="text-indigo-600 hover:text-indigo-900"
                        >
                          Düzenle
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => setDeleting(item)}
                          className="text-red-600 hover:text-red-800"
                          disabled={deleteMutation.isPending}
                        >
                          Sil
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <SubEquipmentModal
          isOpen={createOpen}
          onClose={() => setCreateOpen(false)}
          mode="create"
          parentEquipmentId={parentEquipmentId}
          parentEquipmentTypeCode={parentEquipmentTypeCode}
          onSuccess={() => subEquipmentQuery.refetch()}
        />
      )}

      {editing && (
        <SubEquipmentModal
          isOpen={!!editing}
          onClose={() => setEditing(null)}
          mode="edit"
          parentEquipmentId={parentEquipmentId}
          parentEquipmentTypeCode={parentEquipmentTypeCode}
          existing={editing}
          onSuccess={() => subEquipmentQuery.refetch()}
        />
      )}

      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleConfirmDelete}
        title="Alt ekipman silinsin mi?"
        message={
          deleting ? (
            <span>
              <strong className="font-semibold">{deleting.name}</strong>{' '}
              ({deleting.code}) kaydı arşivlenir. Bu işlem soft-delete
              uygular — gerekirse veri tabanından geri yüklenebilir,
              ancak UI üzerinden listede görünmez.
            </span>
          ) : (
            ''
          )
        }
        confirmText="Sil"
        cancelText="İptal"
        variant="danger"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
};

export default SubEquipmentSection;
