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

export const RecipePanel: React.FC<RecipePanelProps> = ({
  recipes,
  onRecipesChange,
  tagBus,
}) => {
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
          <BookOpen className="w-4 h-4 text-cyan-600" />
          <h4 className="text-sm font-medium text-gray-700">Recipes</h4>
          <span className="text-[11px] text-gray-400">({recipes.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleImport}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            title="Import recipes (JSON)"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleExport}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            title="Export recipes (JSON)"
            disabled={recipes.length === 0}
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowNewForm((s) => !s)}
            className="p-1.5 rounded hover:bg-cyan-50 text-cyan-600"
            title="Save current tag values as recipe"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* New recipe form */}
      {showNewForm && (
        <div className="p-3 bg-cyan-50 border border-cyan-200 rounded-lg space-y-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Recipe name"
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-cyan-500"
            data-testid="recipe-name-input"
            autoFocus
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-cyan-500"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveCurrent}
              disabled={!newName.trim()}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-cyan-600 rounded hover:bg-cyan-700 disabled:bg-cyan-300"
              data-testid="recipe-save-btn"
            >
              <Check className="w-3 h-3" />
              Save Current Values
            </button>
            <button
              onClick={() => setShowNewForm(false)}
              className="px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Recipe list */}
      {recipes.length === 0 && !showNewForm && (
        <div className="text-center py-6 text-xs text-gray-400">
          No recipes yet. Click + to save current values.
        </div>
      )}

      <div className="space-y-1">
        {recipes.map((recipe) => (
          <div
            key={recipe.id}
            className="border border-gray-200 rounded-lg overflow-hidden"
            data-testid={`recipe-item-${recipe.id}`}
          >
            {/* Recipe header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50">
              <button
                onClick={() => setExpandedId(expandedId === recipe.id ? null : recipe.id)}
                className="flex-1 flex items-center gap-2 text-left"
              >
                {expandedId === recipe.id ? (
                  <ChevronDown className="w-3 h-3 text-gray-400" />
                ) : (
                  <ChevronUp className="w-3 h-3 text-gray-400" />
                )}
                {editingId === recipe.id ? (
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 px-1 py-0.5 text-xs border border-cyan-300 rounded"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="text-xs font-medium text-gray-800 truncate">
                    {recipe.name}
                  </span>
                )}
                <span className="text-[10px] text-gray-400">
                  {Object.keys(recipe.values).length} tags
                </span>
              </button>

              <div className="flex items-center gap-0.5">
                {editingId === recipe.id ? (
                  <>
                    <button
                      onClick={() => handleSaveEdit(recipe.id)}
                      className="p-1 rounded hover:bg-green-100 text-green-600"
                      title="Save"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="p-1 rounded hover:bg-gray-200 text-gray-500"
                      title="Cancel"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => handleLoadRecipe(recipe)}
                      className="px-2 py-1 text-[10px] font-medium text-white bg-cyan-600 rounded hover:bg-cyan-700"
                      title="Load recipe values to tags"
                      data-testid={`recipe-load-${recipe.id}`}
                    >
                      Load
                    </button>
                    <button
                      onClick={() => handleStartEdit(recipe)}
                      className="p-1 rounded hover:bg-gray-200 text-gray-500"
                      title="Edit"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDuplicate(recipe)}
                      className="p-1 rounded hover:bg-gray-200 text-gray-500"
                      title="Duplicate"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDelete(recipe.id)}
                      className="p-1 rounded hover:bg-red-100 text-red-500"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Expanded details */}
            {expandedId === recipe.id && (
              <div className="px-3 py-2 border-t border-gray-100 space-y-1">
                {recipe.description && (
                  <p className="text-[11px] text-gray-500 mb-2">{recipe.description}</p>
                )}
                <div className="text-[10px] text-gray-400 mb-1">
                  Created: {new Date(recipe.createdAt).toLocaleString()}
                </div>
                <div className="max-h-32 overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="text-left py-0.5">Tag</th>
                        <th className="text-right py-0.5">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(recipe.values).map(([tag, val]) => (
                        <tr key={tag} className="border-t border-gray-50">
                          <td className="py-0.5 font-mono text-gray-700 truncate max-w-[140px]">
                            {tag}
                          </td>
                          <td className="py-0.5 text-right font-mono text-gray-600">
                            {String(val)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
