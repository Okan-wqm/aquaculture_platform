/**
 * Announcements Page
 *
 * Platform duyuru sistemi - global ve hedefli duyurular.
 * Scheduling, acknowledgment tracking, announcement types.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Modal, PageHeader, Spinner, ToggleButton } from '@aquaculture/shared-ui';
import {
  Megaphone,
  Plus,
  Search,
  Filter,
  Calendar,
  Clock,
  Eye,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Wrench,
  Info,
  Send,
  Edit3,
  Trash2,
  Globe,
  Target,
  Users,
  BarChart3,
  RefreshCw,
} from 'lucide-react';
import {
  supportApi,
  type Announcement,
  type AnnouncementType,
  type AnnouncementStatus,
  type AnnouncementTarget,
} from '../services/adminApi';

interface AnnouncementStats {
  total: number;
  published: number;
  scheduled: number;
  draft: number;
  expired: number;
  totalViews: number;
  totalAcknowledgments: number;
  byType: Record<AnnouncementType, number>;
}

// ============================================================================
// Component
// ============================================================================

export const AnnouncementsPage: React.FC = () => {
  const [announcements, setAnnouncements] = useState<readonly Announcement[]>([]);
  const [stats, setStats] = useState<AnnouncementStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AnnouncementStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<AnnouncementType | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null);

  // Fetch announcements from API
  const fetchAnnouncements = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params: Record<string, unknown> = { limit: 100 };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (typeFilter !== 'all') params.type = typeFilter;

      const result = await supportApi.getAnnouncements(params);
      setAnnouncements(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setAnnouncements([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  // Fetch stats from API
  const fetchStats = useCallback(async () => {
    try {
      const data = await supportApi.getAnnouncementStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
    fetchStats();
  }, [fetchAnnouncements, fetchStats]);

  const filteredAnnouncements = announcements.filter((ann) => {
    if (
      searchQuery &&
      !ann.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !ann.content.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const getTypeIcon = (type: AnnouncementType) => {
    switch (type) {
      case 'info':
        return <Info size={16} className="text-info-500" />;
      case 'warning':
        return <AlertTriangle size={16} className="text-warning-500" />;
      case 'critical':
        return <AlertCircle size={16} className="text-error-500" />;
      case 'maintenance':
        return <Wrench size={16} className="text-accent-500" />;
    }
  };

  const getTypeColor = (type: AnnouncementType) => {
    switch (type) {
      case 'info':
        return 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300';
      case 'warning':
        return 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300';
      case 'critical':
        return 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300';
      case 'maintenance':
        return 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300';
    }
  };

  const getStatusColor = (status: AnnouncementStatus) => {
    switch (status) {
      case 'draft':
        return 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
      case 'scheduled':
        return 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300';
      case 'published':
        return 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300';
      case 'expired':
        return 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400';
      case 'cancelled':
        return 'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handlePublish = async (id: string) => {
    try {
      await supportApi.publishAnnouncement(id);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to publish:', err);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await supportApi.unpublishAnnouncement(id);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await supportApi.deleteAnnouncement(id);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const handleCreateAnnouncement = async (data: Partial<Announcement>) => {
    try {
      await supportApi.createAnnouncement(
        data as Parameters<typeof supportApi.createAnnouncement>[0],
      );
      setShowCreateModal(false);
      fetchAnnouncements();
      fetchStats();
    } catch (err) {
      console.error('Failed to create announcement:', err);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <PageHeader
          title="Announcements"
          description="Broadcast messages to all tenants"
          actions={
            <div className="flex items-center gap-2">
              <button
                aria-label="Refresh announcements"
                onClick={() => {
                  fetchAnnouncements();
                  fetchStats();
                }}
                className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <RefreshCw size={18} />
              </button>
              <button
                onClick={() => setShowCreateModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700"
              >
                <Plus size={18} />
                Create Announcement
              </button>
            </div>
          }
        />

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-7 gap-4 mt-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Total</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {stats.total}
              </div>
            </div>
            <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-3">
              <div className="text-sm text-success-600 dark:text-success-400">Published</div>
              <div className="text-xl font-semibold text-success-700 dark:text-success-300">
                {stats.published}
              </div>
            </div>
            <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-3">
              <div className="text-sm text-info-600 dark:text-info-400">Scheduled</div>
              <div className="text-xl font-semibold text-info-700 dark:text-info-300">
                {stats.scheduled}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Draft</div>
              <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {stats.draft}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-sm text-gray-500 dark:text-gray-400">Expired</div>
              <div className="text-xl font-semibold text-gray-600 dark:text-gray-400">
                {stats.expired}
              </div>
            </div>
            <div className="bg-accent-50 dark:bg-accent-900/20 rounded-lg p-3">
              <div className="text-sm text-accent-600 dark:text-accent-400">Total Views</div>
              <div className="text-xl font-semibold text-accent-700 dark:text-accent-300">
                {(stats.totalViews ?? 0).toLocaleString()}
              </div>
            </div>
            <div className="bg-primary-50 dark:bg-primary-900/20 rounded-lg p-3">
              <div className="text-sm text-primary-600 dark:text-primary-400">Acknowledged</div>
              <div className="text-xl font-semibold text-primary-700 dark:text-primary-300">
                {(stats.totalAcknowledgments ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
              size={18}
            />
            <input
              type="text"
              placeholder="Search announcements..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AnnouncementStatus | 'all')}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as AnnouncementType | 'all')}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500"
          >
            <option value="all">All Types</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
      </div>

      {/* Loading/Error States */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      )}

      {error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="mx-auto text-error-500 mb-2" size={32} />
            <p className="text-error-600 dark:text-error-400">{error}</p>
            <button
              onClick={fetchAnnouncements}
              className="mt-2 px-4 py-2 text-sm text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Announcement List */}
      {!loading && !error && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {filteredAnnouncements.map((announcement) => (
              <div
                key={announcement.id}
                className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">{getTypeIcon(announcement.type)}</div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                            {announcement.title}
                          </h3>
                          <span
                            className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(announcement.status)}`}
                          >
                            {announcement.status}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-xs rounded-full ${getTypeColor(announcement.type)}`}
                          >
                            {announcement.type}
                          </span>
                        </div>
                        <p className="text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                          {announcement.content}
                        </p>

                        {/* Meta Info */}
                        <div className="flex items-center gap-4 mt-3 text-sm text-gray-500 dark:text-gray-400">
                          {announcement.isGlobal ? (
                            <span className="flex items-center gap-1">
                              <Globe size={14} />
                              All Tenants
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <Target size={14} />
                              Targeted
                            </span>
                          )}
                          {announcement.publishAt && (
                            <span className="flex items-center gap-1">
                              <Calendar size={14} />
                              {formatDate(announcement.publishAt)}
                            </span>
                          )}
                          {announcement.requiresAcknowledgment && (
                            <span className="flex items-center gap-1 text-accent-600 dark:text-accent-400">
                              <CheckCircle size={14} />
                              Requires Ack
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Eye size={14} />
                            {announcement.viewCount} views
                          </span>
                          {announcement.requiresAcknowledgment && (
                            <span className="flex items-center gap-1">
                              <CheckCircle size={14} />
                              {announcement.acknowledgmentCount} acknowledged
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {announcement.status === 'draft' && (
                        <>
                          <button
                            onClick={() => handlePublish(announcement.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-success-600 rounded-lg hover:bg-success-700"
                          >
                            <Send size={14} />
                            Publish
                          </button>
                          <button
                            aria-label="Edit announcement"
                            onClick={() => setSelectedAnnouncement(announcement)}
                            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                          >
                            <Edit3 size={16} />
                          </button>
                          <button
                            aria-label="Delete announcement"
                            onClick={() => handleDelete(announcement.id)}
                            className="p-2 text-gray-500 dark:text-gray-400 hover:text-error-600 rounded-lg hover:bg-error-50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                      {announcement.status === 'scheduled' && (
                        <>
                          <button
                            onClick={() => handlePublish(announcement.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-success-600 rounded-lg hover:bg-success-700"
                          >
                            <Send size={14} />
                            Publish Now
                          </button>
                          <button
                            onClick={() => handleCancel(announcement.id)}
                            className="px-3 py-1.5 text-sm text-error-600 dark:text-error-400 hover:bg-error-50 dark:hover:bg-error-900/30 rounded-lg"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {announcement.status === 'published' && (
                        <button
                          onClick={() => setSelectedAnnouncement(announcement)}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                        >
                          <BarChart3 size={14} />
                          View Stats
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {filteredAnnouncements.length === 0 && (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                <Megaphone size={48} className="mx-auto mb-3 text-gray-500 dark:text-gray-400" />
                <p>No announcements found</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <AnnouncementFormModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreateAnnouncement}
        />
      )}

      {/* Stats Modal */}
      {selectedAnnouncement && (
        <AnnouncementStatsModal
          announcement={selectedAnnouncement}
          onClose={() => setSelectedAnnouncement(null)}
        />
      )}
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

interface AnnouncementFormModalProps {
  announcement?: Announcement;
  onClose: () => void;
  onSave: (data: Partial<Announcement>) => void;
}

/**
 * The tint the picker wears when a type is chosen. The severity belongs to the
 * TYPE, not to the state of the button, so it resolves through a lookup rather
 * than a four-deep ternary inside the class attribute.
 */
const announcementTypeSelected: Record<AnnouncementType, string> = {
  info: 'bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300',
  warning:
    'bg-warning-100 dark:bg-warning-900/40 border-warning-300 dark:border-warning-700 text-warning-700 dark:text-warning-300',
  critical:
    'bg-error-100 dark:bg-error-900/40 border-error-300 dark:border-error-700 text-error-700 dark:text-error-300',
  maintenance:
    'bg-accent-100 dark:bg-accent-900/40 border-accent-300 dark:border-accent-700 text-accent-700 dark:text-accent-300',
};

const AnnouncementFormModal: React.FC<AnnouncementFormModalProps> = ({
  announcement,
  onClose,
  onSave,
}) => {
  const [title, setTitle] = useState(announcement?.title || '');
  const [content, setContent] = useState(announcement?.content || '');
  const [type, setType] = useState<AnnouncementType>(announcement?.type || 'info');
  const [isGlobal, setIsGlobal] = useState(announcement?.isGlobal ?? true);
  const [scheduleType, setScheduleType] = useState<'now' | 'scheduled'>('now');
  const [publishAt, setPublishAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [requiresAcknowledgment, setRequiresAcknowledgment] = useState(
    announcement?.requiresAcknowledgment ?? false,
  );

  const handleSubmit = () => {
    onSave({
      title,
      content,
      type,
      isGlobal,
      publishAt: scheduleType === 'scheduled' ? new Date(publishAt).toISOString() : undefined,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      requiresAcknowledgment,
    });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={announcement ? 'Edit Announcement' : 'Create Announcement'}
      bodyClassName="p-6 space-y-4"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!title || !content}
            className="px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {scheduleType === 'scheduled' ? 'Schedule' : 'Save Draft'}
          </button>
        </>
      }
    >
      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          placeholder="Enter announcement title..."
        />
      </div>

      {/* Content */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Content
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 resize-none"
          placeholder="Enter announcement content..."
        />
      </div>

      {/* Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Type
        </label>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(['info', 'warning', 'critical', 'maintenance'] as AnnouncementType[]).map((t) => (
            <ToggleButton
              key={t}
              pressed={type === t}
              onClick={() => setType(t)}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg border transition-colors"
              pressedClassName={announcementTypeSelected[t]}
              idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {t === 'info' && <Info size={16} />}
              {t === 'warning' && <AlertTriangle size={16} />}
              {t === 'critical' && <AlertCircle size={16} />}
              {t === 'maintenance' && <Wrench size={16} />}
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </ToggleButton>
          ))}
        </div>
      </div>

      {/* Target */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Target Audience
        </label>
        <div className="flex gap-3">
          <ToggleButton
            type="button"
            onClick={() => setIsGlobal(true)}
            pressed={isGlobal}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border"
            pressedClassName="bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
            idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Globe size={18} />
            All Tenants
          </ToggleButton>
          <ToggleButton
            type="button"
            onClick={() => setIsGlobal(false)}
            pressed={!isGlobal}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border"
            pressedClassName="bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
            idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Target size={18} />
            Targeted
          </ToggleButton>
        </div>
      </div>

      {/* Scheduling */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Publishing
        </label>
        <div className="flex gap-3">
          <ToggleButton
            type="button"
            onClick={() => setScheduleType('now')}
            pressed={scheduleType === 'now'}
            className="flex-1 px-4 py-2 rounded-lg border"
            pressedClassName="bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
            idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Save as Draft
          </ToggleButton>
          <ToggleButton
            type="button"
            onClick={() => setScheduleType('scheduled')}
            pressed={scheduleType === 'scheduled'}
            className="flex-1 px-4 py-2 rounded-lg border"
            pressedClassName="bg-info-100 dark:bg-info-900/40 border-info-300 dark:border-info-700 text-info-700 dark:text-info-300"
            idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Schedule
          </ToggleButton>
        </div>
        {scheduleType === 'scheduled' && (
          <input
            type="datetime-local"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
            className="w-full mt-3 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
          />
        )}
      </div>

      {/* Expiry */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Expiry Date (Optional)
        </label>
        <input
          type="datetime-local"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500"
        />
      </div>

      {/* Options */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="requiresAck"
          checked={requiresAcknowledgment}
          onChange={(e) => setRequiresAcknowledgment(e.target.checked)}
          className="w-4 h-4 text-info-600 rounded border-gray-300 dark:border-gray-600 focus:ring-info-500"
        />
        <label htmlFor="requiresAck" className="text-sm text-gray-700 dark:text-gray-300">
          Require acknowledgment from users
        </label>
      </div>
    </Modal>
  );
};

interface AnnouncementStatsModalProps {
  announcement: Announcement;
  onClose: () => void;
}

const AnnouncementStatsModal: React.FC<AnnouncementStatsModalProps> = ({
  announcement,
  onClose,
}) => {
  const [acknowledgments, setAcknowledgments] = useState<
    Array<{
      userId: string;
      userName: string;
      tenantId: string;
      viewedAt: string;
      acknowledgedAt: string | null;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAcknowledgments = async () => {
      try {
        const data = await supportApi.getAnnouncementAcknowledgments(announcement.id);
        setAcknowledgments(data.acknowledgments || []);
      } catch (err) {
        console.error('Failed to fetch acknowledgments:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchAcknowledgments();
  }, [announcement.id]);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title="Announcement Statistics"
      bodyClassName="p-6 space-y-6"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Close
        </button>
      }
    >
      {/* Announcement Info */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">{announcement.title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{announcement.content}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-4 text-center">
          <Eye size={24} className="mx-auto text-info-600 dark:text-info-400 mb-2" />
          <div className="text-2xl font-bold text-info-700 dark:text-info-300">
            {announcement.viewCount}
          </div>
          <div className="text-sm text-info-600 dark:text-info-400">Total Views</div>
        </div>
        {announcement.requiresAcknowledgment && (
          <div className="bg-success-50 dark:bg-success-900/20 rounded-lg p-4 text-center">
            <CheckCircle
              size={24}
              className="mx-auto text-success-600 dark:text-success-400 mb-2"
            />
            <div className="text-2xl font-bold text-success-700 dark:text-success-300">
              {announcement.acknowledgmentCount}
            </div>
            <div className="text-sm text-success-600 dark:text-success-400">Acknowledged</div>
          </div>
        )}
      </div>

      {/* Acknowledgments List */}
      {announcement.requiresAcknowledgment && (
        <div>
          <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-3">Recent Activity</h4>
          {loading ? (
            <div className="flex justify-center py-4">
              <Spinner size="md" />
            </div>
          ) : acknowledgments.length > 0 ? (
            <div className="space-y-2">
              {acknowledgments.map((ack) => (
                <div
                  key={ack.userId}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div>
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {ack.userName}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      Tenant: {ack.tenantId}
                    </div>
                  </div>
                  <div className="text-right">
                    {ack.acknowledgedAt ? (
                      <span className="flex items-center gap-1 text-success-600 dark:text-success-400 text-sm">
                        <CheckCircle size={14} />
                        Acknowledged
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400 text-sm">
                        <Eye size={14} />
                        Viewed only
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-4">No activity yet</p>
          )}
        </div>
      )}
    </Modal>
  );
};

export default AnnouncementsPage;
