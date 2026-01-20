/**
 * Employees Page
 *
 * Personel listesi ve yönetimi sayfası.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  Search,
  Filter,
  UserPlus,
  MoreVertical,
  Mail,
  Phone,
  Building2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface Employee {
  id: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  position: string;
  status: 'active' | 'inactive' | 'on-leave' | 'terminated';
  startDate: string;
  avatar?: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockEmployees: Employee[] = [
  {
    id: '1',
    name: 'Ahmet Yılmaz',
    email: 'ahmet.yilmaz@example.com',
    phone: '+90 532 111 2233',
    department: 'Üretim',
    position: 'Üretim Müdürü',
    status: 'active',
    startDate: '2022-01-15',
  },
  {
    id: '2',
    name: 'Ayşe Kaya',
    email: 'ayse.kaya@example.com',
    phone: '+90 533 222 3344',
    department: 'Kalite Kontrol',
    position: 'Kalite Uzmanı',
    status: 'active',
    startDate: '2021-06-20',
  },
  {
    id: '3',
    name: 'Mehmet Demir',
    email: 'mehmet.demir@example.com',
    phone: '+90 534 333 4455',
    department: 'Bakım',
    position: 'Teknik Uzman',
    status: 'on-leave',
    startDate: '2020-03-10',
  },
  {
    id: '4',
    name: 'Fatma Şahin',
    email: 'fatma.sahin@example.com',
    phone: '+90 535 444 5566',
    department: 'İnsan Kaynakları',
    position: 'HR Uzmanı',
    status: 'active',
    startDate: '2023-02-01',
  },
  {
    id: '5',
    name: 'Ali Öztürk',
    email: 'ali.ozturk@example.com',
    phone: '+90 536 555 6677',
    department: 'Üretim',
    position: 'Operatör',
    status: 'active',
    startDate: '2022-08-15',
  },
];

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ status: Employee['status'] }> = ({ status }) => {
  const statusConfig = {
    active: { label: 'Aktif', className: 'bg-green-100 text-green-800' },
    inactive: { label: 'Pasif', className: 'bg-gray-100 text-gray-800' },
    'on-leave': { label: 'İzinde', className: 'bg-yellow-100 text-yellow-800' },
    terminated: { label: 'Ayrıldı', className: 'bg-red-100 text-red-800' },
  };

  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
};

// ============================================================================
// Employees Page
// ============================================================================

const EmployeesPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDepartment, setSelectedDepartment] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');

  const departments = ['all', 'Üretim', 'Kalite Kontrol', 'Bakım', 'İnsan Kaynakları'];

  const filteredEmployees = mockEmployees.filter((employee) => {
    const matchesSearch =
      employee.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      employee.email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDepartment =
      selectedDepartment === 'all' || employee.department === selectedDepartment;
    const matchesStatus =
      selectedStatus === 'all' || employee.status === selectedStatus;
    return matchesSearch && matchesDepartment && matchesStatus;
  });

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Personel Listesi</h1>
          <p className="text-gray-500 mt-1">
            Toplam {filteredEmployees.length} personel
          </p>
        </div>
        <Link
          to="/hr/employees/new"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Yeni Personel
        </Link>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="İsim veya email ile ara..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
          </div>

          {/* Department Filter */}
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-gray-400" />
            <select
              value={selectedDepartment}
              onChange={(e) => setSelectedDepartment(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="all">Tüm Departmanlar</option>
              {departments.slice(1).map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-400" />
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="all">Tüm Durumlar</option>
              <option value="active">Aktif</option>
              <option value="inactive">Pasif</option>
              <option value="on-leave">İzinde</option>
              <option value="terminated">Ayrıldı</option>
            </select>
          </div>
        </div>
      </div>

      {/* Employee Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">
                Personel
              </th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">
                Departman
              </th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">
                Pozisyon
              </th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">
                Durum
              </th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">
                İşe Başlama
              </th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">
                İşlemler
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredEmployees.map((employee) => (
              <tr key={employee.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center">
                      <span className="text-violet-600 font-medium">
                        {employee.name
                          .split(' ')
                          .map((n) => n[0])
                          .join('')}
                      </span>
                    </div>
                    <div>
                      <Link
                        to={`/hr/employees/${employee.id}`}
                        className="font-medium text-gray-900 hover:text-violet-600"
                      >
                        {employee.name}
                      </Link>
                      <div className="flex items-center gap-3 text-sm text-gray-500">
                        <span className="flex items-center gap-1">
                          <Mail className="w-3 h-3" />
                          {employee.email}
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="text-gray-900">{employee.department}</span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-gray-900">{employee.position}</span>
                </td>
                <td className="px-6 py-4">
                  <StatusBadge status={employee.status} />
                </td>
                <td className="px-6 py-4">
                  <span className="text-gray-500">
                    {new Date(employee.startDate).toLocaleDateString('tr-TR')}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      to={`/hr/employees/${employee.id}`}
                      className="p-2 text-gray-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
                    >
                      <Users className="w-4 h-4" />
                    </Link>
                    <Link
                      to={`/hr/employees/${employee.id}/edit`}
                      className="p-2 text-gray-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Pagination */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
          <p className="text-sm text-gray-500">
            Toplam {filteredEmployees.length} kayıt gösteriliyor
          </p>
          <div className="flex items-center gap-2">
            <button className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="px-3 py-1 bg-violet-50 text-violet-600 rounded-lg text-sm font-medium">
              1
            </span>
            <button className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50">
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmployeesPage;
