/**
 * Training Page
 *
 * BUG-008: Mock data replaced with real API hooks.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap, Users, Clock, Award, Plus, Shield } from 'lucide-react';
import { cn, Spinner, PageHeader, Button } from '@aquaculture/shared-ui';
import { useTrainingCourses, useCurrentEmployeeId } from '../hooks';
const TrainingPage: React.FC = () => {
  const employeeId = useCurrentEmployeeId();

  // Only fetch active courses
  const { data: courses, isLoading } = useTrainingCourses({ isActive: true });

  const categoryColors: Record<string, string> = {
    safety: 'bg-error-100 text-error-800 dark:bg-error-900/30 dark:text-error-400',
    technical: 'bg-info-100 text-info-800 dark:bg-info-900/30 dark:text-info-400',
    compliance: 'bg-accent-100 text-accent-800 dark:bg-accent-900/30 dark:text-accent-400',
    soft_skills: 'bg-accent-100 text-accent-800 dark:bg-accent-900/30 dark:text-accent-400',
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <PageHeader
        title="Training"
        description="Training programs and certifications"
        actions={
          <div className="flex items-center gap-3">
            <Link
              to="/hr/training/certifications"
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
            >
              <Shield className="h-4 w-4" />
              Certifications
            </Link>
            <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />}>
              New Course
            </Button>
          </div>
        }
      />

      {/* Courses */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner size="lg" />
        </div>
      ) : courses && courses.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <div
              key={course.id}
              className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="mb-3 flex items-start justify-between">
                <div className="rounded-lg bg-primary-50 p-2 dark:bg-primary-900/30">
                  <GraduationCap className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                </div>
                {course.trainingType && (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      categoryColors[course.trainingType.toLowerCase()] ||
                        'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
                    )}
                  >
                    {course.trainingType.replace('_', ' ')}
                  </span>
                )}
              </div>
              <h3 className="mb-1 font-medium text-gray-900 dark:text-white">{course.name}</h3>
              {course.description && (
                <p className="mb-3 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
                  {course.description}
                </p>
              )}
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                {course.durationMinutes && (
                  <div className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    <span>{Math.round(course.durationMinutes / 60)}h</span>
                  </div>
                )}
                {course.maxAttempts && (
                  <div className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    <span>Max {course.maxAttempts} attempts</span>
                  </div>
                )}
                {course.isMandatory && (
                  <span className="rounded-full bg-error-100 px-2 py-0.5 text-xs font-medium text-error-700 dark:bg-error-900/30 dark:text-error-400">
                    Required
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex h-48 flex-col items-center justify-center text-center">
          <GraduationCap className="mb-3 h-10 w-10 text-gray-400 dark:text-gray-500" />
          <p className="text-gray-500 dark:text-gray-400">No training courses found</p>
        </div>
      )}
    </div>
  );
};

export default TrainingPage;
