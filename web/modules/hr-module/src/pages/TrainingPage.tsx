/**
 * Training Page
 *
 * Eğitim yönetimi sayfası.
 */

import React from 'react';
import { GraduationCap, Calendar, Users, Clock, Award, Plus, CheckCircle, Play, BookOpen } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface Training {
  id: string;
  title: string;
  description: string;
  category: 'safety' | 'technical' | 'soft-skills' | 'compliance';
  instructor: string;
  duration: string;
  startDate: string;
  endDate: string;
  participants: number;
  maxParticipants: number;
  status: 'upcoming' | 'in-progress' | 'completed';
  completionRate: number;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockTrainings: Training[] = [
  {
    id: '1',
    title: 'İş Güvenliği Temel Eğitimi',
    description: 'Temel iş sağlığı ve güvenliği kuralları',
    category: 'safety',
    instructor: 'Ahmet Yılmaz',
    duration: '4 saat',
    startDate: '2024-01-20',
    endDate: '2024-01-20',
    participants: 25,
    maxParticipants: 30,
    status: 'upcoming',
    completionRate: 0,
  },
  {
    id: '2',
    title: 'Su Kalitesi İzleme Sistemleri',
    description: 'Sensör kullanımı ve veri analizi',
    category: 'technical',
    instructor: 'Ayşe Kaya',
    duration: '8 saat',
    startDate: '2024-01-15',
    endDate: '2024-01-16',
    participants: 15,
    maxParticipants: 20,
    status: 'in-progress',
    completionRate: 50,
  },
  {
    id: '3',
    title: 'Etkili İletişim Becerileri',
    description: 'Takım içi iletişim ve sunum teknikleri',
    category: 'soft-skills',
    instructor: 'Fatma Şahin',
    duration: '6 saat',
    startDate: '2024-01-10',
    endDate: '2024-01-10',
    participants: 12,
    maxParticipants: 15,
    status: 'completed',
    completionRate: 100,
  },
  {
    id: '4',
    title: 'HACCP ve Gıda Güvenliği',
    description: 'Gıda güvenliği standartları ve uygulamaları',
    category: 'compliance',
    instructor: 'Mehmet Demir',
    duration: '12 saat',
    startDate: '2024-01-08',
    endDate: '2024-01-09',
    participants: 20,
    maxParticipants: 20,
    status: 'completed',
    completionRate: 100,
  },
];

// ============================================================================
// Components
// ============================================================================

const CategoryBadge: React.FC<{ category: Training['category'] }> = ({ category }) => {
  const config = {
    safety: { label: 'İş Güvenliği', className: 'bg-red-100 text-red-800' },
    technical: { label: 'Teknik', className: 'bg-blue-100 text-blue-800' },
    'soft-skills': { label: 'Kişisel Gelişim', className: 'bg-purple-100 text-purple-800' },
    compliance: { label: 'Uyum', className: 'bg-green-100 text-green-800' },
  };

  const { label, className } = config[category];

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
};

const StatusIcon: React.FC<{ status: Training['status'] }> = ({ status }) => {
  const config = {
    upcoming: { icon: Calendar, className: 'text-gray-600 bg-gray-100' },
    'in-progress': { icon: Play, className: 'text-blue-600 bg-blue-100' },
    completed: { icon: CheckCircle, className: 'text-green-600 bg-green-100' },
  };

  const { icon: Icon, className } = config[status];

  return (
    <div className={`p-2 rounded-lg ${className}`}>
      <Icon className="w-5 h-5" />
    </div>
  );
};

// ============================================================================
// Training Page
// ============================================================================

const TrainingPage: React.FC = () => {
  const upcomingCount = mockTrainings.filter((t) => t.status === 'upcoming').length;
  const inProgressCount = mockTrainings.filter((t) => t.status === 'in-progress').length;
  const completedCount = mockTrainings.filter((t) => t.status === 'completed').length;
  const totalParticipants = mockTrainings.reduce((sum, t) => sum + t.participants, 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Eğitim Programları</h1>
          <p className="text-gray-500 mt-1">Personel eğitim ve sertifikasyon yönetimi</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
          <Plus className="w-4 h-4" />
          Yeni Eğitim
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gray-100 rounded-lg">
              <Calendar className="w-6 h-6 text-gray-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Planlanmış</p>
              <p className="text-xl font-bold text-gray-900">{upcomingCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Play className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Devam Eden</p>
              <p className="text-xl font-bold text-gray-900">{inProgressCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <CheckCircle className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Tamamlanan</p>
              <p className="text-xl font-bold text-gray-900">{completedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-violet-100 rounded-lg">
              <Users className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Toplam Katılımcı</p>
              <p className="text-xl font-bold text-gray-900">{totalParticipants}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Training List */}
      <div className="space-y-4">
        {mockTrainings.map((training) => (
          <div
            key={training.id}
            className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-4">
              <StatusIcon status={training.status} />
              <div className="flex-1">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{training.title}</h3>
                      <CategoryBadge category={training.category} />
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{training.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-gray-900">
                      {training.participants}/{training.maxParticipants} katılımcı
                    </p>
                    <p className="text-xs text-gray-500">{training.duration}</p>
                  </div>
                </div>

                <div className="flex items-center gap-6 mt-4 text-sm text-gray-500">
                  <div className="flex items-center gap-1">
                    <GraduationCap className="w-4 h-4" />
                    <span>{training.instructor}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="w-4 h-4" />
                    <span>
                      {new Date(training.startDate).toLocaleDateString('tr-TR')}
                      {training.startDate !== training.endDate && (
                        <> - {new Date(training.endDate).toLocaleDateString('tr-TR')}</>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="w-4 h-4" />
                    <span>{training.duration}</span>
                  </div>
                </div>

                {training.status !== 'upcoming' && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-500">İlerleme</span>
                      <span className="text-gray-900 font-medium">{training.completionRate}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${
                          training.completionRate === 100 ? 'bg-green-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${training.completionRate}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TrainingPage;
