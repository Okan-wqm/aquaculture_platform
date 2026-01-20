/**
 * Payroll Page
 *
 * Bordro yönetimi sayfası.
 */

import React, { useState } from 'react';
import { DollarSign, Calendar, Download, Filter, TrendingUp, Users, CreditCard, FileText } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface PayrollRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  baseSalary: number;
  overtime: number;
  bonus: number;
  deductions: number;
  netSalary: number;
  status: 'pending' | 'processed' | 'paid';
  payDate: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockPayroll: PayrollRecord[] = [
  { id: '1', employeeId: '1', employeeName: 'Ahmet Yılmaz', department: 'Üretim', baseSalary: 25000, overtime: 2500, bonus: 1000, deductions: 5500, netSalary: 23000, status: 'paid', payDate: '2024-01-15' },
  { id: '2', employeeId: '2', employeeName: 'Ayşe Kaya', department: 'Kalite', baseSalary: 22000, overtime: 1000, bonus: 500, deductions: 4800, netSalary: 18700, status: 'paid', payDate: '2024-01-15' },
  { id: '3', employeeId: '3', employeeName: 'Mehmet Demir', department: 'Bakım', baseSalary: 20000, overtime: 3000, bonus: 0, deductions: 4500, netSalary: 18500, status: 'processed', payDate: '2024-01-15' },
  { id: '4', employeeId: '4', employeeName: 'Fatma Şahin', department: 'HR', baseSalary: 18000, overtime: 0, bonus: 2000, deductions: 4000, netSalary: 16000, status: 'pending', payDate: '2024-01-15' },
  { id: '5', employeeId: '5', employeeName: 'Ali Öztürk', department: 'Üretim', baseSalary: 16000, overtime: 1500, bonus: 0, deductions: 3500, netSalary: 14000, status: 'pending', payDate: '2024-01-15' },
];

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ status: PayrollRecord['status'] }> = ({ status }) => {
  const config = {
    pending: { label: 'Bekliyor', className: 'bg-yellow-100 text-yellow-800' },
    processed: { label: 'İşlendi', className: 'bg-blue-100 text-blue-800' },
    paid: { label: 'Ödendi', className: 'bg-green-100 text-green-800' },
  };

  const { label, className } = config[status];

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
};

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(amount);
};

// ============================================================================
// Payroll Page
// ============================================================================

const PayrollPage: React.FC = () => {
  const [selectedMonth, setSelectedMonth] = useState('2024-01');

  const totalPayroll = mockPayroll.reduce((sum, p) => sum + p.netSalary, 0);
  const totalOvertime = mockPayroll.reduce((sum, p) => sum + p.overtime, 0);
  const totalBonus = mockPayroll.reduce((sum, p) => sum + p.bonus, 0);
  const pendingCount = mockPayroll.filter((p) => p.status === 'pending').length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bordro Yönetimi</h1>
          <p className="text-gray-500 mt-1">Maaş ve ödeme işlemleri</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
            <Download className="w-4 h-4" />
            Dışa Aktar
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <DollarSign className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Toplam Bordro</p>
              <p className="text-xl font-bold text-gray-900">{formatCurrency(totalPayroll)}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-100 rounded-lg">
              <TrendingUp className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Fazla Mesai</p>
              <p className="text-xl font-bold text-gray-900">{formatCurrency(totalOvertime)}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-100 rounded-lg">
              <CreditCard className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Toplam Bonus</p>
              <p className="text-xl font-bold text-gray-900">{formatCurrency(totalBonus)}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-yellow-100 rounded-lg">
              <Users className="w-6 h-6 text-yellow-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Bekleyen Ödeme</p>
              <p className="text-xl font-bold text-gray-900">{pendingCount} kişi</p>
            </div>
          </div>
        </div>
      </div>

      {/* Payroll Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Ocak 2024 Bordro Listesi</h3>
        </div>
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Personel</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">Maaş</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">Fazla Mesai</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">Bonus</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">Kesintiler</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">Net Maaş</th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-500">Durum</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">İşlem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {mockPayroll.map((record) => (
              <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4">
                  <div>
                    <p className="font-medium text-gray-900">{record.employeeName}</p>
                    <p className="text-sm text-gray-500">{record.department}</p>
                  </div>
                </td>
                <td className="px-6 py-4 text-right text-gray-900">
                  {formatCurrency(record.baseSalary)}
                </td>
                <td className="px-6 py-4 text-right text-blue-600">
                  +{formatCurrency(record.overtime)}
                </td>
                <td className="px-6 py-4 text-right text-green-600">
                  +{formatCurrency(record.bonus)}
                </td>
                <td className="px-6 py-4 text-right text-red-600">
                  -{formatCurrency(record.deductions)}
                </td>
                <td className="px-6 py-4 text-right font-bold text-gray-900">
                  {formatCurrency(record.netSalary)}
                </td>
                <td className="px-6 py-4 text-center">
                  <StatusBadge status={record.status} />
                </td>
                <td className="px-6 py-4 text-right">
                  <button className="p-2 text-gray-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors">
                    <FileText className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default PayrollPage;
