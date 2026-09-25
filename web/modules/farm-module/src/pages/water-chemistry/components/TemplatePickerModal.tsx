/**
 * Template Picker Modal
 *
 * Modal that displays available parameter templates for tenant admins to apply.
 * Each template card shows name, description, species badges, and parameter count.
 * Includes an overwrite checkbox to control whether existing params are replaced.
 */
import React, { useState } from 'react';
import { Button, Checkbox, Modal, Spinner, ToggleButton } from '@aquaculture/shared-ui';
import { useParameterTemplates, ParameterTemplate } from '../../../hooks/useParameterConfigs';
import { CircleCheck, TriangleAlert } from 'lucide-react';

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
      <div className="mb-4 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg p-3">
        <div className="flex">
          <TriangleAlert
            className="h-5 w-5 text-warning-400 mr-2 flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <p className="text-sm text-warning-800 dark:text-warning-200">
            This will configure your water quality parameters. Existing parameters can be kept or
            replaced.
          </p>
        </div>
      </div>

      {/* Content */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Spinner size="xl" />
        </div>
      )}

      {error && (
        <div className="mb-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 text-sm text-error-800 dark:text-error-200">
          Failed to load templates: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && templates && templates.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No templates available.
        </div>
      )}

      {!isLoading && !error && templates && templates.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-96 overflow-y-auto mb-4">
          {templates.map((tpl: ParameterTemplate) => {
            const isSelected = selectedId === tpl.templateId;
            return (
              <ToggleButton
                key={tpl.templateId}
                type="button"
                onClick={() => setSelectedId(tpl.templateId)}
                pressed={isSelected}
                className="text-left border-2 rounded-lg p-4 transition-colors"
                pressedClassName="border-info-500 bg-info-50 dark:bg-info-900/20"
                idleClassName="border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500 bg-white dark:bg-gray-900"
              >
                <div className="flex items-start justify-between mb-2">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {tpl.name}
                  </h4>
                  {isSelected && (
                    <CircleCheck
                      className="w-5 h-5 text-info-600 dark:text-info-400 flex-shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 line-clamp-2">
                  {tpl.description}
                </p>

                {/* Species Badges */}
                {tpl.species && tpl.species.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {tpl.species.map((sp: string) => (
                      <span
                        key={sp}
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200"
                      >
                        {sp}
                      </span>
                    ))}
                  </div>
                )}

                {/* Parameter Count */}
                <div className="text-xs text-gray-400 dark:text-gray-500">
                  {tpl.parameterCount} parameter{tpl.parameterCount !== 1 ? 's' : ''}
                </div>
              </ToggleButton>
            );
          })}
        </div>
      )}

      {/* Overwrite Checkbox */}
      <div className="mb-4">
        <Checkbox
          label="Replace existing parameters"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
        />
      </div>

      {/* Footer */}
      <div className="flex justify-end space-x-3 pt-4 border-t">
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={handleApply}
          disabled={!selectedId || isSubmitting}
        >
          {isSubmitting ? 'Applying...' : 'Apply Template'}
        </Button>
      </div>
    </Modal>
  );
};
