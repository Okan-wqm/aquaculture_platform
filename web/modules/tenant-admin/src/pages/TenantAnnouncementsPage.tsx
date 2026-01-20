/**
 * Tenant Announcements Page
 *
 * View platform announcements for TenantAdmin.
 * - View published announcements
 * - Acknowledge announcements when required
 * - Filter by type and read status
 *
 * Note: TenantAdmin cannot:
 * - Create or edit announcements
 * - See draft/scheduled/cancelled announcements
 */

import React, { useState, useEffect } from 'react';
import {
  Megaphone,
  Search,
  Calendar,
  Clock,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Wrench,
  Info,
  Bell,
  X,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { announcementsApi, type Announcement } from '../services/tenantApi';

// ============================================================================
// Types
// ============================================================================

// Types imported from tenantApi
type AnnouncementType = 'info' | 'warning' | 'error' | 'maintenance' | 'success';

// Extended announcement interface with local state
interface ExtendedAnnouncement extends Announcement {
  isRead?: boolean;
  isAcknowledged?: boolean;
  acknowledgedAt?: string;
  requiresAcknowledgment?: boolean;
}

// Helper to map announcement types
const mapAnnouncementType = (type: string): AnnouncementType => {
  // Map backend types to frontend types
  if (type === 'critical') return 'error';
  return type as AnnouncementType;
};

// ============================================================================
// Component
// ============================================================================

export const TenantAnnouncementsPage: React.FC = () => {
  const [announcements, setAnnouncements] = useState<ExtendedAnnouncement[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<AnnouncementType | 'all'>('all');
  const [readFilter, setReadFilter] = useState<'all' | 'unread' | 'requires_ack'>('all');
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<ExtendedAnnouncement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Local state for read/acknowledged status (could be persisted to backend later)
  const [localState, setLocalState] = useState<Record<string, { isRead: boolean; isAcknowledged: boolean; acknowledgedAt?: string }>>({});

  // Fetch announcements from backend
  const fetchAnnouncements = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await announcementsApi.getAnnouncements();
      
      // Extend announcements with local state
      const extended: ExtendedAnnouncement[] = data.map(ann => ({
        ...ann,
        type: mapAnnouncementType(ann.type),
        isRead: localState[ann.id]?.isRead || false,
        isAcknowledged: localState[ann.id]?.isAcknowledged || false,
        acknowledgedAt: localState[ann.id]?.acknowledgedAt,
        requiresAcknowledgment: ann.priority === 'high', // High priority requires acknowledgment
      }));
      
      setAnnouncements(extended);
    } catch (err) {
      console.error('Failed to fetch announcements:', err);
      setError(err instanceof Error ? err.message : 'Failed to load announcements');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnnouncements();
  }, []);

  // Stats
  const unreadCount = announcements.filter((a) => !a.isRead).length;
  const pendingAckCount = announcements.filter((a) => a.requiresAcknowledgment && !a.isAcknowledged).length;

  const filteredAnnouncements = announcements.filter((ann) => {
    if (
      searchQuery &&
      !ann.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !ann.content.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    if (typeFilter !== 'all' && mapAnnouncementType(ann.type) !== typeFilter) return false;
    if (readFilter === 'unread' && ann.isRead) return false;
    if (readFilter === 'requires_ack' && (!ann.requiresAcknowledgment || ann.isAcknowledged)) return false;
    return true;
  });

  const getTypeIcon = (type: AnnouncementType | string) => {
    const mappedType = typeof type === 'string' ? mapAnnouncementType(type) : type;
    switch (mappedType) {
      case 'info':
        return <Info size={18} className="text-blue-500" />;
      case 'warning':
        return <AlertTriangle size={18} className="text-yellow-500" />;
      case 'error':
        return <AlertCircle size={18} className="text-red-500" />;
      case 'maintenance':
        return <Wrench size={18} className="text-purple-500" />;
      case 'success':
        return <CheckCircle size={18} className="text-green-500" />;
      default:
        return <Info size={18} className="text-blue-500" />;
    }
  };

  const getTypeColor = (type: AnnouncementType | string) => {
    const mappedType = typeof type === 'string' ? mapAnnouncementType(type) : type;
    switch (mappedType) {
      case 'info':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'warning':
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'error':
        return 'bg-red-100 text-red-700 border-red-200';
      case 'maintenance':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'success':
        return 'bg-green-100 text-green-700 border-green-200';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const getTypeBgColor = (type: AnnouncementType | string) => {
    const mappedType = typeof type === 'string' ? mapAnnouncementType(type) : type;
    switch (mappedType) {
      case 'info':
        return 'border-l-blue-500';
      case 'warning':
        return 'border-l-yellow-500';
      case 'error':
        return 'border-l-red-500';
      case 'maintenance':
        return 'border-l-purple-500';
      case 'success':
        return 'border-l-green-500';
      default:
        return 'border-l-gray-500';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours < 1) return `${Math.round(diff / (1000 * 60))} minutes ago`;
    if (hours < 24) return `${Math.round(hours)} hours ago`;
    if (hours < 48) return 'Yesterday';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleViewAnnouncement = async (announcement: ExtendedAnnouncement) => {
    // Mark as read locally
    if (!announcement.isRead) {
      setLocalState(prev => ({
        ...prev,
        [announcement.id]: { ...prev[announcement.id], isRead: true }
      }));
      
      setAnnouncements(
        announcements.map((a) => (a.id === announcement.id ? { ...a, isRead: true } : a))
      );
      
      // Mark as viewed on backend
      try {
        await announcementsApi.markAsViewed(announcement.id);
      } catch (err) {
        console.error('Failed to mark as viewed:', err);
      }
    }
    setSelectedAnnouncement({ ...announcement, isRead: true });
  };

  const handleAcknowledge = async (announcementId: string) => {
    const now = new Date().toISOString();
    
    // Update local state
    setLocalState(prev => ({
      ...prev,
      [announcementId]: { 
        ...prev[announcementId], 
        isAcknowledged: true, 
        acknowledgedAt: now 
      }
    }));
    
    setAnnouncements(
      announcements.map((a) =>
        a.id === announcementId
          ? { ...a, isAcknowledged: true, acknowledgedAt: now }
          : a
      )
    );
    
    if (selectedAnnouncement?.id === announcementId) {
      setSelectedAnnouncement({
        ...selectedAnnouncement,
        isAcknowledged: true,
        acknowledgedAt: now,
      });
    }
    
    // Send to backend
    try {
      await announcementsApi.acknowledgeAnnouncement(announcementId);
    } catch (err) {
      console.error('Failed to acknowledge announcement:', err);
    }
  };

  const handleMarkAllRead = async () => {
    // Update all to read locally
    const newState = { ...localState };
    announcements.forEach(a => {
      newState[a.id] = { ...newState[a.id], isRead: true };
    });
    setLocalState(newState);
    
    setAnnouncements(announcements.map((a) => ({ ...a, isRead: true })));
    
    // Mark all as viewed on backend
    try {
      await Promise.all(
        announcements
          .filter(a => !a.isRead)
          .map(a => announcementsApi.markAsViewed(a.id))
      );
    } catch (err) {
      console.error('Failed to mark all as read:', err);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
            <p className="text-gray-500 mt-1">Platform updates and important notices</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchAnnouncements}
              disabled={loading}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-tenant-600 hover:bg-tenant-50 rounded-lg transition-colors"
              >
                <CheckCircle className="w-4 h-4" />
                Mark all as read
              </button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-500">Total</span>
            </div>
            <div className="text-xl font-semibold text-gray-900 mt-1">{announcements.length}</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-blue-500" />
              <span className="text-sm text-blue-600">Unread</span>
            </div>
            <div className="text-xl font-semibold text-blue-700 mt-1">{unreadCount}</div>
          </div>
          <div className="bg-orange-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-orange-500" />
              <span className="text-sm text-orange-600">Pending Acknowledgment</span>
            </div>
            <div className="text-xl font-semibold text-orange-700 mt-1">{pendingAckCount}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-500" />
              <span className="text-sm text-green-600">Acknowledged</span>
            </div>
            <div className="text-xl font-semibold text-green-700 mt-1">
              {announcements.filter((a) => a.isAcknowledged).length}
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              placeholder="Search announcements..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500 focus:border-tenant-500"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as AnnouncementType | 'all')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Types</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Critical</option>
            <option value="maintenance">Maintenance</option>
            <option value="success">Success</option>
          </select>
          <select
            value={readFilter}
            onChange={(e) => setReadFilter(e.target.value as 'all' | 'unread' | 'requires_ack')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-tenant-500"
          >
            <option value="all">All Announcements</option>
            <option value="unread">Unread Only</option>
            <option value="requires_ack">Needs Acknowledgment</option>
          </select>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Announcement List */}
        <div
          className={`${selectedAnnouncement ? 'w-1/2' : 'w-full'} flex flex-col border-r border-gray-200 bg-white overflow-y-auto`}
        >
          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-b border-red-100">
              <div className="flex items-center gap-2 text-red-700">
                <AlertCircle size={18} />
                <span className="text-sm">{error}</span>
                <button
                  onClick={fetchAnnouncements}
                  className="ml-auto text-sm underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-tenant-600" />
            </div>
          ) : filteredAnnouncements.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              <div className="text-center">
                <Megaphone size={48} className="mx-auto mb-3 text-gray-300" />
                <p className="font-medium">No announcements found</p>
                <p className="text-sm mt-1">Try adjusting your filters</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredAnnouncements.map((announcement) => (
                <div
                  key={announcement.id}
                  onClick={() => handleViewAnnouncement(announcement)}
                  className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors border-l-4 ${getTypeBgColor(announcement.type)} ${
                    selectedAnnouncement?.id === announcement.id ? 'bg-tenant-50' : ''
                  } ${!announcement.isRead ? 'bg-blue-50/50' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">{getTypeIcon(announcement.type)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3
                          className={`font-medium ${!announcement.isRead ? 'text-gray-900' : 'text-gray-700'}`}
                        >
                          {announcement.title}
                        </h3>
                        {!announcement.isRead && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-blue-500 text-white rounded">
                            NEW
                          </span>
                        )}
                        {announcement.requiresAcknowledgment && !announcement.isAcknowledged && (
                          <span className="px-1.5 py-0.5 text-xs font-medium bg-orange-500 text-white rounded">
                            ACK REQUIRED
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">{announcement.content}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          {formatDate(announcement.publishedAt || announcement.createdAt)}
                        </span>
                        <span>by {announcement.createdBy}</span>
                        <span className={`px-2 py-0.5 rounded ${getTypeColor(announcement.type)}`}>
                          {announcement.type}
                        </span>
                      </div>
                    </div>
                    {announcement.isAcknowledged && (
                      <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Announcement Detail */}
        {selectedAnnouncement && (
          <div className="w-1/2 flex flex-col bg-gray-50">
            {/* Detail Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-1">{getTypeIcon(selectedAnnouncement.type)}</div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {selectedAnnouncement.title}
                    </h2>
                    <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Calendar size={14} />
                        {formatDate(selectedAnnouncement.publishedAt || selectedAnnouncement.createdAt)}
                      </span>
                      <span>by {selectedAnnouncement.createdBy}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedAnnouncement(null)}
                  className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Type Badge */}
              <div className="mt-3">
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${getTypeColor(selectedAnnouncement.type)}`}
                >
                  {getTypeIcon(selectedAnnouncement.type)}
                  {selectedAnnouncement.type.charAt(0).toUpperCase() + selectedAnnouncement.type.slice(1)}
                </span>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {selectedAnnouncement.content}
                </p>
              </div>

              {/* Expiry Info */}
              {selectedAnnouncement.expiresAt && (
                <div className="mt-4 p-3 bg-yellow-50 rounded-lg border border-yellow-100">
                  <div className="flex items-center gap-2 text-sm text-yellow-700">
                    <Clock size={14} />
                    <span>
                      Expires: {new Date(selectedAnnouncement.expiresAt).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Acknowledgment Section */}
            {selectedAnnouncement.requiresAcknowledgment && (
              <div className="bg-white border-t border-gray-200 px-6 py-4">
                {selectedAnnouncement.isAcknowledged ? (
                  <div className="flex items-center justify-center gap-2 p-3 bg-green-50 rounded-lg text-green-700">
                    <CheckCircle size={18} />
                    <span className="text-sm font-medium">
                      You acknowledged this on{' '}
                      {new Date(selectedAnnouncement.acknowledgedAt!).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-orange-700">
                      <AlertCircle size={16} />
                      <span>This announcement requires your acknowledgment</span>
                    </div>
                    <button
                      onClick={() => handleAcknowledge(selectedAnnouncement.id)}
                      className="w-full px-4 py-2.5 bg-tenant-600 text-white rounded-lg hover:bg-tenant-700 font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      <CheckCircle size={18} />
                      I have read and understand this announcement
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TenantAnnouncementsPage;
