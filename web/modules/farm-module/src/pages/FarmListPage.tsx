/**
 * Farm List Page
 *
 * Çiftlik listesi sayfası - Filtreleme, arama ve CRUD işlemleri.
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  Button,
  Input,
  Select,
  Badge,
  Table,
  ConfirmModal,
  formatNumber,
  formatDate,
} from '@aquaculture/shared-ui';
import type { TableColumn } from '@aquaculture/shared-ui';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface Farm {
  id: string;
  name: string;
  type: 'tank' | 'cage' | 'pond';
  location: string;
  status: 'active' | 'maintenance' | 'inactive';
  capacity: number;
  currentStock: number;
  sensorCount: number;
  lastUpdated: Date;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockFarms: Farm[] = [
  {
    id: '1',
    name: 'Çiftlik A - Tank Sistemi',
    type: 'tank',
    location: 'İzmir, Türkiye',
    status: 'active',
    capacity: 50000,
    currentStock: 42000,
    sensorCount: 24,
    lastUpdated: new Date(),
  },
  {
    id: '2',
    name: 'Çiftlik B - Kafes Sistemi',
    type: 'cage',
    location: 'Muğla, Türkiye',
    status: 'active',
    capacity: 100000,
    currentStock: 85000,
    sensorCount: 36,
    lastUpdated: new Date(Date.now() - 2 * 60 * 60 * 1000),
  },
  {
    id: '3',
    name: 'Çiftlik C - Havuz',
    type: 'pond',
    location: 'Antalya, Türkiye',
    status: 'maintenance',
    capacity: 30000,
    currentStock: 0,
    sensorCount: 12,
    lastUpdated: new Date(Date.now() - 24 * 60 * 60 * 1000),
  },
  {
    id: '4',
    name: 'Çiftlik D - Tank Sistemi',
    type: 'tank',
    location: 'Mersin, Türkiye',
    status: 'inactive',
    capacity: 40000,
    currentStock: 0,
    sensorCount: 18,
    lastUpdated: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  },
];

// ============================================================================
// Farm List Page
// ============================================================================

const FarmListPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [selectedFarm, setSelectedFarm] = useState<Farm | null>(null);

  // Filtrelenmiş veriler
  const filteredFarms = useMemo(() => {
    return mockFarms.filter((farm) => {
      const matchesSearch = farm.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        farm.location.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesType = !typeFilter || farm.type === typeFilter;
      const matchesStatus = !statusFilter || farm.status === statusFilter;
      return matchesSearch && matchesType && matchesStatus;
    });
  }, [searchTerm, typeFilter, statusFilter]);

  // Tablo kolonları
  const columns: TableColumn<Farm>[] = [
    {
      key: 'name',
      header: 'Çiftlik Adı',
      sortable: true,
      render: (farm) => (
        <Link to={`/sites/${farm.id}`} className="text-primary-600 hover:text-primary-700 font-medium">
          {farm.name}
        </Link>
      ),
    },
    {
      key: 'type',
      header: 'Tip',
      sortable: true,
      render: (farm) => {
        const typeLabels = { tank: 'Tank', cage: 'Kafes', pond: 'Havuz' };
        return <span className="capitalize">{typeLabels[farm.type]}</span>;
      },
    },
    {
      key: 'location',
      header: 'Konum',
      sortable: true,
    },
    {
      key: 'status',
      header: 'Durum',
      sortable: true,
      render: (farm) => {
        const statusConfig = {
          active: { label: 'Aktif', variant: 'success' as const },
          maintenance: { label: 'Bakımda', variant: 'warning' as const },
          inactive: { label: 'Pasif', variant: 'default' as const },
        };
        const config = statusConfig[farm.status];
        return <Badge variant={config.variant}>{config.label}</Badge>;
      },
    },
    {
      key: 'capacity',
      header: 'Kapasite',
      sortable: true,
      align: 'right',
      render: (farm) => (
        <div className="text-right">
          <div className="font-medium">{formatNumber(farm.currentStock)}</div>
          <div className="text-xs text-gray-500">/ {formatNumber(farm.capacity)}</div>
        </div>
      ),
    },
    {
      key: 'sensorCount',
      header: 'Sensör',
      sortable: true,
      align: 'center',
      render: (farm) => (
        <span className="inline-flex items-center px-2 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
          {farm.sensorCount}
        </span>
      ),
    },
    {
      key: 'lastUpdated',
      header: 'Son Güncelleme',
      sortable: true,
      render: (farm) => (
        <span className="text-sm text-gray-500">
          {formatDate(farm.lastUpdated, 'short')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (farm) => (
        <div className="flex items-center justify-end space-x-2">
          <Link to={`/sites/${farm.id}`}>
            <Button variant="ghost" size="sm">Görüntüle</Button>
          </Link>
          <Link to={`/sites/${farm.id}/edit`}>
            <Button variant="ghost" size="sm">Düzenle</Button>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedFarm(farm);
              setDeleteModalOpen(true);
            }}
          >
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Sayfa Başlığı */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Çiftlikler</h1>
          <p className="mt-1 text-sm text-gray-500">
            Toplam {filteredFarms.length} çiftlik listeleniyor
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Link to="/sites/map">
            <Button variant="outline" size="sm">
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
              </svg>
              Harita
            </Button>
          </Link>
          <Link to="/sites/new">
            <Button>
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Yeni Çiftlik
            </Button>
          </Link>
        </div>
      </div>

      {/* Filtreler */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Input
              placeholder="Çiftlik adı veya konum ara..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              leftIcon={
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
            />
          </div>
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { value: '', label: 'Tüm Tipler' },
              { value: 'tank', label: 'Tank' },
              { value: 'cage', label: 'Kafes' },
              { value: 'pond', label: 'Havuz' },
            ]}
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'Tüm Durumlar' },
              { value: 'active', label: 'Aktif' },
              { value: 'maintenance', label: 'Bakımda' },
              { value: 'inactive', label: 'Pasif' },
            ]}
          />
        </div>
      </Card>

      {/* Tablo */}
      <Table
        data={filteredFarms}
        columns={columns}
        keyExtractor={(farm) => farm.id}
        pagination={{ current: 1, pageSize: 10, total: filteredFarms.length, onChange: () => {} }}
        emptyMessage="Kriterlere uygun çiftlik bulunamadı"
      />

      {/* Silme Onay Modal */}
      <ConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={() => {
          console.log('Çiftlik silindi:', selectedFarm?.id);
          setDeleteModalOpen(false);
          setSelectedFarm(null);
        }}
        title="Çiftliği Sil"
        message={`"${selectedFarm?.name}" çiftliğini silmek istediğinizden emin misiniz? Bu işlem geri alınamaz.`}
        confirmText="Sil"
        confirmVariant="danger"
      />
    </div>
  );
};

export default FarmListPage;
