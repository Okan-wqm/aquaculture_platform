import { useAuth, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import { MessageSquare, Sparkles, Users, RefreshCw, AlertCircle } from 'lucide-react';
import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { useChannels } from '../hooks/useMessagingData';
import { useMessagingSocket } from '../hooks/useMessagingSocket';
import { channelTitle } from '../lib/channelDisplay';
import { messageBodyKind, messageBodyLabelKey } from '../lib/messageBody';
import type { Channel } from '../types/messaging';

function ChannelIcon({ channel }: { channel: Channel }): React.ReactElement {
  if (channel.type === 'AI') return <Sparkles size={19} />;
  if (channel.type === 'GROUP') return <Users size={19} />;
  return <MessageSquare size={19} />;
}

/**
 * Last-message preview: media references never leak into the list (URLs /
 * storage keys render as the localized label — FAZ 2.4 parity), deleted rows
 * fall back to the neutral empty-preview copy.
 */
function lastMessagePreview(channel: Channel, t: (key: MessageKey) => string): string {
  const last = channel.lastMessage;
  if (!last || last.isDeleted || last.content == null) {
    return t('messaging.noMessagesPreview');
  }
  const kind = messageBodyKind(last.contentType);
  return kind === 'text' ? last.content : t(messageBodyLabelKey(kind));
}

/**
 * Channel list — SUDERRA Tenant Console design (mockup "Messages" left card).
 * The selected channel highlights with the mint edge + tint exactly like the
 * mockup; selection is derived from the route so deep links highlight too.
 *
 * DATA SOURCE: 100% real — messaging-service `myChannels`. unreadCount is
 * computed per-user server-side (DB-authoritative); lastMessage rides the same
 * query. No mocked data on this page.
 *
 * FAZ 3.2 (channel-room decision): the socket is mounted HERE too — it joins
 * every myChannels room and keeps the list live through local cache mutations
 * (unread badge +1, last-message preview) with NO refetch, so the FAZ 1 60s
 * poll was removed. Previews of media messages show localized labels, never
 * the raw media reference; DM titles exclude the current user's own membership.
 */
const ChannelListPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, hasPermission } = useAuth();
  const myId = user?.id;
  const { t } = useI18n();
  const { data: channels, isLoading, isError } = useChannels();
  useMessagingSocket();
  // FE-MEDIUM-065: the AI entry point is shown only to users holding the
  // surface capability; the persona choice itself is server-filtered.
  const canUseAi = hasPermission('ai_assistant:use');

  return (
    <div className="sd-page max-w-[520px]">
      <div className="sd-pagehead">
        <span className="sd-eyebrow">{t('messaging.overview')}</span>
        <h1 className="sd-page-title">{t('messaging.title')}</h1>
        <span className="sd-page-sub">{t('messaging.subtitle')}</span>
      </div>

      {canUseAi && (
        <button
          onClick={() => navigate('/messaging/new-ai')}
          className="sd-send mb-3 inline-flex items-center gap-2 px-3.5 py-2"
        >
          <Sparkles size={15} /> {t('messaging.ai.newChat')}
        </button>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-[13.5px] text-sd-ink-muted">
          <RefreshCw size={15} className="animate-spin" /> {t('messaging.loadingChannels')}
        </div>
      )}
      {isError && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={17} className="text-sd-danger" />
          <span className="text-[13.5px] font-semibold text-sd-danger-ink">
            {t('messaging.errorChannels')}
          </span>
        </div>
      )}

      {!isLoading && !isError && (channels?.length ?? 0) === 0 && (
        <div className="sd-card">
          <div className="sd-empty">{t('messaging.noChannels')}</div>
        </div>
      )}

      {(channels?.length ?? 0) > 0 && (
        <div className="sd-card sd-card--flush">
          <div className="border-b border-sd-rule px-4 py-3">
            <span className="text-[11.5px] font-bold uppercase tracking-[0.09em] text-sd-teal-deep">
              {t('messaging.channelsLabel')}
            </span>
          </div>
          {channels?.map((channel) => {
            const active = location.pathname === `/messaging/${channel.id}`;
            return (
              <button
                key={channel.id}
                onClick={() => navigate(`/messaging/${channel.id}`)}
                className={`sd-chan-row${active ? ' sd-chan-row--active' : ''}`}
              >
                <span className={`sd-chan-icon${channel.type === 'AI' ? ' sd-chan-icon--ai' : ''}`}>
                  <ChannelIcon channel={channel} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="sd-chan-title">{channelTitle(channel, myId)}</span>
                    {!!channel.unreadCount && channel.unreadCount > 0 && (
                      <span className="sd-unread">{channel.unreadCount}</span>
                    )}
                  </span>
                  <span className="sd-chan-preview mt-0.5 block">
                    {lastMessagePreview(channel, t)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChannelListPage;
