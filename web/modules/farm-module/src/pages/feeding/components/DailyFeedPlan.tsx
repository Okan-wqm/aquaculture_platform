/**
 * Daily Feed Plan Component
 *
 * Shows day-by-day feeding requirements based on growth projections
 */
import React from 'react';
import { FeedForecastResult, formatDate } from '../../../hooks/useFeeding';

interface DailyFeedPlanProps {
  siteId: string;
  batchId: string;
  forecastDays: number;
  forecastData?: FeedForecastResult | null;
}

export const DailyFeedPlan: React.FC<DailyFeedPlanProps> = ({
  forecastDays,
  forecastData,
}) => {
  if (!forecastData) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        No forecast data available. Please ensure there are active batches.
      </div>
    );
  }

  // Prepare daily plan data
  const dailyPlan = [];
  const startDate = new Date(forecastData.startDate);

  for (let day = 0; day <= Math.min(forecastDays, 14); day++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + day);

    const feeds = forecastData.byFeedType.map((feed) => ({
      feedCode: feed.feedCode,
      feedName: feed.feedName,
      dailyAmount: feed.dailyConsumption[day] ?? 0,
    }));

    const totalDaily = feeds.reduce((sum, f) => sum + f.dailyAmount, 0);

    dailyPlan.push({
      day,
      date,
      isToday: day === 0,
      feeds,
      totalDaily,
    });
  }

  return (
    <div className="space-y-6">
      {/* Alerts Section */}
      {forecastData.alerts.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">Alerts</h3>
          </div>
          <div className="p-4 space-y-3">
            {forecastData.alerts.map((alert, index) => (
              <div
                key={index}
                className={`rounded-lg p-4 border ${
                  alert.type === 'STOCKOUT_IMMINENT'
                    ? 'bg-red-50 border-red-200'
                    : alert.type === 'REORDER_NOW'
                    ? 'bg-orange-50 border-orange-200'
                    : 'bg-yellow-50 border-yellow-200'
                }`}
              >
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg
                      className={`h-5 w-5 ${
                        alert.type === 'STOCKOUT_IMMINENT'
                          ? 'text-red-400'
                          : alert.type === 'REORDER_NOW'
                          ? 'text-orange-400'
                          : 'text-yellow-400'
                      }`}
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3
                      className={`text-sm font-medium ${
                        alert.type === 'STOCKOUT_IMMINENT'
                          ? 'text-red-800'
                          : alert.type === 'REORDER_NOW'
                          ? 'text-orange-800'
                          : 'text-yellow-800'
                      }`}
                    >
                      {alert.feedCode} - {alert.type.replace(/_/g, ' ')}
                    </h3>
                    <p
                      className={`mt-1 text-sm ${
                        alert.type === 'STOCKOUT_IMMINENT'
                          ? 'text-red-700'
                          : alert.type === 'REORDER_NOW'
                          ? 'text-orange-700'
                          : 'text-yellow-700'
                      }`}
                    >
                      {alert.message}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily Plan Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">
            Daily Feeding Plan ({forecastDays} days)
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Day
                </th>
                {forecastData.byFeedType.slice(0, 5).map((feed) => (
                  <th
                    key={feed.feedCode}
                    className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {feed.feedCode}
                  </th>
                ))}
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Total (kg)
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {dailyPlan.map((day) => (
                <tr
                  key={day.day}
                  className={day.isToday ? 'bg-blue-50' : 'hover:bg-gray-50'}
                >
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <div className="flex items-center">
                      {day.isToday && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 mr-2">
                          Today
                        </span>
                      )}
                      {day.date.toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {day.day === 0 ? 'Today' : `+${day.day}`}
                  </td>
                  {forecastData.byFeedType.slice(0, 5).map((feed) => {
                    const amount = feed.dailyConsumption[day.day] ?? 0;
                    return (
                      <td
                        key={feed.feedCode}
                        className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900"
                      >
                        {amount > 0 ? amount.toFixed(1) : '-'}
                      </td>
                    );
                  })}
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                    {day.totalDaily.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50">
              <tr>
                <td className="px-6 py-3 text-sm font-medium text-gray-900" colSpan={2}>
                  Total ({Math.min(forecastDays, 14)} days)
                </td>
                {forecastData.byFeedType.slice(0, 5).map((feed) => {
                  const total = feed.dailyConsumption
                    .slice(0, Math.min(forecastDays, 14) + 1)
                    .reduce((sum, d) => sum + d, 0);
                  return (
                    <td
                      key={feed.feedCode}
                      className="px-6 py-3 text-sm text-right font-medium text-gray-900"
                    >
                      {total.toFixed(0)} kg
                    </td>
                  );
                })}
                <td className="px-6 py-3 text-sm text-right font-bold text-gray-900">
                  {dailyPlan.reduce((sum, d) => sum + d.totalDaily, 0).toFixed(0)} kg
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Feed Distribution by Batch */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Feed Distribution by Batch</h3>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {forecastData.byFeedType.map((feed) => (
              <div
                key={feed.feedId}
                className="border rounded-lg p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-gray-900">{feed.feedName}</h4>
                  <span className="text-sm text-gray-500">{feed.feedCode}</span>
                </div>
                <div className="space-y-2">
                  {feed.batches.map((batch) => (
                    <div
                      key={batch.batchId}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-gray-600">{batch.batchCode}</span>
                      <span className="font-medium text-gray-900">
                        {batch.consumption.toFixed(1)} kg
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 pt-3 border-t flex items-center justify-between">
                  <span className="text-sm text-gray-500">Total</span>
                  <span className="font-bold text-gray-900">
                    {feed.totalConsumption.toFixed(0)} kg
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
