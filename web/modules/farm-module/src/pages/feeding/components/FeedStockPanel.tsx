/**
 * Feed Stock Panel Component
 *
 * Shows feed inventory levels with stockout predictions
 * and reorder recommendations
 */
import React from 'react';
import { FeedForecastResult, getAlertColor } from '../../../hooks/useFeeding';

interface FeedStockPanelProps {
  forecastData?: FeedForecastResult | null;
}

export const FeedStockPanel: React.FC<FeedStockPanelProps> = ({ forecastData }) => {
  if (!forecastData) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        No forecast data available.
      </div>
    );
  }

  // Calculate stock health percentage
  const getStockHealthColor = (daysUntilStockout: number, forecastDays: number): string => {
    if (daysUntilStockout <= 3) return 'bg-red-500';
    if (daysUntilStockout <= 7) return 'bg-orange-500';
    if (daysUntilStockout <= 14) return 'bg-yellow-500';
    if (daysUntilStockout > forecastDays) return 'bg-green-500';
    return 'bg-blue-500';
  };

  const getStockHealthText = (daysUntilStockout: number, forecastDays: number): string => {
    if (daysUntilStockout <= 3) return 'Critical';
    if (daysUntilStockout <= 7) return 'Low';
    if (daysUntilStockout <= 14) return 'Warning';
    if (daysUntilStockout > forecastDays) return 'Healthy';
    return 'Monitor';
  };

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Feed Stock</p>
          <p className="text-2xl font-semibold text-gray-900">
            {(forecastData.totalCurrentStock / 1000).toFixed(2)} t
          </p>
          <p className="text-xs text-gray-500">
            {forecastData.totalCurrentStock.toFixed(0)} kg
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Consumption ({forecastData.forecastDays}d)</p>
          <p className="text-2xl font-semibold text-gray-900">
            {(forecastData.totalConsumption / 1000).toFixed(2)} t
          </p>
          <p className="text-xs text-gray-500">
            {forecastData.totalConsumption.toFixed(0)} kg projected
          </p>
        </div>
        <div className={`rounded-lg shadow p-4 ${forecastData.alerts.length > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
          <p className="text-sm text-gray-500">Stock Health</p>
          <p className={`text-2xl font-semibold ${forecastData.alerts.length > 0 ? 'text-red-600' : 'text-green-600'}`}>
            {forecastData.alerts.length === 0 ? 'Good' : `${forecastData.alerts.length} Issues`}
          </p>
          <p className="text-xs text-gray-500">
            {forecastData.byFeedType.length} feed types tracked
          </p>
        </div>
      </div>

      {/* Alerts */}
      {forecastData.alerts.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b border-gray-200 bg-red-50">
            <h3 className="text-lg font-medium text-red-900">Action Required</h3>
          </div>
          <div className="p-4 space-y-3">
            {forecastData.alerts.map((alert, index) => (
              <div
                key={index}
                className={`rounded-lg p-4 border ${getAlertColor(alert.type)}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{alert.feedCode}</span>
                    <p className="text-sm mt-1">{alert.message}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-medium">{alert.daysUntilStockout} days</span>
                    <p className="text-xs text-gray-500">until stockout</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feed Stock Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Feed Inventory Status</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Feed Type
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Current Stock
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Daily Usage
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Days Left
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Stockout Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Reorder By
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Recommended Order
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {forecastData.byFeedType.map((feed) => {
                const avgDailyUsage = feed.dailyConsumption.length > 0
                  ? feed.dailyConsumption.reduce((sum, d) => sum + d, 0) / feed.dailyConsumption.length
                  : 0;

                return (
                  <tr key={feed.feedId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{feed.feedName}</div>
                      <div className="text-sm text-gray-500">{feed.feedCode}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {feed.currentStock.toFixed(0)} kg
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                      ~{avgDailyUsage.toFixed(0)} kg/day
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span
                        className={`font-medium ${
                          feed.daysUntilStockout <= 7
                            ? 'text-red-600'
                            : feed.daysUntilStockout <= 14
                            ? 'text-orange-600'
                            : 'text-gray-900'
                        }`}
                      >
                        {feed.daysUntilStockout > forecastData.forecastDays
                          ? `>${forecastData.forecastDays}`
                          : feed.daysUntilStockout}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {feed.stockoutDate
                        ? new Date(feed.stockoutDate).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })
                        : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {feed.reorderDate ? (
                        <span
                          className={`${
                            new Date(feed.reorderDate) <= new Date()
                              ? 'text-red-600 font-medium'
                              : 'text-gray-500'
                          }`}
                        >
                          {new Date(feed.reorderDate).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {feed.reorderQuantity > 0 ? `${feed.reorderQuantity.toFixed(0)} kg` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium text-white ${getStockHealthColor(
                          feed.daysUntilStockout,
                          forecastData.forecastDays
                        )}`}
                      >
                        {getStockHealthText(feed.daysUntilStockout, forecastData.forecastDays)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stock Usage Timeline */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Stock Depletion Timeline</h3>
        <div className="space-y-4">
          {forecastData.byFeedType.map((feed) => {
            const percentRemaining = feed.currentStock > 0
              ? Math.min(100, ((feed.currentStock - feed.totalConsumption) / feed.currentStock) * 100)
              : 0;
            const percentUsed = 100 - Math.max(0, percentRemaining);

            return (
              <div key={feed.feedId}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700">{feed.feedCode}</span>
                  <span className="text-sm text-gray-500">
                    {feed.currentStock.toFixed(0)} kg - {feed.totalConsumption.toFixed(0)} kg = {' '}
                    {(feed.currentStock - feed.totalConsumption).toFixed(0)} kg
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                  <div
                    className={`h-4 rounded-full transition-all ${
                      percentRemaining < 0
                        ? 'bg-red-500'
                        : percentRemaining < 20
                        ? 'bg-orange-500'
                        : percentRemaining < 50
                        ? 'bg-yellow-500'
                        : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, 100 - percentUsed))}%` }}
                  >
                    <span className="sr-only">{Math.max(0, percentRemaining).toFixed(0)}% remaining</span>
                  </div>
                </div>
                {percentRemaining < 0 && (
                  <p className="text-xs text-red-600 mt-1">
                    Shortfall: {Math.abs(feed.currentStock - feed.totalConsumption).toFixed(0)} kg
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
