/**
 * Onboarding Page
 *
 * Tenant onboarding ve training management sistemi.
 * Welcome emails, getting started guides, video tutorials, training sessions.
 *
 * Sprint 3 Fix (Grup Q / C10-34): Mock data removed, real API integration via supportApi.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  GraduationCap,
  Play,
  FileText,
  Video,
  BookOpen,
  Calendar,
  CheckCircle,
  Clock,
  User,
  Building2,
  Search,
  Filter,
  ChevronRight,
  X,
  Mail,
  ExternalLink,
  Users,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  Plus,
  Loader2,
} from 'lucide-react';
import { supportApi } from '../services/adminApi';
import type { OnboardingStep as ApiOnboardingStep, TenantOnboarding } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'stalled';

interface TrainingResource {
  id: string;
  title: string;
  type: string;
  category: string;
  url: string;
}

interface OnboardingStats {
  notStarted: number;
  inProgress: number;
  completed: number;
  stalled: number;
  avgCompletionDays: number;
}

interface Guide {
  id: string;
  name: string;
  activeOnboardings: number;
}

// ============================================================================
// Component
// ============================================================================

export const OnboardingPage: React.FC = () => {
  // Data state
  const [progressList, setProgressList] = useState<readonly TenantOnboarding[]>([]);
  const [steps, setSteps] = useState<ApiOnboardingStep[]>([]);
  const [stats, setStats] = useState<OnboardingStats>({
    notStarted: 0,
    inProgress: 0,
    completed: 0,
    stalled: 0,
    avgCompletionDays: 0,
  });
  const [resources, setResources] = useState<TrainingResource[]>([]);

  // UI state
  const [selectedProgress, setSelectedProgress] = useState<TenantOnboarding | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<OnboardingStatus | 'all'>('all');
  const [showNeedingAttention, setShowNeedingAttention] = useState(false);
  const [activeTab, setActiveTab] = useState<'progress' | 'resources'>('progress');

  // Loading/error state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // ============================================================================
  // Data Loading
  // ============================================================================

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stepsData, onboardingsData, statsData, resourcesData] = await Promise.all([
        supportApi.getOnboardingSteps(),
        supportApi.getTenantOnboardings({
          status: statusFilter !== 'all' ? statusFilter : undefined,
        }),
        supportApi.getOnboardingStats(),
        supportApi.getTrainingResources(),
      ]);

      setSteps(stepsData);
      setProgressList(onboardingsData.data);
      setStats(statsData);
      setResources(resourcesData);
    } catch (err) {
      console.error('Failed to load onboarding data:', err);
      setError('Failed to load onboarding data. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ============================================================================
  // Filtered Data
  // ============================================================================

  const filteredProgress = progressList.filter(progress => {
    if (searchQuery && !progress.tenantName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (statusFilter !== 'all' && progress.status !== statusFilter) return false;
    if (showNeedingAttention) {
      if (!progress.lastActivityAt) return false;
      const daysSinceUpdate = (Date.now() - new Date(progress.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 30 || progress.status === 'completed') return false;
    }
    return true;
  });

  // ============================================================================
  // Helpers
  // ============================================================================

  const getStatusColor = (status: OnboardingStatus) => {
    switch (status) {
      case 'not_started': return 'bg-gray-100 text-gray-700';
      case 'in_progress': return 'bg-blue-100 text-blue-700';
      case 'completed': return 'bg-green-100 text-green-700';
      case 'stalled': return 'bg-yellow-100 text-yellow-700';
    }
  };

  const getResourceIcon = (type: string) => {
    switch (type) {
      case 'video': return <Video size={16} className="text-purple-500" />;
      case 'document': return <FileText size={16} className="text-blue-500" />;
      case 'webinar': return <Users size={16} className="text-green-500" />;
      case 'interactive': return <Play size={16} className="text-orange-500" />;
      default: return <BookOpen size={16} className="text-gray-500" />;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleInitializeOnboarding = async (tenantId: string, tenantName: string) => {
    setActionLoading(tenantId);
    try {
      const updated = await supportApi.initializeOnboarding(tenantId, tenantName);
      setProgressList(progressList.map(p =>
        p.tenantId === tenantId ? updated : p
      ));
      if (selectedProgress?.tenantId === tenantId) {
        setSelectedProgress(updated);
      }
    } catch (err) {
      console.error('Failed to initialize onboarding:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleAssignGuide = async (tenantId: string, guideId: string, guideName: string) => {
    setActionLoading(tenantId);
    try {
      const updated = await supportApi.assignOnboardingGuide(tenantId, guideId, guideName);
      setProgressList(progressList.map(p =>
        p.tenantId === tenantId ? updated : p
      ));
      if (selectedProgress?.tenantId === tenantId) {
        setSelectedProgress(updated);
      }
    } catch (err) {
      console.error('Failed to assign guide:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSkipOnboarding = async (tenantId: string) => {
    setActionLoading(tenantId);
    try {
      const updated = await supportApi.skipOnboarding(tenantId);
      setProgressList(progressList.map(p =>
        p.tenantId === tenantId ? updated : p
      ));
      if (selectedProgress?.tenantId === tenantId) {
        setSelectedProgress(updated);
      }
    } catch (err) {
      console.error('Failed to skip onboarding:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // ============================================================================
  // Render: Loading State
  // ============================================================================

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Loader2 size={48} className="mx-auto mb-3 text-blue-500 animate-spin" />
          <p className="text-gray-500">Loading onboarding data...</p>
        </div>
      </div>
    );
  }

  // ============================================================================
  // Render: Error State
  // ============================================================================

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle size={48} className="mx-auto mb-3 text-red-400" />
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={loadData}
            className="flex items-center gap-2 mx-auto px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ============================================================================
  // Render: Main
  // ============================================================================

  const totalTenants = stats.notStarted + stats.inProgress + stats.completed + stats.stalled;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Onboarding & Training</h1>
            <p className="text-gray-500 mt-1">Manage tenant onboarding and training resources</p>
          </div>
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-3 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Total Tenants</div>
            <div className="text-xl font-semibold text-gray-900">{totalTenants}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Not Started</div>
            <div className="text-xl font-semibold text-gray-700">{stats.notStarted}</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-3">
            <div className="text-sm text-blue-600">In Progress</div>
            <div className="text-xl font-semibold text-blue-700">{stats.inProgress}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3">
            <div className="text-sm text-green-600">Completed</div>
            <div className="text-xl font-semibold text-green-700">{stats.completed}</div>
          </div>
          <div className="bg-yellow-50 rounded-lg p-3">
            <div className="text-sm text-yellow-600">Stalled</div>
            <div className="text-xl font-semibold text-yellow-700">{stats.stalled}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-4 mt-4 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('progress')}
            className={`pb-3 px-1 text-sm font-medium border-b-2 -mb-px ${
              activeTab === 'progress'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Tenant Progress
          </button>
          <button
            onClick={() => setActiveTab('resources')}
            className={`pb-3 px-1 text-sm font-medium border-b-2 -mb-px ${
              activeTab === 'resources'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Training Resources
          </button>
        </div>
      </div>

      {activeTab === 'progress' ? (
        <div className="flex-1 flex overflow-hidden">
          {/* Progress List */}
          <div className={`${selectedProgress ? 'w-1/2' : 'w-full'} flex flex-col border-r border-gray-200 bg-white`}>
            {/* Filters */}
            <div className="p-4 border-b border-gray-200 space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
                <input
                  type="text"
                  placeholder="Search tenants..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as OnboardingStatus | 'all')}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Status</option>
                  <option value="not_started">Not Started</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="stalled">Stalled</option>
                </select>
                <button
                  onClick={() => setShowNeedingAttention(!showNeedingAttention)}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border ${
                    showNeedingAttention
                      ? 'bg-red-100 border-red-300 text-red-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <AlertTriangle size={14} />
                  Needs Attention
                </button>
              </div>
            </div>

            {/* Progress List */}
            <div className="flex-1 overflow-y-auto">
              {filteredProgress.map((progress) => {
                const daysSinceUpdate = progress.lastActivityAt
                  ? Math.floor((Date.now() - new Date(progress.lastActivityAt).getTime()) / (1000 * 60 * 60 * 24))
                  : 0;
                const needsAttention = daysSinceUpdate > 30 && progress.status !== 'completed';

                return (
                  <div
                    key={progress.tenantId}
                    onClick={() => setSelectedProgress(progress)}
                    className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                      selectedProgress?.tenantId === progress.tenantId ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Building2 size={16} className="text-gray-500" />
                          <span className="font-medium text-gray-900">{progress.tenantName}</span>
                          {needsAttention && (
                            <AlertTriangle size={14} className="text-red-500" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(progress.status as OnboardingStatus)}`}>
                            {progress.status.replace('_', ' ')}
                          </span>
                          <span className="text-sm text-gray-500">
                            {progress.progress}% complete
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{ width: `${progress.progress}%` }}
                          />
                        </div>

                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                          <span>{progress.completedSteps.length}/{steps.length} steps</span>
                          {progress.assignedTo && (
                            <span className="flex items-center gap-1">
                              <User size={12} />
                              {progress.assignedTo}
                            </span>
                          )}
                          {needsAttention && (
                            <span className="text-red-500">{daysSinceUpdate} days inactive</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight size={18} className="text-gray-500" />
                    </div>
                  </div>
                );
              })}

              {filteredProgress.length === 0 && (
                <div className="p-8 text-center text-gray-500">
                  <GraduationCap size={48} className="mx-auto mb-3 text-gray-500" />
                  <p>No onboarding progress found</p>
                </div>
              )}
            </div>
          </div>

          {/* Detail Panel */}
          {selectedProgress && (
            <div className="w-1/2 flex flex-col bg-gray-50 overflow-y-auto">
              {/* Header */}
              <div className="bg-white border-b border-gray-200 px-6 py-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {selectedProgress.tenantName}
                    </h2>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(selectedProgress.status as OnboardingStatus)}`}>
                        {selectedProgress.status.replace('_', ' ')}
                      </span>
                      <span className="text-sm text-gray-500">
                        {selectedProgress.progress}% complete
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedProgress(null)}
                    className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                  >
                    <X size={20} />
                  </button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 mt-4">
                  {selectedProgress.status === 'not_started' && (
                    <button
                      onClick={() => handleInitializeOnboarding(selectedProgress.tenantId, selectedProgress.tenantName)}
                      disabled={actionLoading === selectedProgress.tenantId}
                      className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      {actionLoading === selectedProgress.tenantId ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Mail size={14} />
                      )}
                      Start Onboarding
                    </button>
                  )}
                  {selectedProgress.status !== 'completed' && (
                    <button
                      onClick={() => handleSkipOnboarding(selectedProgress.tenantId)}
                      disabled={actionLoading === selectedProgress.tenantId}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                    >
                      Skip Onboarding
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Detail */}
              <div className="p-6 space-y-6">
                {/* Onboarding Steps */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-900 mb-4">Onboarding Steps</h3>
                  <div className="space-y-3">
                    {steps.map((step) => {
                      const isCompleted = selectedProgress.completedSteps.includes(step.id);
                      const isCurrent = selectedProgress.currentStep === step.id;

                      return (
                        <div
                          key={step.id}
                          className={`flex items-start gap-3 p-3 rounded-lg ${
                            isCompleted ? 'bg-green-50' : isCurrent ? 'bg-blue-50' : 'bg-gray-50'
                          }`}
                        >
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                            isCompleted ? 'bg-green-500' : isCurrent ? 'bg-blue-500' : 'bg-gray-300'
                          }`}>
                            {isCompleted ? (
                              <CheckCircle size={14} className="text-white" />
                            ) : (
                              <span className="text-xs text-white font-medium">{step.order}</span>
                            )}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`font-medium ${isCompleted ? 'text-green-700' : isCurrent ? 'text-blue-700' : 'text-gray-700'}`}>
                                {step.name}
                              </span>
                              {step.isRequired && (
                                <span className="text-xs text-red-500">Required</span>
                              )}
                            </div>
                            <p className="text-sm text-gray-500 mt-0.5">{step.description}</p>
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                              <span className="flex items-center gap-1">
                                <Clock size={12} />
                                ~{step.estimatedMinutes}m
                              </span>
                              {step.videoUrl && (
                                <a href={step.videoUrl} className="flex items-center gap-1 text-blue-500 hover:text-blue-600">
                                  <Play size={12} />
                                  Tutorial
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Notes */}
                {selectedProgress.notes && (
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <h3 className="font-semibold text-gray-900 mb-4">Notes</h3>
                    <p className="text-sm text-gray-600">{selectedProgress.notes}</p>
                  </div>
                )}

                {/* Timeline */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-900 mb-4">Timeline</h3>
                  <div className="space-y-3 text-sm">
                    {selectedProgress.startedAt && (
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 bg-purple-500 rounded-full" />
                        <span className="text-gray-500">Started Onboarding</span>
                        <span className="text-gray-700">{formatDate(selectedProgress.startedAt)}</span>
                      </div>
                    )}
                    {selectedProgress.completedAt && (
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 bg-green-500 rounded-full" />
                        <span className="text-gray-500">Completed</span>
                        <span className="text-gray-700">{formatDate(selectedProgress.completedAt)}</span>
                      </div>
                    )}
                    {selectedProgress.lastActivityAt && (
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 bg-gray-300 rounded-full" />
                        <span className="text-gray-500">Last Activity</span>
                        <span className="text-gray-700">{formatDate(selectedProgress.lastActivityAt)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        // Resources Tab
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto">
            {/* Category Sections */}
            {['basics', 'core', 'advanced', 'developer'].map((category) => {
              const categoryResources = resources.filter(r => r.category === category);
              if (categoryResources.length === 0) return null;

              return (
                <div key={category} className="mb-8">
                  <h2 className="text-lg font-semibold text-gray-900 mb-4 capitalize">
                    {category} Resources
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    {categoryResources.map((resource) => (
                      <div
                        key={resource.id}
                        className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-2 bg-gray-100 rounded-lg">
                            {getResourceIcon(resource.type)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-gray-900">{resource.title}</h3>
                            <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                              <span className="capitalize">{resource.type}</span>
                            </div>
                          </div>
                          <a
                            href={resource.url}
                            className="p-2 text-blue-500 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                          >
                            <ExternalLink size={16} />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {resources.length === 0 && (
              <div className="p-8 text-center text-gray-500">
                <BookOpen size={48} className="mx-auto mb-3 text-gray-500" />
                <p>No training resources available</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default OnboardingPage;
