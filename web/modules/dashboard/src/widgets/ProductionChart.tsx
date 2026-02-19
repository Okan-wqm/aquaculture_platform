/**
 * Production Chart Widget
 *
 * Displays production trend data for a farm or tank.
 * TODO: Wire to farm-service GraphQL query for real production data.
 */

import React from 'react';
import { Card } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components — eliminates duplicate inline SVG bytes
import { TrendUpIcon } from '../components/icons';

export interface ProductionChartProps {
  farmId?: string;
  period?: '7days' | '30days' | '90days';
  className?: string;
}

export const ProductionChart: React.FC<ProductionChartProps> = ({
  farmId,
  period = '30days',
  className = '',
}) => {
  return (
    <Card className={`p-4 ${className}`}>
      <div className="text-center py-6 text-gray-400">
        <TrendUpIcon className="w-8 h-8 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-500">Üretim Grafiği</p>
        {farmId && <p className="text-xs text-gray-400 mt-1">Çiftlik: {farmId}</p>}
        <p className="text-xs text-gray-400 mt-1">Dönem: {period}</p>
        <p className="text-xs text-gray-400 mt-2">Veri bağlantısı kurulacak</p>
      </div>
    </Card>
  );
};

export default ProductionChart;
