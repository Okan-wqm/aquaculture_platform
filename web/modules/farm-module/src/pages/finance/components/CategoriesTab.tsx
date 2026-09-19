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

import {
  useCanMutate,
  useConfirm,
  DataTable,
  type DataTableColumn,
  Button,
  Input,
  Select,
} from '@aquaculture/shared-ui';

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

  const confirm = useConfirm();
  const handleArchive = async (category: FinanceCategory): Promise<void> => {
    setErrorMessage(null);
    if (
      !(await confirm({
        title: `Archive category "${category.name}"?`,
        message: 'Existing entries keep it as history.',
        confirmText: 'Archive',
        cancelText: 'Cancel',
        variant: 'warning',
      }))
    ) {
      return;
    }
    try {
      await archiveCategory.mutateAsync(category.id);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Archiving the category failed.');
    }
  };

  const canArchive = (category: FinanceCategory): boolean =>
    canArchiveCat &&
    category.isActive &&
    !category.computedRule &&
    !(category.isSystem && category.code && DERIVED_CODES.has(category.code));

  type CategoryRow = (typeof categories)[number];
  const categoryRowColumns: DataTableColumn<CategoryRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (_value, category) => (
        <>
          {renaming?.id === category.id ? (
            <span className="flex items-center space-x-2">
              <Input
                value={renaming.name}
                onChange={(e) => setRenaming({ id: category.id, name: e.target.value })}
                autoFocus
              />
              <Button variant="ghost" onClick={handleRename}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
            </span>
          ) : (
            <>
              {category.name}
              {category.isSystem && (
                <span className="ml-2 rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-400">
                  system
                </span>
              )}
              {category.computedRule && (
                <span className="ml-2 rounded bg-accent-100 dark:bg-accent-900/40 px-1.5 py-0.5 text-xs text-accent-700 dark:text-accent-300">
                  {category.computedRule.percent}% rule
                </span>
              )}
              {category.code && DERIVED_CODES.has(category.code) && (
                <span className="ml-2 rounded bg-info-100 dark:bg-info-900/40 px-1.5 py-0.5 text-xs text-info-700 dark:text-info-300">
                  auto-fed
                </span>
              )}
              {!category.isActive && (
                <span className="ml-2 rounded bg-warning-100 dark:bg-warning-900/40 px-1.5 py-0.5 text-xs text-warning-700 dark:text-warning-300">
                  archived
                </span>
              )}
            </>
          )}
        </>
      ),
    },
    {
      key: 'ledger',
      header: 'Ledger',
      render: (_value, category) =>
        category.scope === 'FARM_OPEX' ? 'Operational cost' : 'Revenue',
    },
    {
      key: 'type',
      header: 'Type',
      render: (_value, category) => (category.kind === 'REVENUE' ? 'Revenue' : 'Expense'),
    },
    {
      key: 'col',
      header: '',
      render: (_value, category) => (
        <span className="space-x-3">
          {canUpdate && category.isActive && renaming?.id !== category.id && (
            <Button
              variant="ghost"
              onClick={() => setRenaming({ id: category.id, name: category.name })}
            >
              Rename
            </Button>
          )}
          {canArchive(category) && (
            <Button variant="ghost" onClick={() => handleArchive(category)}>
              Archive
            </Button>
          )}
          {canRestore && !category.isActive && (
            <Button variant="ghost" onClick={() => restoreCategory.mutate(category.id)}>
              Restore
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Create form — only for roles allowed to create categories */}
      {canCreate && (
        <form
          onSubmit={handleCreate}
          className="flex flex-wrap items-end gap-3 rounded-lg bg-white dark:bg-gray-900 p-4 shadow"
        >
          <div className="flex-1 min-w-[200px]">
            <label
              htmlFor="new-category-name"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              New category name
            </label>
            <Input
              fullWidth
              id="new-category-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Diesel fuel"
            />
          </div>
          <div>
            <label
              htmlFor="new-category-scope"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Ledger
            </label>
            <Select
              options={[
                { value: 'FARM_OPEX', label: 'Operational cost' },
                { value: 'FARM_REVENUE', label: 'Revenue' },
              ]}
              id="new-category-scope"
              value={newScope}
              onChange={(e) => setNewScope(e.target.value as typeof newScope)}
            />
          </div>
          <Button
            variant="primary"
            type="submit"
            disabled={createCategory.isPending || !newName.trim()}
          >
            Add category
          </Button>
          <label className="ml-auto flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            <span>Show archived</span>
          </label>
        </form>
      )}

      {errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md bg-error-50 dark:bg-error-900/20 p-3 text-sm text-error-700 dark:text-error-300"
        >
          {errorMessage}
        </div>
      )}

      {/* Category list */}
      <DataTable<CategoryRow>
        data={categories}
        columns={categoryRowColumns}
        keyExtractor={(category) => category.id}
        loading={categoriesQuery.isLoading}
        loadingMessage="Loading categories…"
        emptyMessage="No categories"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        rowClassName={(category) => (category.isActive ? '' : 'opacity-50')}
      />
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
