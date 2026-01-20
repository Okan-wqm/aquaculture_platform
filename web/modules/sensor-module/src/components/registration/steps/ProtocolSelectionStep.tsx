import React, { useState, useMemo } from 'react';
import { useProtocols, useCategoryInfo, useCategoryStats } from '../../../hooks/useProtocols';
import { ProtocolInfo, ProtocolCategory } from '../../../types/registration.types';

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
    <button
      onClick={onClick}
      className={`p-4 border-2 rounded-lg text-left transition-all ${
        isSelected
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center space-x-3">
        <span className="text-2xl">{iconMap[category]}</span>
        <div>
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <p className="text-sm text-gray-500">{description}</p>
          <span className="text-xs text-blue-600">{count} protocols</span>
        </div>
      </div>
    </button>
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
    <button
      onClick={onClick}
      className={`p-4 border-2 rounded-lg text-left transition-all w-full ${
        isSelected
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex justify-between items-start">
        <div>
          <h4 className="font-medium text-gray-900">{protocol.displayName}</h4>
          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{protocol.description}</p>
          <div className="flex flex-wrap gap-1 mt-2">
            <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
              {protocol.subcategory}
            </span>
            <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
              {protocol.connectionType}
            </span>
          </div>
        </div>
        {isSelected && (
          <span className="text-blue-500">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        )}
      </div>
      {/* Capabilities */}
      <div className="flex flex-wrap gap-1 mt-3">
        {protocol.capabilities?.supportsDiscovery && (
          <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded">Discovery</span>
        )}
        {protocol.capabilities?.supportsPolling && (
          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">Polling</span>
        )}
        {protocol.capabilities?.supportsSubscription && (
          <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">Subscribe</span>
        )}
        {protocol.capabilities?.supportsEncryption && (
          <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded">Encrypted</span>
        )}
      </div>
    </button>
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
          p.code.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [protocols, protocolsByCategory, selectedCategory, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Loading protocols...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        Failed to load protocols: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Search */}
      <div>
        <input
          type="text"
          placeholder="Search protocols..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Category cards */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 mb-3">Filter by Category</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(ProtocolCategory).map(([key, value]) => (
            <CategoryCard
              key={value}
              category={value}
              title={categoryInfo[value].title}
              description={categoryInfo[value].description}
              count={stats ? stats[value as keyof typeof stats] : 0}
              isSelected={selectedCategory === value}
              onClick={() => setSelectedCategory(selectedCategory === value ? null : value)}
            />
          ))}
        </div>
      </div>

      {/* Protocol list */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-sm font-medium text-gray-700">
            {selectedCategory
              ? `${categoryInfo[selectedCategory].title} Protocols`
              : 'All Protocols'}
          </h3>
          <span className="text-sm text-gray-500">{filteredProtocols.length} protocols</span>
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
          <div className="text-center py-8 text-gray-500">
            No protocols found matching your criteria.
          </div>
        )}
      </div>
    </div>
  );
}

export default ProtocolSelectionStep;
