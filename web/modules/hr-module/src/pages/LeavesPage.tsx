/**
 * Leaves Page
 *
 * İzin yönetimi sayfası.
 */

import React, { useState } from 'react';
import { Calendar, Clock, CheckCircle, XCircle, AlertCircle, Plus, Filter } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: 'annual' | 'sick' | 'personal' | 'maternity';
  startDate: string;
  endDate: string;
  days: number;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  createdAt: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockLeaves: LeaveRequest[] = [
  { id: '1', employeeId: '1', employeeName: 'Ahmet Yılmaz', type: 'annual', startDate: '2024-01-20', endDate: '2024-01-25', days: 5, status: 'pending', reason: 'Aile ziyareti', createdAt: '2024-01-10' },
  { id: '2', employeeId: '2', employeeName: 'Ayşe Kaya', type: 'sick', startDate: '2024-01-15', endDate: '2024-01-16', days: 2, status: 'approved', reason: 'Sağlık kontrolü', createdAt: '2024-01-14' },
  { id: '3', employeeId: '3', employeeName: 'Mehmet Demir', type: 'personal', startDate: '2024-01-18', endDate: '2024-01-18', days: 1, status: 'approved', reason: 'Kişisel işler', createdAt: '2024-01-12' },
  { id: '4', employeeId: '4', employeeName: 'Fatma Şahin', type: 'annual', startDate: '2024-02-01', endDate: '2024-02-07', days: 7, status: 'pending', reason: 'Tatil', createdAt: '2024-01-15' },
  { id: '5', employeeId: '5', employeeName: 'Ali Öztürk', type: 'sick', startDate: '2024-01-10', endDate: '2024-01-11', days: 2, status: 'rejected', reason: 'Raporsuz', createdAt: '2024-01-10' },
];

// ============================================================================
// Components
// ============================================================================

const LeaveTypeBadge: React.FC<{ type: LeaveRequest['type'] }> = ({ type }) => {
  const config = {
    annual: { label: 'Yıllık İzin', className: 'bg-blue-100 text-blue-800' },
    sick: { label: 'Hastalık', className: 'bg-red-100 text-red-800' },
    personal: { label: 'Mazeret', className: 'bg-purple-100 text-purple-800' },
    maternity: { label: 'Doğum İzni', className: 'bg-pink-100 text-pink-800' },
  };

  const { label, className } = config[type];

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
};

const StatusBadge: React.FC<{ status: LeaveRequest['status'] }> = ({ status }) => {
  const config = {
    pending: { label: 'Bekliyor', icon: Clock, className: 'bg-yellow-100 text-yellow-800' },
    approved: { label: 'Onaylandı', icon: CheckCircle, className: 'bg-green-100 text-green-800' },
    rejected: { label: 'Reddedildi', icon: XCircle, className: 'bg-red-100 text-red-800' },
  };

  const { label, icon: Icon, className } = config[status];

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
};

// ============================================================================
// Leaves Page
// ============================================================================

const LeavesPage: React.FC = () => {
  const [filterStatus, setFilterStatus] = useState('all');

  const pendingCount = mockLeaves.filter((l) => l.status === 'pending').length;

  const filteredLeaves = mockLeaves.filter((leave) =>
    filterStatus === 'all' || leave.status === filterStatus
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">İzin Yönetimi</h1>
          <p className="text-gray-500 mt-1">
            {pendingCount > 0 && <span className="text-yellow-600 font-medium">{pendingCount} bekleyen talep</span>}
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
          <Plus className="w-4 h-4" />
          Yeni İzin Talebi
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <Clock className="w-5 h-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{pendingCount}</p>
              <p className="text-sm text-gray-500">Bekleyen</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {mockLeaves.filter((l) => l.status === 'approved').length}
              </p>
              <p className="text-sm text-gray-500">Onaylanan</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-100 rounded-lg">
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {mockLeaves.filter((l) => l.status === 'rejected').length}
              </p>
              <p className="text-sm text-gray-500">Reddedilen</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Calendar className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {mockLeaves.reduce((sum, l) => sum + l.days, 0)}
              </p>
              <p className="text-sm text-gray-500">Toplam Gün</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filter */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex items-center gap-2">
          <Filter className="w-5 h-5 text-gray-400" />
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          >
            <option value="all">Tüm Talepler</option>
            <option value="pending">Bekleyenler</option>
            <option value="approved">Onaylananlar</option>
            <option value="rejected">Reddedilenler</option>
          </select>
        </div>
      </div>

      {/* Leave Requests */}
      <div className="space-y-4">
        {filteredLeaves.map((leave) => (
          <div
            key={leave.id}
            className="bg-white rounded-xl shadow-sm border border-gray-100 p-6"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-full bg-violet-100 flex items-center justify-center">
                  <span className="text-violet-600 font-medium">
                    {leave.employeeName.split(' ').map((n) => n[0]).join('')}
                  </span>
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{leave.employeeName}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <LeaveTypeBadge type={leave.type} />
                    <StatusBadge status={leave.status} />
                  </div>
                  <p className="text-sm text-gray-500 mt-2">{leave.reason}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-medium text-gray-900">{leave.days} gün</p>
                <p className="text-sm text-gray-500">
                  {new Date(leave.startDate).toLocaleDateString('tr-TR')} -{' '}
                  {new Date(leave.endDate).toLocaleDateString('tr-TR')}
                </p>
              </div>
            </div>

            {leave.status === 'pending' && (
              <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-gray-100">
                <button className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                  Reddet
                </button>
                <button className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
                  Onayla
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default LeavesPage;
