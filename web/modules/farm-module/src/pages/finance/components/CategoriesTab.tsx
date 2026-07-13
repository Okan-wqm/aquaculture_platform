/**
 * Finance Categories tab — the dynamic, user-managed expense taxonomy.
 *
 * Categories are per-tenant DATA rows (never database DDL): adding one
 * inserts a row into the tenant's own schema. System categories carry a
 * stable code (derivation/rules bind to the code, so renaming the
 * display name is always safe); categories bound to derived sources or
 * computed rules cannot be archived — the backend enforces this and the
 * UI hides the action.
 */
import React, { useState } from 'react';

import { useCanMutate } from '@aquaculture/shared-ui';

import {
  FinanceCategory,
  useArchiveFinanceCategory,
  useCreateFinanceCategory,
  useFinanceCategories,
  useRestoreFinanceCategory,
  useUpdateFinanceCategory,
} from '../../../hooks/useFinance';

export const CategoriesTab: React.FC = () => {
  const [includeArchived, setIncludeArchived] = useState(false);
  const categoriesQuery = useFinanceCategories(undefined, includeArchived);
  const createCategory = useCreateFinanceCategory();
  const updateCategory = useUpdateFinanceCategory();
  const archiveCategory = useArchiveFinanceCategory();
  const restoreCategory = useRestoreFinanceCategory();
  const canCreate = useCanMutate('createFinanceCategory');
  const canUpdate = useCanMutate('updateFinanceCategory');
  const canArchiveCat = useCanMutate('archiveFinanceCategory');
  const canRestore = useCanMutate('restoreFinanceCategory');

  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState<'FARM_OPEX' | 'FARM_REVENUE'>('FARM_OPEX');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const categories = categoriesQuery.data ?? [];

  const handleCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setErrorMessage(null);
    if (!newName.trim()) return;
    try {
      await createCategory.mutateAsync({
        name: newName.trim(),
        scope: newScope,
        kind: newScope === 'FARM_REVENUE' ? 'REVENUE' : 'EXPENSE',
      });
      setNewName('');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Creating the category failed.');
    }
  };

  const handleRename = async (): Promise<void> => {
    if (!renaming || !renaming.name.trim()) return;
    setErrorMessage(null);
    try {
      await updateCategory.mutateAsync({ id: renaming.id, input: { name: renaming.name.trim() } });
      setRenaming(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Renaming the category failed.');
    }
  };

  const handleArchive = async (category: FinanceCategory): Promise<void> => {
    setErrorMessage(null);
    if (!window.confirm(`Archive category "${category.name}"? Existing entries keep it as history.`)) {
      return;
    }
    try {
      await archiveCategory.mutateAsync(category.id);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Archiving the category failed.');
    }
  };

  const canArchive = (category: FinanceCategory): boolean =>
    canArchiveCat && category.isActive && !category.computedRule && !(category.isSystem && category.code && DERIVED_CODES.has(category.code));

  return (
    <div className="space-y-6">
      {/* Create form — only for roles allowed to create categories */}
      {canCreate && (
      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3 rounded-lg bg-white p-4 shadow">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="new-category-name" className="block text-sm font-medium text-gray-700">
            New category name
          </label>
          <input
            id="new-category-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="e.g. Diesel fuel"
          />
        </div>
        <div>
          <label htmlFor="new-category-scope" className="block text-sm font-medium text-gray-700">
            Ledger
          </label>
          <select
            id="new-category-scope"
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as typeof newScope)}
            className="mt-1 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="FARM_OPEX">Operational cost</option>
            <option value="FARM_REVENUE">Revenue</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={createCategory.isPending || !newName.trim()}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          Add category
        </button>
        <label className="ml-auto flex items-center space-x-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>Show archived</span>
        </label>
      </form>
      )}

      {errorMessage && (
        <div role="alert" aria-live="assertive" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* Category list */}
      <div className="overflow-hidden rounded-lg bg-white shadow">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {['Name', 'Ledger', 'Type', ''].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {categoriesQuery.isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                  Loading categories…
                </td>
              </tr>
            )}
            {categories.map((category) => (
              <tr key={category.id} className={category.isActive ? '' : 'opacity-50'}>
                <td className="px-4 py-3 text-sm text-gray-900">
                  {renaming?.id === category.id ? (
                    <span className="flex items-center space-x-2">
                      <input
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: category.id, name: e.target.value })}
                        className="rounded-md border-gray-300 text-sm shadow-sm"
                        autoFocus
                      />
                      <button onClick={handleRename} className="text-sm font-medium text-blue-600">
                        Save
                      </button>
                      <button onClick={() => setRenaming(null)} className="text-sm text-gray-500">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <>
                      {category.name}
                      {category.isSystem && (
                        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                          system
                        </span>
                      )}
                      {category.computedRule && (
                        <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
                          {category.computedRule.percent}% rule
                        </span>
                      )}
                      {category.code && DERIVED_CODES.has(category.code) && (
                        <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                          auto-fed
                        </span>
                      )}
                      {!category.isActive && (
                        <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700">
                          archived
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {category.scope === 'FARM_OPEX' ? 'Operational cost' : 'Revenue'}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {category.kind === 'REVENUE' ? 'Revenue' : 'Expense'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                  <span className="space-x-3">
                    {canUpdate && category.isActive && renaming?.id !== category.id && (
                      <button
                        onClick={() => setRenaming({ id: category.id, name: category.name })}
                        className="font-medium text-blue-600 hover:text-blue-800"
                      >
                        Rename
                      </button>
                    )}
                    {canArchive(category) && (
                      <button
                        onClick={() => handleArchive(category)}
                        className="font-medium text-red-600 hover:text-red-800"
                      >
                        Archive
                      </button>
                    )}
                    {canRestore && !category.isActive && (
                      <button
                        onClick={() => restoreCategory.mutate(category.id)}
                        className="font-medium text-green-600 hover:text-green-800"
                      >
                        Restore
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * System codes that are auto-fed by derived cost sources. Mirrors the
 * backend DERIVED_COST_SOURCES registry — used ONLY to hide the archive
 * action; the backend guard is the enforcement.
 */
const DERIVED_CODES = new Set([
  'FEED',
  'FINGERLINGS',
  'MAINTENANCE',
  'HEALTH_TREATMENT',
  'HARVEST_REVENUE',
  'HARVEST_COST',
]);
