/**
 * Departments Page
 *
 * Departman yönetimi sayfası.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Building2, Users, Plus, MoreVertical, ChevronRight } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface Department {
  id: string;
  name: string;
  description: string;
  employeeCount: number;
  manager: string;
  color: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockDepartments: Department[] = [
  { id: '1', name: 'Üretim', description: 'Balık üretim ve yetiştirme operasyonları', employeeCount: 45, manager: 'Ahmet Yılmaz', color: 'bg-blue-500' },
  { id: '2', name: 'Kalite Kontrol', description: 'Ürün kalite güvence ve test işlemleri', employeeCount: 12, manager: 'Ayşe Kaya', color: 'bg-green-500' },
  { id: '3', name: 'Bakım', description: 'Ekipman bakım ve onarım hizmetleri', employeeCount: 18, manager: 'Mehmet Demir', color: 'bg-orange-500' },
  { id: '4', name: 'İnsan Kaynakları', description: 'Personel yönetimi ve işe alım', employeeCount: 8, manager: 'Fatma Şahin', color: 'bg-violet-500' },
  { id: '5', name: 'Finans', description: 'Muhasebe ve mali işler', employeeCount: 6, manager: 'Ali Öztürk', color: 'bg-emerald-500' },
  { id: '6', name: 'Lojistik', description: 'Depolama ve sevkiyat operasyonları', employeeCount: 15, manager: 'Zeynep Çelik', color: 'bg-cyan-500' },
];

// ============================================================================
// Departments Page
// ============================================================================

const DepartmentsPage: React.FC = () => {
  const totalEmployees = mockDepartments.reduce((sum, d) => sum + d.employeeCount, 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Departmanlar</h1>
          <p className="text-gray-500 mt-1">
            {mockDepartments.length} departman, {totalEmployees} personel
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
          <Plus className="w-4 h-4" />
          Yeni Departman
        </button>
      </div>

      {/* Departments Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {mockDepartments.map((department) => (
          <div
            key={department.id}
            className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow"
          >
            <div className={`h-2 ${department.color}`} />
            <div className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-lg ${department.color} bg-opacity-10`}>
                    <Building2 className={`w-6 h-6 ${department.color.replace('bg-', 'text-')}`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{department.name}</h3>
                    <p className="text-sm text-gray-500">{department.manager}</p>
                  </div>
                </div>
                <button className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                  <MoreVertical className="w-4 h-4 text-gray-400" />
                </button>
              </div>

              <p className="mt-4 text-sm text-gray-600">{department.description}</p>

              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-gray-500">
                  <Users className="w-4 h-4" />
                  <span className="text-sm">{department.employeeCount} personel</span>
                </div>
                <Link
                  to={`/hr/employees?department=${department.id}`}
                  className="flex items-center gap-1 text-sm text-violet-600 hover:text-violet-700"
                >
                  Görüntüle
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Organization Chart placeholder */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Organizasyon Şeması</h3>
        <div className="flex items-center justify-center h-64 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <p className="text-gray-500">Organizasyon şeması yakında eklenecek</p>
        </div>
      </div>
    </div>
  );
};

export default DepartmentsPage;
