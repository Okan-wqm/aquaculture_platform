import React, { useState, useMemo } from 'react';
import { useProtocols, useCategoryInfo, useCategoryStats } from '../../../hooks/useProtocols';
import { ProtocolInfo, ProtocolCategory } from '../../../types/registration.types';
import { Input, Spinner, ToggleButton } from '@aquaculture/shared-ui';
import { CircleCheck } from 'lucide-react';

interface ProtocolSelectionStepProps {
  selectedProtocol: string | null;
  onSelect: (protocol: ProtocolInfo) => void;
}

// Category card component
function CategoryCard({
  category,
  title,
  description,
  count,
  isSelected,
  onClick,
}: {
  category: ProtocolCategory;
  title: string;
  description: string;
  count: number;
  isSelected: boolean;
  onClick: () => void;
}) {
  const iconMap: Record<ProtocolCategory, string> = {
    [ProtocolCategory.INDUSTRIAL]: '🏭',
    [ProtocolCategory.IOT]: '📡',
    [ProtocolCategory.SERIAL]: '🔌',
    [ProtocolCategory.WIRELESS]: '📶',
  };

  return (
    <ToggleButton
      onClick={onClick}
      pressed={isSelected}
      className="p-4 border-2 rounded-lg text-left transition-all"
      pressedClassName="border-info-500 bg-info-50 dark:bg-info-900/20"
      idleClassName="border-gray-200 dark:border-gray-700 hover:border-info-300 hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      <div className="flex items-center space-x-3">
        <span className="text-2xl">{iconMap[category]}</span>
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>
          <span className="text-xs text-info-600 dark:text-info-400">{count} protocols</span>
        </div>
      </div>
    </ToggleButton>
  );
}

// Protocol card component
function ProtocolCard({
  protocol,
  isSelected,
  onClick,
}: {
  protocol: ProtocolInfo;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <ToggleButton
      onClick={onClick}
      pressed={isSelected}
      className="p-4 border-2 rounded-lg text-left transition-all w-full"
      pressedClassName="border-info-500 bg-info-50 dark:bg-info-900/20"
      idleClassName="border-gray-200 dark:border-gray-700 hover:border-info-300 hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      <div className="flex justify-between items-start">
        <div>
          <h4 className="font-medium text-gray-900 dark:text-gray-100">{protocol.displayName}</h4>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
            {protocol.description}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-xs rounded">
              {protocol.subcategory}
            </span>
            <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-xs rounded">
              {protocol.connectionType}
            </span>
          </div>
        </div>
        {isSelected && (
          <span className="text-info-500">
            <CircleCheck className="w-6 h-6" aria-hidden="true" />
          </span>
        )}
      </div>
      {/* Capabilities */}
      <div className="flex flex-wrap gap-1 mt-3">
        {protocol.capabilities?.supportsDiscovery && (
          <span className="px-2 py-0.5 bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300 text-xs rounded">
            Discovery
          </span>
        )}
        {protocol.capabilities?.supportsPolling && (
          <span className="px-2 py-0.5 bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300 text-xs rounded">
            Polling
          </span>
        )}
        {protocol.capabilities?.supportsSubscription && (
          <span className="px-2 py-0.5 bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 text-xs rounded">
            Subscribe
          </span>
        )}
        {protocol.capabilities?.supportsEncryption && (
          <span className="px-2 py-0.5 bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 text-xs rounded">
            Encrypted
          </span>
        )}
      </div>
    </ToggleButton>
  );
}

export function ProtocolSelectionStep({ selectedProtocol, onSelect }: ProtocolSelectionStepProps) {
  const [selectedCategory, setSelectedCategory] = useState<ProtocolCategory | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const { protocols, protocolsByCategory, loading, error } = useProtocols();
  const categoryInfo = useCategoryInfo();
  const { stats } = useCategoryStats();

  // Filter protocols based on category and search
  const filteredProtocols = useMemo(() => {
    let filtered = protocols;

    if (selectedCategory) {
      filtered = protocolsByCategory[selectedCategory] || [];
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.displayName.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          p.code.toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [protocols, protocolsByCategory, selectedCategory, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading protocols...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300">
        Failed to load protocols: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Search */}
      <div>
        <Input
          fullWidth
          type="text"
          placeholder="Search protocols..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Category cards */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Filter by Category
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(ProtocolCategory).map(([key, value]) => (
            <CategoryCard
              key={value}
              category={value}
              title={categoryInfo[value].title}
              description={categoryInfo[value].description}
              count={stats ? (stats[value] ?? 0) : 0}
              isSelected={selectedCategory === value}
              onClick={() => setSelectedCategory(selectedCategory === value ? null : value)}
            />
          ))}
        </div>
      </div>

      {/* Protocol list */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {selectedCategory
              ? `${categoryInfo[selectedCategory].title} Protocols`
              : 'All Protocols'}
          </h3>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {filteredProtocols.length} protocols
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-96 overflow-y-auto p-1">
          {filteredProtocols.map((protocol) => (
            <ProtocolCard
              key={protocol.code}
              protocol={protocol}
              isSelected={selectedProtocol === protocol.code}
              onClick={() => onSelect(protocol)}
            />
          ))}
        </div>

        {filteredProtocols.length === 0 && (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            No protocols found matching your criteria.
          </div>
        )}
      </div>
    </div>
  );
}

export default ProtocolSelectionStep;
