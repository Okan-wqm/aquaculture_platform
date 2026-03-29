export { useAuth, AuthProvider } from './useAuth';
export { useDarkMode } from './useDarkMode';
export type { DarkModePreference, UseDarkModeReturn } from './useDarkMode';
export { useOfflineQueue, OfflineProvider } from './useOfflineQueue';
export { useNetworkStatus } from './useNetworkStatus';
export { useTanks } from './useTanks';
export { useWebAuthn, isWebAuthnSupported, hasLocalCredentials } from './useWebAuthn';
export { useAiDashboardInsights, useTankRiskAssessment, useBatchGrowthPrediction, useFeedingAdvice } from './useAiInsights';

// Messaging hooks (ADR-012)
export { useChannels } from './useChannels';
export { useMessages } from './useMessages';
export { useMessageSocket } from './useMessageSocket';
export { useSendMessage } from './useSendMessage';
export { useTypingIndicator } from './useTypingIndicator';
export { useChannelMembers } from './useChannelMembers';
export { useChannelDetail } from './useChannelDetail';
export { useChannelActions } from './useChannelActions';
export { useCreateChannel } from './useCreateChannel';
export { useTenantUsers } from './useTenantUsers';
export { useUnreadCount } from './useUnreadCount';
export { useMediaUpload } from './useMediaUpload';
export { useAiChat } from './useAiChat';
export { useAiConsent } from './useAiConsent';
