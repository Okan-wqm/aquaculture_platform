import { useNavigate } from 'react-router-dom';
import { Skull, Scissors, Package } from 'lucide-react';
import type { Tank } from '@/types';
import { clsx } from 'clsx';

interface TankCardProps {
  tank: Tank;
}

export function TankCard({ tank }: TankCardProps) {
  const navigate = useNavigate();
  const batch = tank.currentBatch;

  if (!batch) return null;

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">{tank.name}</h3>
            <p className="text-xs text-gray-500">{tank.code}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-aqua-600 dark:text-aqua-400">
              {batch.speciesName}
            </p>
            <p className="text-xs text-gray-500">{batch.batchNumber}</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 divide-x divide-gray-100 dark:divide-gray-700">
        <div className="p-3 text-center">
          <div className="text-lg font-bold text-gray-900 dark:text-white">
            {formatNumber(batch.currentQuantity)}
          </div>
          <div className="text-xs text-gray-500">Fish</div>
        </div>
        <div className="p-3 text-center">
          <div className="text-lg font-bold text-gray-900 dark:text-white">
            {batch.averageWeight.toFixed(0)}g
          </div>
          <div className="text-xs text-gray-500">Avg Weight</div>
        </div>
        <div className="p-3 text-center">
          <div className="text-lg font-bold text-gray-900 dark:text-white">
            {batch.currentBiomassKg.toFixed(0)}kg
          </div>
          <div className="text-xs text-gray-500">Biomass</div>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-3 border-t border-gray-100 dark:border-gray-700">
        <button
          onClick={() => navigate(`/mortality/record/${tank.id}`)}
          className={clsx(
            'flex items-center justify-center gap-2 p-3',
            'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20',
            'touch-feedback border-r border-gray-100 dark:border-gray-700'
          )}
        >
          <Skull size={18} />
          <span className="text-sm font-medium">Mortality</span>
        </button>
        <button
          onClick={() => navigate(`/cull/record/${tank.id}`)}
          className={clsx(
            'flex items-center justify-center gap-2 p-3',
            'text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20',
            'touch-feedback border-r border-gray-100 dark:border-gray-700'
          )}
        >
          <Scissors size={18} />
          <span className="text-sm font-medium">Cull</span>
        </button>
        <button
          onClick={() => navigate(`/harvest/record/${tank.id}`)}
          className={clsx(
            'flex items-center justify-center gap-2 p-3',
            'text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20',
            'touch-feedback'
          )}
        >
          <Package size={18} />
          <span className="text-sm font-medium">Harvest</span>
        </button>
      </div>
    </div>
  );
}
