/**
 * Storage Overview Tab - Dashboard with stats, low stock alerts, recent movements
 */
import React from 'react';
import { overviewStats, lowStockAlerts } from '../mock';
import { stockMovements } from '../mock';

const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat('nb-NO', { style: 'currency', currency }).format(amount);

const movementTypeBadge: Record<string, string> = {
  IN: 'bg-green-100 text-green-800',
  OUT: 'bg-red-100 text-red-800',
  TRANSFER: 'bg-blue-100 text-blue-800',
  WASTE: 'bg-gray-100 text-gray-800',
  ADJUSTMENT: 'bg-yellow-100 text-yellow-800',
  RETURN: 'bg-purple-100 text-purple-800',
};

export const OverviewTab: React.FC = () => {
  const recentMovements = stockMovements.slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Total Stock Value</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(overviewStats.totalStockValue, overviewStats.currency)}</div>
          <div className="mt-1 text-xs text-gray-400">{overviewStats.totalItems} items across {overviewStats.totalLocations} locations</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Low Stock Alerts</div>
          <div className="mt-1 text-2xl font-bold text-red-600">{overviewStats.lowStockAlerts}</div>
          <div className="mt-1 text-xs text-gray-400">Items below minimum threshold</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Pending Orders</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{overviewStats.pendingOrders}</div>
          <div className="mt-1 text-xs text-gray-400">Awaiting delivery</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Recent Movements</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{overviewStats.recentMovements}</div>
          <div className="mt-1 text-xs text-gray-400">Last 7 days</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Low Stock Alerts */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Low Stock Alerts</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {lowStockAlerts.map(alert => (
              <div key={alert.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-900">{alert.itemName}</div>
                  <div className="text-xs text-gray-500">{alert.category}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm">
                    <span className={alert.severity === 'critical' ? 'text-red-600 font-semibold' : 'text-yellow-600 font-medium'}>
                      {alert.currentStock}
                    </span>
                    <span className="text-gray-400"> / {alert.minStock} {alert.unit}</span>
                  </div>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                    alert.severity === 'critical' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {alert.severity}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Movements */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Recent Movements</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {recentMovements.map(m => (
              <div key={m.id} className="px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${movementTypeBadge[m.type] || 'bg-gray-100 text-gray-800'}`}>
                    {m.type}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-gray-900">{m.itemName}</div>
                    <div className="text-xs text-gray-500">{m.performedBy}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-gray-900">
                    {m.type === 'OUT' || m.type === 'WASTE' ? '-' : '+'}{Math.abs(m.quantity)} {m.unit}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(m.date).toLocaleDateString('nb-NO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Category Distribution */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Stock Distribution by Category</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Feed', value: 11475, color: 'bg-amber-500' },
            { label: 'Chemicals', value: 813, color: 'bg-blue-500' },
            { label: 'Consumables', value: 2012, color: 'bg-green-500' },
            { label: 'Fish Health', value: 596, color: 'bg-red-500' },
          ].map(cat => (
            <div key={cat.label} className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${cat.color}`} />
              <div>
                <div className="text-sm font-medium text-gray-900">{cat.label}</div>
                <div className="text-xs text-gray-500">{cat.value.toLocaleString()} units</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default OverviewTab;
