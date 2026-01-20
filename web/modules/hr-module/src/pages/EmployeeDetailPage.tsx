/**
 * Employee Detail Page
 *
 * Personel detay sayfası.
 */

import React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Edit,
  Mail,
  Phone,
  Building2,
  Calendar,
  Clock,
  Award,
  GraduationCap,
  FileText,
  DollarSign,
} from 'lucide-react';

// ============================================================================
// Employee Detail Page
// ============================================================================

const EmployeeDetailPage: React.FC = () => {
  const { employeeId } = useParams();

  // Mock data - gerçek uygulamada API'dan gelecek
  const employee = {
    id: employeeId,
    name: 'Ahmet Yılmaz',
    email: 'ahmet.yilmaz@example.com',
    phone: '+90 532 111 2233',
    department: 'Üretim',
    position: 'Üretim Müdürü',
    status: 'active',
    startDate: '2022-01-15',
    birthDate: '1985-05-20',
    address: 'Kadıköy, İstanbul',
    emergencyContact: '+90 532 999 8877',
    salary: 25000,
    manager: 'Fatma Şahin',
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/hr/employees"
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{employee.name}</h1>
            <p className="text-gray-500">{employee.position}</p>
          </div>
        </div>
        <Link
          to={`/hr/employees/${employeeId}/edit`}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
        >
          <Edit className="w-4 h-4" />
          Düzenle
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col items-center text-center">
            <div className="w-24 h-24 rounded-full bg-violet-100 flex items-center justify-center mb-4">
              <span className="text-3xl font-bold text-violet-600">
                {employee.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')}
              </span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900">{employee.name}</h2>
            <p className="text-gray-500">{employee.position}</p>
            <span className="mt-2 px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
              Aktif
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-3 text-gray-600">
              <Mail className="w-5 h-5" />
              <span>{employee.email}</span>
            </div>
            <div className="flex items-center gap-3 text-gray-600">
              <Phone className="w-5 h-5" />
              <span>{employee.phone}</span>
            </div>
            <div className="flex items-center gap-3 text-gray-600">
              <Building2 className="w-5 h-5" />
              <span>{employee.department}</span>
            </div>
            <div className="flex items-center gap-3 text-gray-600">
              <Calendar className="w-5 h-5" />
              <span>İşe Başlama: {new Date(employee.startDate).toLocaleDateString('tr-TR')}</span>
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Personal Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Kişisel Bilgiler</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500">Doğum Tarihi</p>
                <p className="font-medium text-gray-900">
                  {new Date(employee.birthDate).toLocaleDateString('tr-TR')}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Adres</p>
                <p className="font-medium text-gray-900">{employee.address}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Acil Durum İletişim</p>
                <p className="font-medium text-gray-900">{employee.emergencyContact}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Yönetici</p>
                <p className="font-medium text-gray-900">{employee.manager}</p>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Link
              to={`/hr/attendance?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-cyan-200 hover:bg-cyan-50 transition-all"
            >
              <Clock className="w-8 h-8 text-cyan-600 mb-2" />
              <span className="text-sm font-medium text-gray-900">Devam</span>
            </Link>
            <Link
              to={`/hr/leaves?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-yellow-200 hover:bg-yellow-50 transition-all"
            >
              <Calendar className="w-8 h-8 text-yellow-600 mb-2" />
              <span className="text-sm font-medium text-gray-900">İzinler</span>
            </Link>
            <Link
              to={`/hr/payroll?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-green-200 hover:bg-green-50 transition-all"
            >
              <DollarSign className="w-8 h-8 text-green-600 mb-2" />
              <span className="text-sm font-medium text-gray-900">Bordro</span>
            </Link>
            <Link
              to={`/hr/performance?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-orange-200 hover:bg-orange-50 transition-all"
            >
              <Award className="w-8 h-8 text-orange-600 mb-2" />
              <span className="text-sm font-medium text-gray-900">Performans</span>
            </Link>
          </div>

          {/* Recent Activity */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Son Aktiviteler</h3>
            <div className="space-y-4">
              {[
                { icon: <Clock className="w-4 h-4" />, text: 'Giriş yaptı', time: 'Bugün 08:30', color: 'text-green-600' },
                { icon: <Calendar className="w-4 h-4" />, text: 'İzin talebi onaylandı', time: 'Dün', color: 'text-blue-600' },
                { icon: <Award className="w-4 h-4" />, text: 'Performans değerlendirmesi tamamlandı', time: '3 gün önce', color: 'text-purple-600' },
                { icon: <GraduationCap className="w-4 h-4" />, text: 'İş Güvenliği eğitimi tamamlandı', time: '1 hafta önce', color: 'text-indigo-600' },
              ].map((activity, index) => (
                <div key={index} className="flex items-center gap-3">
                  <span className={activity.color}>{activity.icon}</span>
                  <div className="flex-1">
                    <p className="text-sm text-gray-900">{activity.text}</p>
                    <p className="text-xs text-gray-500">{activity.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmployeeDetailPage;
