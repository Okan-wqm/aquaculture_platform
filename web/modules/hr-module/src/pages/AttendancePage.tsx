/**
 * Attendance Page
 *
 * Devam takibi sayfası.
 */

import React, { useState } from 'react';
import { Clock, Calendar, Search, Filter, CheckCircle, XCircle, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: 'present' | 'absent' | 'late' | 'leave';
  workHours: number;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockAttendance: AttendanceRecord[] = [
  { id: '1', employeeId: '1', employeeName: 'Ahmet Yılmaz', date: '2024-01-15', checkIn: '08:30', checkOut: '17:30', status: 'present', workHours: 9 },
  { id: '2', employeeId: '2', employeeName: 'Ayşe Kaya', date: '2024-01-15', checkIn: '08:45', checkOut: '17:30', status: 'present', workHours: 8.75 },
  { id: '3', employeeId: '3', employeeName: 'Mehmet Demir', date: '2024-01-15', checkIn: null, checkOut: null, status: 'leave', workHours: 0 },
  { id: '4', employeeId: '4', employeeName: 'Fatma Şahin', date: '2024-01-15', checkIn: '09:15', checkOut: '17:30', status: 'late', workHours: 8.25 },
  { id: '5', employeeId: '5', employeeName: 'Ali Öztürk', date: '2024-01-15', checkIn: null, checkOut: null, status: 'absent', workHours: 0 },
];

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ status: AttendanceRecord['status'] }> = ({ status }) => {
  const config = {
    present: { label: 'Mevcut', icon: CheckCircle, className: 'bg-green-100 text-green-800' },
    absent: { label: 'Yok', icon: XCircle, className: 'bg-red-100 text-red-800' },
    late: { label: 'Geç', icon: AlertCircle, className: 'bg-yellow-100 text-yellow-800' },
    leave: { label: 'İzinli', icon: Calendar, className: 'bg-blue-100 text-blue-800' },
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
// Attendance Page
// ============================================================================

const AttendancePage: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [searchTerm, setSearchTerm] = useState('');

  const stats = {
    present: mockAttendance.filter((a) => a.status === 'present').length,
    absent: mockAttendance.filter((a) => a.status === 'absent').length,
    late: mockAttendance.filter((a) => a.status === 'late').length,
    leave: mockAttendance.filter((a) => a.status === 'leave').length,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Devam Takibi</h1>
          <p className="text-gray-500 mt-1">Personel giriş-çıkış kayıtları</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="p-2 hover:bg-gray-100 rounded-lg">
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </button>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button className="p-2 hover:bg-gray-100 rounded-lg">
            <ChevronRight className="w-5 h-5 text-gray-600" />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.present}</p>
              <p className="text-sm text-gray-500">Mevcut</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-100 rounded-lg">
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.absent}</p>
              <p className="text-sm text-gray-500">Yok</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <AlertCircle className="w-5 h-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.late}</p>
              <p className="text-sm text-gray-500">Geç Kalan</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Calendar className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.leave}</p>
              <p className="text-sm text-gray-500">İzinli</p>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Personel ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </div>
      </div>

      {/* Attendance Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Personel</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Giriş</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Çıkış</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Çalışma Saati</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Durum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {mockAttendance.map((record) => (
              <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center">
                      <span className="text-violet-600 font-medium">
                        {record.employeeName.split(' ').map((n) => n[0]).join('')}
                      </span>
                    </div>
                    <span className="font-medium text-gray-900">{record.employeeName}</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="text-gray-900">{record.checkIn || '-'}</span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-gray-900">{record.checkOut || '-'}</span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-gray-900">{record.workHours > 0 ? `${record.workHours} saat` : '-'}</span>
                </td>
                <td className="px-6 py-4">
                  <StatusBadge status={record.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AttendancePage;
