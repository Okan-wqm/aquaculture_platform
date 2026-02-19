/**
 * Training Page
 *
 * BUG-008: Mock data replaced with real API hooks.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap, Users, Clock, Award, Plus, Shield } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { useTrainingCourses, useCurrentEmployeeId } from '../hooks';
import type { CertificationCategory } from '../types';

const TrainingPage: React.FC = () => {
  const employeeId = useCurrentEmployeeId();

  // Only fetch active courses
  const { data: courses, isLoading } = useTrainingCourses({ isActive: true });

  const categoryColors: Record<string, string> = {
    safety: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    technical: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    compliance: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    soft_skills: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Training</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Training programs and certifications
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/hr/training/certifications"
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
          >
            <Shield className="h-4 w-4" />
            Certifications
          </Link>
          <button className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            <Plus className="h-4 w-4" />
            New Course
          </button>
        </div>
      </div>

      {/* Courses */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
        </div>
      ) : courses && courses.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <div
              key={course.id}
              className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="mb-3 flex items-start justify-between">
                <div className="rounded-lg bg-indigo-50 p-2 dark:bg-indigo-900/30">
                  <GraduationCap className="h-5 w-5 text-indigo-600" />
                </div>
                {course.category && (
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', categoryColors[course.category] || 'bg-gray-100 text-gray-800')}>
                    {course.category.replace('_', ' ')}
                  </span>
                )}
              </div>
              <h3 className="mb-1 font-medium text-gray-900 dark:text-white">{course.title}</h3>
              {course.description && (
                <p className="mb-3 text-sm text-gray-500 line-clamp-2">{course.description}</p>
              )}
              <div className="flex items-center justify-between text-xs text-gray-500">
                {course.durationHours && (
                  <div className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    <span>{course.durationHours}h</span>
                  </div>
                )}
                {course.maxParticipants && (
                  <div className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    <span>Max {course.maxParticipants}</span>
                  </div>
                )}
                {course.isMandatory && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    Required
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex h-48 flex-col items-center justify-center text-center">
          <GraduationCap className="mb-3 h-10 w-10 text-gray-400" />
          <p className="text-gray-500">No training courses found</p>
        </div>
      )}
    </div>
  );
};

export default TrainingPage;
