/**
 * Performance Page
 *
 * BUG-007: Mock data replaced with real API hooks.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, TrendingUp, Star, Target, BarChart3, Calendar, ChevronRight } from 'lucide-react';
import { usePerformanceReviews, usePendingReviews, useCurrentEmployeeId } from '../hooks';
import { cn } from '@aquaculture/shared-ui';

const PerformancePage: React.FC = () => {
  const employeeId = useCurrentEmployeeId();
  const [activeTab, setActiveTab] = useState<'reviews' | 'goals'>('reviews');

  const { data: reviews, isLoading: loadingReviews } = usePerformanceReviews();
  const { data: pending, isLoading: loadingPending } = usePendingReviews(employeeId);

  const isLoading = loadingReviews || loadingPending;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Performance</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Performance reviews and goal tracking
          </p>
        </div>
        <Link
          to="/hr/performance/reviews"
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Award className="h-4 w-4" />
          New Review
        </Link>
      </div>

      {/* Pending Reviews Alert */}
      {pending && pending.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-900/20">
          <div className="flex items-center gap-3">
            <Star className="h-5 w-5 text-amber-600" />
            <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
              {pending.length} review{pending.length !== 1 ? 's' : ''} pending your submission
            </span>
          </div>
          <Link
            to="/hr/performance/reviews"
            className="flex items-center gap-1 text-sm text-amber-700 hover:text-amber-900 dark:text-amber-300"
          >
            View <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('reviews')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'reviews'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          Reviews
        </button>
        <button
          onClick={() => setActiveTab('goals')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'goals'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          Goals
        </button>
      </div>

      {/* Reviews Tab */}
      {activeTab === 'reviews' && (
        <div className="space-y-4">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
            </div>
          ) : reviews && reviews.items && reviews.items.length > 0 ? (
            reviews.items.map((review) => (
              <div
                key={review.id}
                className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-indigo-50 p-3 dark:bg-indigo-900/30">
                    <Award className="h-5 w-5 text-indigo-600" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">
                      {review.reviewPeriod}
                    </p>
                    <p className="text-sm text-gray-500">
                      {review.employee?.firstName} {review.employee?.lastName}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {review.overallScore !== null && review.overallScore !== undefined && (
                    <div className="flex items-center gap-1 text-amber-600">
                      <Star className="h-4 w-4 fill-amber-500" />
                      <span className="text-sm font-medium">{review.overallScore.toFixed(1)}</span>
                    </div>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      review.status === 'completed'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                        : review.status === 'in_progress'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                    )}
                  >
                    {review.status}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="flex h-32 flex-col items-center justify-center text-center">
              <BarChart3 className="mb-2 h-8 w-8 text-gray-400" />
              <p className="text-gray-500">No performance reviews found</p>
            </div>
          )}
        </div>
      )}

      {/* Goals Tab */}
      {activeTab === 'goals' && (
        <div className="flex h-32 flex-col items-center justify-center text-center">
          <Target className="mb-2 h-8 w-8 text-gray-400" />
          <p className="text-gray-500">Goals tracking available in the Goals section</p>
          <Link
            to="/hr/performance/goals"
            className="mt-3 text-sm text-indigo-600 hover:underline"
          >
            Open Goals
          </Link>
        </div>
      )}
    </div>
  );
};

export default PerformancePage;
