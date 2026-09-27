/**
 * Save and load named parameter sets ("recipes") to tags.
 * In aquaculture, different fish species or growth stages require
 * different setpoint configurations. Recipes allow operators to
 * switch between pre-defined parameter sets with one click.
 *
 * Architecture: Recipes are stored in the SCADA package JSON as
 * named tag-value maps. Loading a recipe writes all values to
 * TagValueBus, which propagates to the backend via the normal
 * tag write pipeline.
 *
 * Tenant-scoped: recipes are per-package, stored alongside screens.
 *
 * The component is designed as a standalone panel that can be embedded
 * in PropertiesPanel or displayed as a sidebar section in package settings.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Upload,
  Download,
  Trash2,
  Copy,
  Pencil,
  Check,
  X,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { TagValueBus } from '../../engine/tags/TagValueBus';
import { DataTable, type DataTableColumn, Button, Input } from '@aquaculture/shared-ui';

type RecipeValueEntry = [string, number | string | boolean];

const recipeValueColumns: DataTableColumn<RecipeValueEntry>[] = [
  {
    key: 'tag',
    header: 'Tag',
    render: (_value, [tag]) => (
      <span className="block max-w-[140px] truncate font-mono text-gray-700 dark:text-gray-300">
        {tag}
      </span>
    ),
  },
  {
    key: 'value',
    header: 'Value',
    align: 'right',
    render: (_value, [, val]) => (
      <span className="font-mono text-gray-600 dark:text-gray-400">{String(val)}</span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScadaRecipe {
  id: string;
  name: string;
  description?: string;
  values: Record<string, number | string | boolean>;
  createdAt: string;
}

interface RecipePanelProps {
  recipes: ScadaRecipe[];
  onRecipesChange: (recipes: ScadaRecipe[]) => void;
  /** TagValueBus instance for reading current values and writing recipe values. */
  tagBus?: TagValueBus | null;
}

// ---------------------------------------------------------------------------
// ID Generator
// ---------------------------------------------------------------------------

function generateRecipeId(): string {
  return `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const RecipePanel: React.FC<RecipePanelProps> = ({ recipes, onRecipesChange, tagBus }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  // Save current tag values as a new recipe
  const handleSaveCurrent = useCallback(() => {
    if (!newName.trim()) return;

    const snapshot = tagBus?.getSnapshot() ?? {};
    const values: Record<string, number | string | boolean> = {};

    for (const [key, val] of Object.entries(snapshot)) {
      if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
        values[key] = val;
      }
    }

    const recipe: ScadaRecipe = {
      id: generateRecipeId(),
      name: newName.trim(),
      description: newDesc.trim() || undefined,
      values,
      createdAt: new Date().toISOString(),
    };

    onRecipesChange([...recipes, recipe]);
    setNewName('');
    setNewDesc('');
    setShowNewForm(false);
  }, [newName, newDesc, tagBus, recipes, onRecipesChange]);

  // Load a recipe — writes all values to TagValueBus
  const handleLoadRecipe = useCallback(
    (recipe: ScadaRecipe) => {
      if (!tagBus) return;

      for (const [tag, value] of Object.entries(recipe.values)) {
        tagBus.publish(tag, value);
      }
    },
    [tagBus],
  );

  // Delete a recipe
  const handleDelete = useCallback(
    (id: string) => {
      onRecipesChange(recipes.filter((r) => r.id !== id));
      if (editingId === id) setEditingId(null);
      if (expandedId === id) setExpandedId(null);
    },
    [recipes, onRecipesChange, editingId, expandedId],
  );

  // Duplicate a recipe
  const handleDuplicate = useCallback(
    (recipe: ScadaRecipe) => {
      const dup: ScadaRecipe = {
        ...recipe,
        id: generateRecipeId(),
        name: `${recipe.name} (copy)`,
        createdAt: new Date().toISOString(),
      };
      onRecipesChange([...recipes, dup]);
    },
    [recipes, onRecipesChange],
  );

  // Start editing a recipe
  const handleStartEdit = useCallback((recipe: ScadaRecipe) => {
    setEditingId(recipe.id);
    setEditName(recipe.name);
    setEditDesc(recipe.description ?? '');
  }, []);

  // Save edit
  const handleSaveEdit = useCallback(
    (id: string) => {
      onRecipesChange(
        recipes.map((r) =>
          r.id === id
            ? { ...r, name: editName.trim() || r.name, description: editDesc.trim() || undefined }
            : r,
        ),
      );
      setEditingId(null);
    },
    [recipes, onRecipesChange, editName, editDesc],
  );

  // Export recipes as JSON
  const handleExport = useCallback(() => {
    const json = JSON.stringify(recipes, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `scada-recipes-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [recipes]);

  // Import recipes from JSON
  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = JSON.parse(text) as ScadaRecipe[];
        if (!Array.isArray(imported)) return;

        // Assign new IDs to avoid conflicts
        const withNewIds = imported.map((r) => ({
          ...r,
          id: generateRecipeId(),
          createdAt: r.createdAt || new Date().toISOString(),
        }));

        onRecipesChange([...recipes, ...withNewIds]);
      } catch {
        // Silently ignore malformed JSON — user will see no change
      }
    };
    input.click();
  }, [recipes, onRecipesChange]);

  return (
    <div className="space-y-3" data-testid="recipe-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-info-600 dark:text-info-400" />
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Recipes</h4>
          <span className="text-[11px] text-gray-400 dark:text-gray-500">({recipes.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Import recipes (JSON)"
            onClick={handleImport}
            title="Import recipes (JSON)"
          >
            <Upload className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Export recipes (JSON)"
            onClick={handleExport}
            title="Export recipes (JSON)"
            disabled={recipes.length === 0}
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Save current tag values as recipe"
            onClick={() => setShowNewForm((s) => !s)}
            title="Save current tag values as recipe"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* New recipe form */}
      {showNewForm && (
        <div className="p-3 bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg space-y-2">
          <Input
            fullWidth
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Recipe name"
            data-testid="recipe-name-input"
            autoFocus
          />
          <Input
            fullWidth
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="xs"
              leftIcon={<Check className="w-3 h-3" />}
              onClick={handleSaveCurrent}
              disabled={!newName.trim()}
              data-testid="recipe-save-btn"
            >
              Save Current Values
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setShowNewForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Recipe list */}
      {recipes.length === 0 && !showNewForm && (
        <div className="text-center py-6 text-xs text-gray-400 dark:text-gray-500">
          No recipes yet. Click + to save current values.
        </div>
      )}

      <div className="space-y-1">
        {recipes.map((recipe) => (
          <div
            key={recipe.id}
            className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
            data-testid={`recipe-item-${recipe.id}`}
          >
            {/* Recipe header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => setExpandedId(expandedId === recipe.id ? null : recipe.id)}
              >
                {expandedId === recipe.id ? (
                  <ChevronDown className="w-3 h-3 text-gray-400 dark:text-gray-500" />
                ) : (
                  <ChevronUp className="w-3 h-3 text-gray-400 dark:text-gray-500" />
                )}
                {editingId === recipe.id ? (
                  <Input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                    {recipe.name}
                  </span>
                )}
                <span className="text-[10px] text-gray-400 dark:text-gray-500">
                  {Object.keys(recipe.values).length} tags
                </span>
              </Button>

              <div className="flex items-center gap-0.5">
                {editingId === recipe.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Save"
                      onClick={() => handleSaveEdit(recipe.id)}
                      title="Save"
                    >
                      <Check className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Cancel"
                      onClick={() => setEditingId(null)}
                      title="Cancel"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="xs"
                      onClick={() => handleLoadRecipe(recipe)}
                      title="Load recipe values to tags"
                      data-testid={`recipe-load-${recipe.id}`}
                    >
                      Load
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Edit"
                      onClick={() => handleStartEdit(recipe)}
                      title="Edit"
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Duplicate"
                      onClick={() => handleDuplicate(recipe)}
                      title="Duplicate"
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Delete"
                      onClick={() => handleDelete(recipe.id)}
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Expanded details */}
            {expandedId === recipe.id && (
              <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700 space-y-1">
                {recipe.description && (
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
                    {recipe.description}
                  </p>
                )}
                <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-1">
                  Created: {new Date(recipe.createdAt).toLocaleString()}
                </div>
                <div className="max-h-32 overflow-auto">
                  <DataTable<RecipeValueEntry>
                    data={Object.entries(recipe.values)}
                    columns={recipeValueColumns}
                    keyExtractor={([tag]) => tag}
                    emptyMessage="No values"
                    searchable={false}
                    sortable={false}
                    stickyHeader={false}
                    compact
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default RecipePanel;
