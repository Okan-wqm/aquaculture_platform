/**
 * Industry Template Selector
 *
 * Card-based selector for choosing an industry template.
 * Displays available templates in a 3-column grid with selection and apply functionality.
 */

import React, { useState } from 'react';
import {
  AlertCircle,
  RefreshCw,
  CheckCircle,
  Settings,
  Loader2,
} from 'lucide-react';
import { useIndustryTemplates, useApplyTemplate, IndustryTemplate } from '../../hooks/useIndustryTemplates';

interface IndustryTemplateSelectorProps {
  onTemplateApplied?: () => void;
}

// ============================================================================
// Skeleton Card (loading state)
// ============================================================================

const SkeletonCard: React.FC = () => (
  <div className="p-5 bg-white rounded-xl border border-gray-200 animate-pulse">
    <div className="w-12 h-12 bg-gray-200 rounded-lg mb-4" />
    <div className="h-5 bg-gray-200 rounded w-3/4 mb-2" />
    <div className="h-4 bg-gray-100 rounded w-full mb-1" />
    <div className="h-4 bg-gray-100 rounded w-2/3 mb-4" />
    <div className="h-6 bg-gray-100 rounded-full w-20" />
  </div>
);

// ============================================================================
// Template Card
// ============================================================================

interface TemplateCardProps {
  template: IndustryTemplate;
  isSelected: boolean;
  onSelect: () => void;
}

const TemplateCard: React.FC<TemplateCardProps> = ({ template, isSelected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`relative p-5 bg-white rounded-xl border-2 text-left transition-all hover:shadow-md focus:outline-hidden focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 ${
      isSelected
        ? 'border-cyan-500 ring-1 ring-cyan-500 shadow-md'
        : 'border-gray-200 hover:border-gray-300'
    }`}
  >
    {/* Selection indicator */}
    {isSelected && (
      <div className="absolute top-3 right-3">
        <CheckCircle className="w-5 h-5 text-cyan-600" />
      </div>
    )}

    {/* Icon */}
    <div className="w-12 h-12 flex items-center justify-center rounded-lg bg-cyan-50 text-2xl mb-4">
      {template.icon || '📦'}
    </div>

    {/* Name */}
    <h3 className="text-base font-semibold text-gray-900 mb-1">
      {template.displayName}
    </h3>

    {/* Description */}
    <p className="text-sm text-gray-500 mb-4 line-clamp-2">
      {template.description}
    </p>

    {/* Sensor type count badge */}
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
      {template.sensorTypes.length} sensor tipi
    </span>
  </button>
);

// ============================================================================
// Custom / Skip Card
// ============================================================================

interface CustomCardProps {
  isSelected: boolean;
  onSelect: () => void;
}

const CustomCard: React.FC<CustomCardProps> = ({ isSelected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`relative p-5 bg-white rounded-xl border-2 border-dashed text-left transition-all hover:shadow-md focus:outline-hidden focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 ${
      isSelected
        ? 'border-cyan-500 ring-1 ring-cyan-500 shadow-md'
        : 'border-gray-300 hover:border-gray-400'
    }`}
  >
    {isSelected && (
      <div className="absolute top-3 right-3">
        <CheckCircle className="w-5 h-5 text-cyan-600" />
      </div>
    )}

    <div className="w-12 h-12 flex items-center justify-center rounded-lg bg-gray-100 mb-4">
      <Settings className="w-6 h-6 text-gray-500" />
    </div>

    <h3 className="text-base font-semibold text-gray-900 mb-1">
      Manuel Yapilandirma
    </h3>

    <p className="text-sm text-gray-500 mb-4 line-clamp-2">
      Sektorden bagimsiz olarak sensorlerinizi manuel olarak yapilandirin.
    </p>

    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
      Ozel kurulum
    </span>
  </button>
);

// ============================================================================
// Industry Template Selector
// ============================================================================

const IndustryTemplateSelector: React.FC<IndustryTemplateSelectorProps> = ({ onTemplateApplied }) => {
  const { templates, loading, error, refetch } = useIndustryTemplates();
  const { apply, loading: applying } = useApplyTemplate();

  // Selected template key or 'custom' for skip
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const handleApply = async () => {
    if (!selectedKey) return;

    if (selectedKey === '__custom__') {
      // Skip - go directly
      onTemplateApplied?.();
      return;
    }

    const result = await apply(selectedKey);
    if (result) {
      onTemplateApplied?.();
    }
  };

  // Error state
  if (error && !loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          Sablonlar yuklenemedi
        </h3>
        <p className="text-sm text-gray-500 mb-6">{error.message}</p>
        <button
          onClick={refetch}
          className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Tekrar Dene
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Template Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {loading ? (
          // Skeleton loading state
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isSelected={selectedKey === template.templateKey}
                onSelect={() => setSelectedKey(template.templateKey)}
              />
            ))}
            {/* Custom / Skip card */}
            <CustomCard
              isSelected={selectedKey === '__custom__'}
              onSelect={() => setSelectedKey('__custom__')}
            />
          </>
        )}
      </div>

      {/* Apply Button */}
      <div className="flex justify-end">
        <button
          onClick={handleApply}
          disabled={!selectedKey || applying}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm transition-colors ${
            selectedKey && !applying
              ? 'bg-cyan-600 text-white hover:bg-cyan-700'
              : 'bg-gray-200 text-gray-500 cursor-not-allowed'
          }`}
        >
          {applying && <Loader2 className="w-4 h-4 animate-spin" />}
          {selectedKey === '__custom__' ? 'Atla ve Devam Et' : 'Sablonu Uygula'}
        </button>
      </div>
    </div>
  );
};

export default IndustryTemplateSelector;
