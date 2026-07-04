/**
 * Template Picker Modal
 *
 * Modal that displays available parameter templates for tenant admins to apply.
 * Each template card shows name, description, species badges, and parameter count.
 * Includes an overwrite checkbox to control whether existing params are replaced.
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import { useParameterTemplates, ParameterTemplate } from '../../../hooks/useParameterConfigs';

// ============================================================================
// TYPES
// ============================================================================

interface TemplatePickerModalProps {
  onApply: (templateId: string, overwrite: boolean) => void;
  onClose: () => void;
  isSubmitting: boolean;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const TemplatePickerModal: React.FC<TemplatePickerModalProps> = ({
  onApply,
  onClose,
  isSubmitting,
}) => {
  const { data: templates, isLoading, error } = useParameterTemplates();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  const handleApply = () => {
    if (!selectedId) return;
    onApply(selectedId, overwrite);
  };

  return (
    <Modal isOpen onClose={onClose} title="Apply Parameter Template" size="lg">
      {/* Warning Banner */}
      <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
        <div className="flex">
          <svg
            className="h-5 w-5 text-amber-400 mr-2 flex-shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p className="text-sm text-amber-800">
            This will configure your water quality parameters. Existing parameters can be kept or
            replaced.
          </p>
        </div>
      </div>

      {/* Content */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          Failed to load templates: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && templates && templates.length === 0 && (
        <div className="text-center py-12 text-gray-500">No templates available.</div>
      )}

      {!isLoading && !error && templates && templates.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-96 overflow-y-auto mb-4">
          {templates.map((tpl: ParameterTemplate) => {
            const isSelected = selectedId === tpl.templateId;
            return (
              <button
                key={tpl.templateId}
                type="button"
                onClick={() => setSelectedId(tpl.templateId)}
                className={`text-left border-2 rounded-lg p-4 transition-colors ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <h4 className="text-sm font-semibold text-gray-900">{tpl.name}</h4>
                  {isSelected && (
                    <svg
                      className="w-5 h-5 text-blue-600 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </div>
                <p className="text-xs text-gray-500 mb-3 line-clamp-2">{tpl.description}</p>

                {/* Species Badges */}
                {tpl.species && tpl.species.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {tpl.species.map((sp: string) => (
                      <span
                        key={sp}
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-800"
                      >
                        {sp}
                      </span>
                    ))}
                  </div>
                )}

                {/* Parameter Count */}
                <div className="text-xs text-gray-400">
                  {tpl.parameterCount} parameter{tpl.parameterCount !== 1 ? 's' : ''}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Overwrite Checkbox */}
      <div className="mb-4">
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">Replace existing parameters</span>
        </label>
      </div>

      {/* Footer */}
      <div className="flex justify-end space-x-3 pt-4 border-t">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={!selectedId || isSubmitting}
          className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? 'Applying...' : 'Apply Template'}
        </button>
      </div>
    </Modal>
  );
};
