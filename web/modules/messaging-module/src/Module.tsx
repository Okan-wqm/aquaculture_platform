/**
 * Messaging Module Root — panel messaging remote.
 *
 * Layout is the shell's MainLayout; this only defines the page routes mounted
 * under /messaging/*. A module-level auth guard is defense-in-depth: in Module
 * Federation the remote bundle can be instantiated independently of the shell's
 * route guard, so the session is re-checked here.
 *
 * The session check and the page loading are the shared gate (RequireAuth)
 * and the one loading screen (BrandLoader, FE-MEDIUM-349), not copies.
 */
import { BrandLoader, RequireAuth } from '@aquaculture/shared-ui';
import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

const ChannelListPage = React.lazy(() => import('./pages/ChannelListPage'));
const ChatRoomPage = React.lazy(() => import('./pages/ChatRoomPage'));
const NewAiChatPage = React.lazy(() => import('./pages/NewAiChatPage'));

const MessagingModule: React.FC = () => {
  return (
    <RequireAuth>
      <Suspense fallback={<BrandLoader />}>
        <Routes>
          <Route path="/" element={<ChannelListPage />} />
          <Route path="/new-ai" element={<NewAiChatPage />} />
          <Route path="/:channelId" element={<ChatRoomPage />} />
          <Route path="*" element={<Navigate to="/messaging" replace />} />
        </Routes>
      </Suspense>
    </RequireAuth>
  );
};

export default MessagingModule;
