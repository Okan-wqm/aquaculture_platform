import { useAuth, useI18n } from '@aquaculture/shared-ui';
import { MessageSquare, Sparkles, Users, RefreshCw, AlertCircle } from 'lucide-react';
import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { useChannels } from '../hooks/useMessagingData';
import { channelTitle } from '../lib/channelDisplay';
import type { Channel } from '../types/messaging';

function ChannelIcon({ channel }: { channel: Channel }): React.ReactElement {
  if (channel.type === 'AI') return <Sparkles size={19} />;
  if (channel.type === 'GROUP') return <Users size={19} />;
  return <MessageSquare size={19} />;
}

/**
 * Channel list — SUDERRA Tenant Console design (mockup "Messages" left card).
 * The selected channel highlights with the mint edge + tint exactly like the
 * mockup; selection is derived from the route so deep links highlight too.
 *
 * DATA SOURCE: 100% real — messaging-service `myChannels`. unreadCount is
 * computed per-user server-side (Redis-cached); lastMessage rides the same
 * query. No mocked data on this page.
 *
 * FAZ 1: a 60s foreground refetchInterval (in useChannels) keeps previews +
 * unread badges alive while the socket joins only the active channel; DM
 * titles exclude the current user's own membership.
 */
const ChannelListPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const myId = user?.id;
  const { t } = useI18n();
  const { data: channels, isLoading, isError } = useChannels();

  return (
    <div className="sd-page" style={{ maxWidth: 520 }}>
      <div className="sd-pagehead">
        <span className="sd-eyebrow">{t('messaging.overview')}</span>
        <h1 className="sd-page-title">{t('messaging.title')}</h1>
        <span className="sd-page-sub">{t('messaging.subtitle')}</span>
      </div>

      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: '#5c7783',
            fontSize: 13.5,
          }}
        >
          <RefreshCw size={15} className="animate-spin" /> {t('messaging.loadingChannels')}
        </div>
      )}
      {isError && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={17} style={{ color: '#b04a28' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
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
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(10,31,43,.09)' }}>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: '#0b4f60',
              }}
            >
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
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span className="sd-chan-title">{channelTitle(channel, myId)}</span>
                    {!!channel.unreadCount && channel.unreadCount > 0 && (
                      <span className="sd-unread">{channel.unreadCount}</span>
                    )}
                  </span>
                  <span className="sd-chan-preview" style={{ display: 'block', marginTop: 2 }}>
                    {channel.lastMessage?.content ?? t('messaging.noMessagesPreview')}
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
