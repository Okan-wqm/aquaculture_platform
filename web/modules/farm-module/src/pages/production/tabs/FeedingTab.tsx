/**
 * Feeding Tab
 * Feeding records and feed inventory management
 */
import React, { useState } from 'react';

// Mock feeding data
const mockFeedingRecords = [
  {
    id: '1',
    tankName: 'Tank A1',
    batchNumber: 'B-2024-00001',
    feedName: 'Salmon Grower 4mm',
    feedingDate: new Date('2024-06-15'),
    feedingTime: '08:00',
    plannedAmount: 45,
    actualAmount: 44.5,
    feedCost: 2225,
    appetite: 'good',
    fedBy: 'Ali Yılmaz',
  },
  {
    id: '2',
    tankName: 'Tank A1',
    batchNumber: 'B-2024-00001',
    feedName: 'Salmon Grower 4mm',
    feedingDate: new Date('2024-06-15'),
    feedingTime: '12:00',
    plannedAmount: 40,
    actualAmount: 42,
    feedCost: 2100,
    appetite: 'excellent',
    fedBy: 'Ali Yılmaz',
  },
  {
    id: '3',
    tankName: 'Tank A2',
    batchNumber: 'B-2024-00001',
    feedName: 'Salmon Grower 4mm',
    feedingDate: new Date('2024-06-15'),
    feedingTime: '08:00',
    plannedAmount: 42,
    actualAmount: 41,
    feedCost: 2050,
    appetite: 'good',
    fedBy: 'Mehmet Demir',
  },
];

const mockFeedInventory = [
  {
    id: '1',
    feedName: 'Salmon Grower 4mm',
    brand: 'AquaFeed Pro',
    siteName: 'Site 1',
    quantityKg: 2500,
    minStockKg: 500,
    unitPrice: 50,
    expiryDate: new Date('2024-12-31'),
    status: 'available',
  },
  {
    id: '2',
    feedName: 'Salmon Finisher 6mm',
    brand: 'AquaFeed Pro',
    siteName: 'Site 1',
    quantityKg: 350,
    minStockKg: 500,
    unitPrice: 55,
    expiryDate: new Date('2024-11-30'),
    status: 'low_stock',
  },
  {
    id: '3',
    feedName: 'Trout Grower 3mm',
    brand: 'FishMeal Plus',
    siteName: 'Site 2',
    quantityKg: 1800,
    minStockKg: 400,
    unitPrice: 45,
    expiryDate: new Date('2025-01-15'),
    status: 'available',
  },
];

const appetiteLabels: Record<string, { label: string; color: string }> = {
  excellent: { label: 'Mükemmel', color: 'text-green-600' },
  good: { label: 'İyi', color: 'text-green-500' },
  moderate: { label: 'Orta', color: 'text-yellow-600' },
  poor: { label: 'Zayıf', color: 'text-orange-600' },
  none: { label: 'Yemiyor', color: 'text-red-600' },
};

const statusColors: Record<string, string> = {
  available: 'bg-green-100 text-green-800',
  low_stock: 'bg-yellow-100 text-yellow-800',
  out_of_stock: 'bg-red-100 text-red-800',
  expired: 'bg-gray-100 text-gray-800',
};

const statusLabels: Record<string, string> = {
  available: 'Mevcut',
  low_stock: 'Düşük Stok',
  out_of_stock: 'Stok Yok',
  expired: 'Süresi Geçmiş',
};

export const FeedingTab: React.FC = () => {
  const [activeView, setActiveView] = useState<'records' | 'inventory'>('records');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  // Format date
  const formatDate = (date: Date): string => {
    return new Date(date).toLocaleDateString('tr-TR');
  };

  // Calculate variance
  const getVariance = (planned: number, actual: number): { value: number; percent: number } => {
    const value = actual - planned;
    const percent = planned > 0 ? (value / planned) * 100 : 0;
    return { value, percent };
  };

  return (
    <div className="space-y-6">
      {/* View Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex space-x-4">
          <button
            onClick={() => setActiveView('records')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              activeView === 'records'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Yemleme Kayıtları
          </button>
          <button
            onClick={() => setActiveView('inventory')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              activeView === 'inventory'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Yem Stokları
          </button>
        </div>

        <button
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {activeView === 'records' ? 'Yemleme Kaydı' : 'Stok Ekle'}
        </button>
      </div>

      {activeView === 'records' ? (
        <>
          {/* Date Filter */}
          <div className="flex items-center space-x-4">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="block rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>

          {/* Feeding Summary */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Günlük Toplam</p>
              <p className="text-2xl font-semibold text-gray-900">
                {mockFeedingRecords.reduce((sum, r) => sum + r.actualAmount, 0).toFixed(1)} kg
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Planlanan</p>
              <p className="text-2xl font-semibold text-gray-900">
                {mockFeedingRecords.reduce((sum, r) => sum + r.plannedAmount, 0).toFixed(1)} kg
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Günlük Maliyet</p>
              <p className="text-2xl font-semibold text-gray-900">
                {mockFeedingRecords.reduce((sum, r) => sum + r.feedCost, 0).toLocaleString()} TL
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Öğün Sayısı</p>
              <p className="text-2xl font-semibold text-gray-900">
                {mockFeedingRecords.length}
              </p>
            </div>
          </div>

          {/* Feeding Records Table */}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tank / Batch
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Yem
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Saat
                  </th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Planlanan
                  </th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Verilen
                  </th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Fark
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    İştah
                  </th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Maliyet
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {mockFeedingRecords.map((record) => {
                  const variance = getVariance(record.plannedAmount, record.actualAmount);
                  return (
                    <tr key={record.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{record.tankName}</div>
                        <div className="text-sm text-gray-500">{record.batchNumber}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {record.feedName}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {record.feedingTime}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                        {record.plannedAmount} kg
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                        {record.actualAmount} kg
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <span className={`text-sm ${variance.value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {variance.value >= 0 ? '+' : ''}{variance.value.toFixed(1)} kg
                          <span className="text-xs ml-1">({variance.percent.toFixed(0)}%)</span>
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`text-sm font-medium ${appetiteLabels[record.appetite]?.color}`}>
                          {appetiteLabels[record.appetite]?.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                        {record.feedCost.toLocaleString()} TL
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        /* Feed Inventory View */
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Yem
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Lokasyon
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Stok
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Min. Stok
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Birim Fiyat
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Son Kullanma
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Durum
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {mockFeedInventory.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{item.feedName}</div>
                    <div className="text-sm text-gray-500">{item.brand}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {item.siteName}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                    {item.quantityKg.toLocaleString()} kg
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-right">
                    {item.minStockKg.toLocaleString()} kg
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                    {item.unitPrice} TL/kg
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(item.expiryDate)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status]}`}>
                      {statusLabels[item.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default FeedingTab;
