/**
 * Performance Page
 *
 * Performans değerlendirme sayfası.
 */

import React from 'react';
import { Award, TrendingUp, Star, Target, BarChart3, Users, Calendar, ChevronRight } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface PerformanceReview {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  reviewPeriod: string;
  overallScore: number;
  status: 'pending' | 'in-progress' | 'completed';
  reviewDate: string;
  categories: {
    name: string;
    score: number;
  }[];
}

// ============================================================================
// Mock Data
// ============================================================================

const mockReviews: PerformanceReview[] = [
  {
    id: '1',
    employeeId: '1',
    employeeName: 'Ahmet Yılmaz',
    department: 'Üretim',
    reviewPeriod: 'Q4 2023',
    overallScore: 4.5,
    status: 'completed',
    reviewDate: '2024-01-10',
    categories: [
      { name: 'İş Kalitesi', score: 4.5 },
      { name: 'Verimlilik', score: 4.0 },
      { name: 'Takım Çalışması', score: 5.0 },
      { name: 'İletişim', score: 4.5 },
    ],
  },
  {
    id: '2',
    employeeId: '2',
    employeeName: 'Ayşe Kaya',
    department: 'Kalite',
    reviewPeriod: 'Q4 2023',
    overallScore: 4.8,
    status: 'completed',
    reviewDate: '2024-01-08',
    categories: [
      { name: 'İş Kalitesi', score: 5.0 },
      { name: 'Verimlilik', score: 4.5 },
      { name: 'Takım Çalışması', score: 4.5 },
      { name: 'İletişim', score: 5.0 },
    ],
  },
  {
    id: '3',
    employeeId: '3',
    employeeName: 'Mehmet Demir',
    department: 'Bakım',
    reviewPeriod: 'Q4 2023',
    overallScore: 0,
    status: 'in-progress',
    reviewDate: '2024-01-15',
    categories: [],
  },
  {
    id: '4',
    employeeId: '4',
    employeeName: 'Fatma Şahin',
    department: 'HR',
    reviewPeriod: 'Q4 2023',
    overallScore: 0,
    status: 'pending',
    reviewDate: '2024-01-20',
    categories: [],
  },
];

// ============================================================================
// Components
// ============================================================================

const ScoreDisplay: React.FC<{ score: number }> = ({ score }) => {
  const getColor = (s: number) => {
    if (s >= 4.5) return 'text-green-600';
    if (s >= 3.5) return 'text-blue-600';
    if (s >= 2.5) return 'text-yellow-600';
    return 'text-red-600';
  };

  return (
    <div className="flex items-center gap-1">
      <Star className={`w-5 h-5 ${getColor(score)} fill-current`} />
      <span className={`text-lg font-bold ${getColor(score)}`}>{score.toFixed(1)}</span>
    </div>
  );
};

const StatusBadge: React.FC<{ status: PerformanceReview['status'] }> = ({ status }) => {
  const config = {
    pending: { label: 'Planlandı', className: 'bg-gray-100 text-gray-800' },
    'in-progress': { label: 'Devam Ediyor', className: 'bg-yellow-100 text-yellow-800' },
    completed: { label: 'Tamamlandı', className: 'bg-green-100 text-green-800' },
  };

  const { label, className } = config[status];

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
};

// ============================================================================
// Performance Page
// ============================================================================

const PerformancePage: React.FC = () => {
  const completedCount = mockReviews.filter((r) => r.status === 'completed').length;
  const avgScore = mockReviews
    .filter((r) => r.status === 'completed')
    .reduce((sum, r) => sum + r.overallScore, 0) / completedCount || 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Performans Değerlendirme</h1>
          <p className="text-gray-500 mt-1">Çalışan performans takibi ve değerlendirmeleri</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
          <Target className="w-4 h-4" />
          Yeni Değerlendirme
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-violet-100 rounded-lg">
              <Users className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Toplam Değerlendirme</p>
              <p className="text-xl font-bold text-gray-900">{mockReviews.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <Award className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Tamamlanan</p>
              <p className="text-xl font-bold text-gray-900">{completedCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-yellow-100 rounded-lg">
              <TrendingUp className="w-6 h-6 text-yellow-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Ortalama Puan</p>
              <p className="text-xl font-bold text-gray-900">{avgScore.toFixed(1)} / 5.0</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Calendar className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Dönem</p>
              <p className="text-xl font-bold text-gray-900">Q4 2023</p>
            </div>
          </div>
        </div>
      </div>

      {/* Reviews List */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Değerlendirme Listesi</h3>
        </div>
        <div className="divide-y divide-gray-100">
          {mockReviews.map((review) => (
            <div
              key={review.id}
              className="p-6 hover:bg-gray-50 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-violet-100 flex items-center justify-center">
                    <span className="text-violet-600 font-medium">
                      {review.employeeName.split(' ').map((n) => n[0]).join('')}
                    </span>
                  </div>
                  <div>
                    <h4 className="font-medium text-gray-900">{review.employeeName}</h4>
                    <p className="text-sm text-gray-500">{review.department} - {review.reviewPeriod}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {review.status === 'completed' && (
                    <ScoreDisplay score={review.overallScore} />
                  )}
                  <StatusBadge status={review.status} />
                  <ChevronRight className="w-5 h-5 text-gray-400" />
                </div>
              </div>

              {review.status === 'completed' && review.categories.length > 0 && (
                <div className="mt-4 grid grid-cols-4 gap-4">
                  {review.categories.map((cat) => (
                    <div key={cat.name} className="bg-gray-50 rounded-lg p-3">
                      <p className="text-xs text-gray-500">{cat.name}</p>
                      <div className="flex items-center gap-1 mt-1">
                        <Star className="w-4 h-4 text-yellow-500 fill-current" />
                        <span className="text-sm font-medium text-gray-900">{cat.score.toFixed(1)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PerformancePage;
