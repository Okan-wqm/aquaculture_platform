/**
 * Onboarding Page
 *
 * Tenant onboarding ve training management sistemi.
 * Welcome emails, getting started guides, video tutorials, training sessions.
 */

import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

interface OnboardingProgress {
  id: string;
  tenantId: string;
  tenantName: string;
  status: OnboardingStatus;
  completionPercent: number;
  completedSteps: string[];
  currentStep: string;
  startedAt?: string;
  completedAt?: string;
  welcomeEmailSent: boolean;
  welcomeEmailSentAt?: string;
  gettingStartedViewed: boolean;
  viewedTutorials: string[];
  scheduledTrainings: TrainingSession[];
  assignedGuide?: string;
  assignedGuideName?: string;
  createdAt: string;
  updatedAt: string;
}

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  order: number;
  isRequired: boolean;
  estimatedMinutes: number;
  videoUrl?: string;
}

interface TrainingSession {
  id: string;
  title: string;
  scheduledAt: string;
  duration: number;
  trainer: string;
  status: 'scheduled' | 'completed' | 'cancelled';
  notes?: string;
}

interface TrainingResource {
  id: string;
  title: string;
  description: string;
  type: 'video' | 'document' | 'webinar' | 'interactive';
  url: string;
  duration: number;
  category: string;
}

interface OnboardingStats {
  total: number;
  notStarted: number;
  inProgress: number;
  completed: number;
  skipped: number;
  avgCompletionPercent: number;
  avgCompletionDays: number;
  completionByStep: Record<string, number>;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockSteps: OnboardingStep[] = [
  { id: 'welcome', title: 'Welcome Email', description: 'Receive welcome email with getting started guide', order: 1, isRequired: true, estimatedMinutes: 5 },
  { id: 'profile_setup', title: 'Complete Profile', description: 'Set up your organization profile and preferences', order: 2, isRequired: true, estimatedMinutes: 10 },
  { id: 'team_invite', title: 'Invite Team Members', description: 'Add your team members and assign roles', order: 3, isRequired: false, estimatedMinutes: 15 },
  { id: 'farm_setup', title: 'Set Up First Farm', description: 'Configure your first farm with sites and pools', order: 4, isRequired: true, estimatedMinutes: 20, videoUrl: '/tutorials/farm-setup' },
  { id: 'sensor_config', title: 'Configure Sensors', description: 'Add and configure monitoring sensors', order: 5, isRequired: false, estimatedMinutes: 30, videoUrl: '/tutorials/sensor-setup' },
  { id: 'alert_rules', title: 'Set Up Alert Rules', description: 'Configure automated alerts and notifications', order: 6, isRequired: false, estimatedMinutes: 15, videoUrl: '/tutorials/alerts' },
  { id: 'dashboard_tour', title: 'Dashboard Tour', description: 'Take a guided tour of the main dashboard', order: 7, isRequired: false, estimatedMinutes: 10, videoUrl: '/tutorials/dashboard-tour' },
  { id: 'reports_intro', title: 'Reports Introduction', description: 'Learn how to generate and export reports', order: 8, isRequired: false, estimatedMinutes: 10, videoUrl: '/tutorials/reports' },
];

const mockProgress: OnboardingProgress[] = [
  {
    id: 'progress-001',
    tenantId: 'tenant-001',
    tenantName: 'Aegean Aquaculture Ltd',
    status: 'in_progress',
    completionPercent: 75,
    completedSteps: ['welcome', 'profile_setup', 'farm_setup'],
    currentStep: 'team_invite',
    startedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    welcomeEmailSent: true,
    welcomeEmailSentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    gettingStartedViewed: true,
    viewedTutorials: ['getting-started', 'farm-management'],
    scheduledTrainings: [
      { id: 'train-001', title: 'Advanced Features Training', scheduledAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(), duration: 60, trainer: 'John Trainer', status: 'scheduled' },
    ],
    assignedGuide: 'guide-001',
    assignedGuideName: 'Sarah Support',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: 'progress-002',
    tenantId: 'tenant-002',
    tenantName: 'Mediterranean Fish Co',
    status: 'completed',
    completionPercent: 100,
    completedSteps: ['welcome', 'profile_setup', 'team_invite', 'farm_setup', 'sensor_config', 'alert_rules', 'dashboard_tour', 'reports_intro'],
    currentStep: 'reports_intro',
    startedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    completedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    welcomeEmailSent: true,
    welcomeEmailSentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    gettingStartedViewed: true,
    viewedTutorials: ['getting-started', 'farm-management', 'sensor-integration', 'alert-system', 'reporting'],
    scheduledTrainings: [
      { id: 'train-002', title: 'Initial Setup Training', scheduledAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(), duration: 90, trainer: 'Mike Trainer', status: 'completed', notes: 'Covered all basics successfully' },
    ],
    assignedGuide: 'guide-002',
    assignedGuideName: 'Mike Support',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
  },
  {
    id: 'progress-003',
    tenantId: 'tenant-003',
    tenantName: 'Nordic Fisheries AS',
    status: 'not_started',
    completionPercent: 0,
    completedSteps: [],
    currentStep: 'welcome',
    welcomeEmailSent: false,
    gettingStartedViewed: false,
    viewedTutorials: [],
    scheduledTrainings: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
  },
  {
    id: 'progress-004',
    tenantId: 'tenant-004',
    tenantName: 'Pacific Salmon Farm',
    status: 'in_progress',
    completionPercent: 33,
    completedSteps: ['welcome'],
    currentStep: 'profile_setup',
    startedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString(),
    welcomeEmailSent: true,
    welcomeEmailSentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString(),
    gettingStartedViewed: false,
    viewedTutorials: [],
    scheduledTrainings: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString(),
  },
  {
    id: 'progress-005',
    tenantId: 'tenant-005',
    tenantName: 'Atlantic Seafood Inc',
    status: 'skipped',
    completionPercent: 50,
    completedSteps: ['welcome', 'profile_setup'],
    currentStep: 'team_invite',
    startedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    welcomeEmailSent: true,
    welcomeEmailSentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    gettingStartedViewed: true,
    viewedTutorials: ['getting-started'],
    scheduledTrainings: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8).toISOString(),
  },
];

const mockResources: TrainingResource[] = [
  { id: 'getting-started', title: 'Getting Started Guide', description: 'Complete guide to setting up your aquaculture management system', type: 'document', url: '/docs/getting-started', duration: 30, category: 'basics' },
  { id: 'farm-management', title: 'Farm Management Tutorial', description: 'Learn how to manage farms, sites, and pools', type: 'video', url: '/videos/farm-management', duration: 15, category: 'core' },
  { id: 'sensor-integration', title: 'Sensor Integration Guide', description: 'How to integrate and configure IoT sensors', type: 'video', url: '/videos/sensor-integration', duration: 20, category: 'advanced' },
  { id: 'alert-system', title: 'Alert System Configuration', description: 'Configure automated alerts and notifications', type: 'video', url: '/videos/alert-system', duration: 12, category: 'core' },
  { id: 'reporting', title: 'Reporting & Analytics', description: 'Generate insights with reports and analytics', type: 'video', url: '/videos/reporting', duration: 18, category: 'core' },
  { id: 'mobile-app', title: 'Mobile App Usage', description: 'Use the mobile app for on-the-go management', type: 'video', url: '/videos/mobile-app', duration: 10, category: 'advanced' },
  { id: 'api-integration', title: 'API Integration Guide', description: 'Integrate with external systems using our API', type: 'document', url: '/docs/api-integration', duration: 45, category: 'developer' },
  { id: 'best-practices', title: 'Best Practices Webinar', description: 'Monthly webinar on aquaculture management best practices', type: 'webinar', url: '/webinars/best-practices', duration: 60, category: 'advanced' },
];

const mockStats: OnboardingStats = {
  total: 156,
  notStarted: 12,
  inProgress: 28,
  completed: 108,
  skipped: 8,
  avgCompletionPercent: 78,
  avgCompletionDays: 7,
  completionByStep: {
    welcome: 144,
    profile_setup: 138,
    team_invite: 89,
    farm_setup: 132,
    sensor_config: 78,
    alert_rules: 95,
    dashboard_tour: 112,
    reports_intro: 108,
  },
};

const guides = [
  { id: 'guide-001', name: 'Sarah Support', activeOnboardings: 8 },
  { id: 'guide-002', name: 'Mike Support', activeOnboardings: 5 },
  { id: 'guide-003', name: 'Lisa Support', activeOnboardings: 6 },
];

// ============================================================================
// Component
// ============================================================================

export const OnboardingPage: React.FC = () => {
  const [progressList, setProgressList] = useState<OnboardingProgress[]>(mockProgress);
  const [stats, setStats] = useState<OnboardingStats>(mockStats);
  const [selectedProgress, setSelectedProgress] = useState<OnboardingProgress | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<OnboardingStatus | 'all'>('all');
  const [showNeedingAttention, setShowNeedingAttention] = useState(false);
  const [activeTab, setActiveTab] = useState<'progress' | 'resources'>('progress');

  const filteredProgress = progressList.filter(progress => {
    if (searchQuery && !progress.tenantName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (statusFilter !== 'all' && progress.status !== statusFilter) return false;
    if (showNeedingAttention) {
      // Show tenants stuck for more than 30 days
      const daysSinceUpdate = (Date.now() - new Date(progress.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 30 || progress.status === 'completed' || progress.status === 'skipped') return false;
    }
    return true;
  });

  const getStatusColor = (status: OnboardingStatus) => {
    switch (status) {
      case 'not_started': return 'bg-gray-100 text-gray-700';
      case 'in_progress': return 'bg-blue-100 text-blue-700';
      case 'completed': return 'bg-green-100 text-green-700';
      case 'skipped': return 'bg-yellow-100 text-yellow-700';
    }
  };

  const getResourceIcon = (type: TrainingResource['type']) => {
    switch (type) {
      case 'video': return <Video size={16} className="text-purple-500" />;
      case 'document': return <FileText size={16} className="text-blue-500" />;
      case 'webinar': return <Users size={16} className="text-green-500" />;
      case 'interactive': return <Play size={16} className="text-orange-500" />;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  const handleSendWelcomeEmail = async (progressId: string) => {
    setProgressList(progressList.map(p =>
      p.id === progressId
        ? { ...p, welcomeEmailSent: true, welcomeEmailSentAt: new Date().toISOString() }
        : p
    ));
  };

  const handleAssignGuide = async (progressId: string, guideId: string) => {
    const guide = guides.find(g => g.id === guideId);
    setProgressList(progressList.map(p =>
      p.id === progressId
        ? { ...p, assignedGuide: guideId, assignedGuideName: guide?.name }
        : p
    ));
    if (selectedProgress?.id === progressId) {
      setSelectedProgress({ ...selectedProgress, assignedGuide: guideId, assignedGuideName: guide?.name });
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Onboarding & Training</h1>
            <p className="text-gray-500 mt-1">Manage tenant onboarding and training resources</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-7 gap-3 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-sm text-gray-500">Total Tenants</div>
            <div className="text-xl font-semibold text-gray-900">{stats.total}</div>
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
            <div className="text-sm text-yellow-600">Skipped</div>
            <div className="text-xl font-semibold text-yellow-700">{stats.skipped}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-3">
            <div className="text-sm text-purple-600">Avg Completion</div>
            <div className="text-xl font-semibold text-purple-700">{stats.avgCompletionPercent}%</div>
          </div>
          <div className="bg-indigo-50 rounded-lg p-3">
            <div className="text-sm text-indigo-600">Avg Days</div>
            <div className="text-xl font-semibold text-indigo-700">{stats.avgCompletionDays}</div>
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
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
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
                  <option value="skipped">Skipped</option>
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
                const daysSinceUpdate = Math.floor((Date.now() - new Date(progress.updatedAt).getTime()) / (1000 * 60 * 60 * 24));
                const needsAttention = daysSinceUpdate > 30 && progress.status !== 'completed' && progress.status !== 'skipped';

                return (
                  <div
                    key={progress.id}
                    onClick={() => setSelectedProgress(progress)}
                    className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                      selectedProgress?.id === progress.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Building2 size={16} className="text-gray-400" />
                          <span className="font-medium text-gray-900">{progress.tenantName}</span>
                          {needsAttention && (
                            <AlertTriangle size={14} className="text-red-500" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(progress.status)}`}>
                            {progress.status.replace('_', ' ')}
                          </span>
                          <span className="text-sm text-gray-500">
                            {progress.completionPercent}% complete
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{ width: `${progress.completionPercent}%` }}
                          />
                        </div>

                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                          <span>{progress.completedSteps.length}/{mockSteps.length} steps</span>
                          {progress.assignedGuideName && (
                            <span className="flex items-center gap-1">
                              <User size={12} />
                              {progress.assignedGuideName}
                            </span>
                          )}
                          {needsAttention && (
                            <span className="text-red-500">{daysSinceUpdate} days inactive</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight size={18} className="text-gray-400" />
                    </div>
                  </div>
                );
              })}

              {filteredProgress.length === 0 && (
                <div className="p-8 text-center text-gray-500">
                  <GraduationCap size={48} className="mx-auto mb-3 text-gray-300" />
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
                      <span className={`px-2 py-0.5 text-xs rounded ${getStatusColor(selectedProgress.status)}`}>
                        {selectedProgress.status.replace('_', ' ')}
                      </span>
                      <span className="text-sm text-gray-500">
                        {selectedProgress.completionPercent}% complete
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedProgress(null)}
                    className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                  >
                    <X size={20} />
                  </button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 mt-4">
                  {!selectedProgress.welcomeEmailSent && (
                    <button
                      onClick={() => handleSendWelcomeEmail(selectedProgress.id)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
                    >
                      <Mail size={14} />
                      Send Welcome Email
                    </button>
                  )}
                  <select
                    value={selectedProgress.assignedGuide || ''}
                    onChange={(e) => handleAssignGuide(selectedProgress.id, e.target.value)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Assign Guide...</option>
                    {guides.map((guide) => (
                      <option key={guide.id} value={guide.id}>
                        {guide.name} ({guide.activeOnboardings} active)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Progress Detail */}
              <div className="p-6 space-y-6">
                {/* Onboarding Steps */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-900 mb-4">Onboarding Steps</h3>
                  <div className="space-y-3">
                    {mockSteps.map((step) => {
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
                                {step.title}
                              </span>
                              {step.isRequired && (
                                <span className="text-xs text-red-500">Required</span>
                              )}
                            </div>
                            <p className="text-sm text-gray-500 mt-0.5">{step.description}</p>
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
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

                {/* Training Sessions */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-gray-900">Training Sessions</h3>
                    <button className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
                      <Plus size={14} />
                      Schedule Training
                    </button>
                  </div>
                  {selectedProgress.scheduledTrainings.length > 0 ? (
                    <div className="space-y-3">
                      {selectedProgress.scheduledTrainings.map((session) => (
                        <div key={session.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                          <div>
                            <div className="font-medium text-gray-900">{session.title}</div>
                            <div className="flex items-center gap-3 text-sm text-gray-500 mt-1">
                              <span className="flex items-center gap-1">
                                <Calendar size={12} />
                                {formatDate(session.scheduledAt)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock size={12} />
                                {session.duration}m
                              </span>
                              <span className="flex items-center gap-1">
                                <User size={12} />
                                {session.trainer}
                              </span>
                            </div>
                          </div>
                          <span className={`px-2 py-1 text-xs rounded ${
                            session.status === 'completed' ? 'bg-green-100 text-green-700' :
                            session.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {session.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 text-center py-4">No training sessions scheduled</p>
                  )}
                </div>

                {/* Viewed Resources */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-900 mb-4">Viewed Resources</h3>
                  {selectedProgress.viewedTutorials.length > 0 ? (
                    <div className="space-y-2">
                      {selectedProgress.viewedTutorials.map((tutorialId) => {
                        const resource = mockResources.find(r => r.id === tutorialId);
                        if (!resource) return null;
                        return (
                          <div key={tutorialId} className="flex items-center gap-3 p-2 bg-gray-50 rounded">
                            {getResourceIcon(resource.type)}
                            <span className="text-sm text-gray-700">{resource.title}</span>
                            <CheckCircle size={14} className="text-green-500 ml-auto" />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 text-center py-4">No resources viewed yet</p>
                  )}
                </div>

                {/* Timeline */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-900 mb-4">Timeline</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 bg-gray-400 rounded-full" />
                      <span className="text-gray-500">Created</span>
                      <span className="text-gray-700">{formatDate(selectedProgress.createdAt)}</span>
                    </div>
                    {selectedProgress.welcomeEmailSentAt && (
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 bg-blue-500 rounded-full" />
                        <span className="text-gray-500">Welcome Email Sent</span>
                        <span className="text-gray-700">{formatDate(selectedProgress.welcomeEmailSentAt)}</span>
                      </div>
                    )}
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
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 bg-gray-300 rounded-full" />
                      <span className="text-gray-500">Last Activity</span>
                      <span className="text-gray-700">{formatDate(selectedProgress.updatedAt)}</span>
                    </div>
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
              const categoryResources = mockResources.filter(r => r.category === category);
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
                            <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                              {resource.description}
                            </p>
                            <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                              <span className="flex items-center gap-1">
                                <Clock size={12} />
                                {formatDuration(resource.duration)}
                              </span>
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

            {/* Step Completion Stats */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Step Completion Rates</h2>
              <div className="space-y-4">
                {mockSteps.map((step) => {
                  const completions = stats.completionByStep[step.id] || 0;
                  const rate = Math.round((completions / stats.total) * 100);

                  return (
                    <div key={step.id}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-700">{step.title}</span>
                        <span className="text-sm text-gray-500">
                          {completions}/{stats.total} ({rate}%)
                        </span>
                      </div>
                      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${rate}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OnboardingPage;
