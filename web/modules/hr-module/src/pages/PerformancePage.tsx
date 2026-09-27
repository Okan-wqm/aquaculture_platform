/**
 * Performance Page
 *
 * BUG-007: Mock data replaced with real API hooks.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, TrendingUp, Star, Target, BarChart3, Calendar, ChevronRight } from 'lucide-react';
import { usePerformanceReviews, usePendingReviews, useCurrentEmployeeId } from '../hooks';
import { cn, Spinner, PageHeader } from '@aquaculture/shared-ui';
import { ReviewStatus } from '../types';

const PerformancePage: React.FC = () => {
  const employeeId = useCurrentEmployeeId();
  const [activeTab, setActiveTab] = useState<'reviews' | 'goals'>('reviews');

  const { data: reviews, isLoading: loadingReviews } = usePerformanceReviews();
  const { data: pending, isLoading: loadingPending } = usePendingReviews(employeeId);

  const isLoading = loadingReviews || loadingPending;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <PageHeader
        title="Performance"
        description="Performance reviews and goal tracking"
        actions={
          <Link
            to="/hr/performance/reviews"
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            <Award className="h-4 w-4" />
            New Review
          </Link>
        }
      />

      {/* Pending Reviews Alert */}
      {pending && pending.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-warning-200 bg-warning-50 px-4 py-3 dark:border-warning-800 dark:bg-warning-900/20">
          <div className="flex items-center gap-3">
            <Star className="h-5 w-5 text-warning-600 dark:text-warning-400" />
            <span className="text-sm font-medium text-warning-800 dark:text-warning-200">
              {pending.length} review{pending.length !== 1 ? 's' : ''} pending your submission
            </span>
          </div>
          <Link
            to="/hr/performance/reviews"
            className="flex items-center gap-1 text-sm text-warning-700 hover:text-warning-900 dark:text-warning-300"
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
              ? 'border-primary-600 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100',
          )}
        >
          Reviews
        </button>
        <button
          onClick={() => setActiveTab('goals')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'goals'
              ? 'border-primary-600 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100',
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
              <Spinner size="lg" />
            </div>
          ) : reviews && reviews.items && reviews.items.length > 0 ? (
            reviews.items.map((review) => (
              <div
                key={review.id}
                className="flex items-center justify-between rounded-xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-primary-50 p-3 dark:bg-primary-900/30">
                    <Award className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">
                      {review.periodType ??
                        `${review.periodStart ?? ''} - ${review.periodEnd ?? ''}`}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {review.employee?.firstName} {review.employee?.lastName}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {review.finalRating !== null && review.finalRating !== undefined && (
                    <div className="flex items-center gap-1 text-warning-600 dark:text-warning-400">
                      <Star className="h-4 w-4 fill-warning-500" />
                      <span className="text-sm font-medium">{review.finalRating.toFixed(1)}</span>
                    </div>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      review.status === ReviewStatus.FINALIZED
                        ? 'bg-success-100 text-success-800 dark:bg-success-900/30 dark:text-success-400'
                        : review.status === ReviewStatus.MANAGER_REVIEW ||
                            review.status === ReviewStatus.SELF_ASSESSMENT
                          ? 'bg-info-100 text-info-800 dark:bg-info-900/30 dark:text-info-400'
                          : 'bg-warning-100 text-warning-800 dark:bg-warning-900/30 dark:text-warning-400',
                    )}
                  >
                    {review.status}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="flex h-32 flex-col items-center justify-center text-center">
              <BarChart3 className="mb-2 h-8 w-8 text-gray-400 dark:text-gray-500" />
              <p className="text-gray-500 dark:text-gray-400">No performance reviews found</p>
            </div>
          )}
        </div>
      )}

      {/* Goals Tab */}
      {activeTab === 'goals' && (
        <div className="flex h-32 flex-col items-center justify-center text-center">
          <Target className="mb-2 h-8 w-8 text-gray-400 dark:text-gray-500" />
          <p className="text-gray-500 dark:text-gray-400">
            Goals tracking available in the Goals section
          </p>
          <Link
            to="/hr/performance/goals"
            className="mt-3 text-sm text-primary-600 dark:text-primary-400 hover:underline"
          >
            Open Goals
          </Link>
        </div>
      )}
    </div>
  );
};

export default PerformancePage;
