import { gql } from 'graphql-tag';

export const UPDATE_MY_PROFILE = gql`
  mutation UpdateMyProfile($input: UpdateMyProfileInput!) {
    updateMyProfile(input: $input) {
      id
      email
      firstName
      lastName
    }
  }
`;

export const CHANGE_MY_PASSWORD = gql`
  mutation ChangeMyPassword($input: ChangeMyPasswordInput!) {
    changeMyPassword(input: $input) {
      success
      message
    }
  }
`;

export const MY_SECURITY_SETTINGS = gql`
  query MySecuritySettings {
    mySecuritySettings {
      mfaEnabled
      mfaAvailable
      mfaUnavailableReason
    }
  }
`;

export const SETUP_MFA = gql`
  mutation SetupMfa {
    setupMfa {
      secret
      qrCodeUri
      recoveryCodes
    }
  }
`;

export const VERIFY_MFA_SETUP = gql`
  mutation VerifyMfaSetup($input: VerifyMfaSetupInput!) {
    verifyMfaSetup(input: $input) {
      success
      message
    }
  }
`;

export const DISABLE_MFA = gql`
  mutation DisableMfa($input: DisableMfaInput!) {
    disableMfa(input: $input) {
      success
      message
    }
  }
`;

export const REGENERATE_MFA_RECOVERY_CODES = gql`
  mutation RegenerateMfaRecoveryCodes($code: String!) {
    regenerateMfaRecoveryCodes(code: $code) {
      recoveryCodes
    }
  }
`;

export const MY_WEBAUTHN_CREDENTIALS = gql`
  query MyWebAuthnCredentials {
    myWebAuthnCredentials {
      credentialId
      deviceName
      createdAt
      lastUsedAt
    }
  }
`;

export const REMOVE_WEBAUTHN_CREDENTIAL = gql`
  mutation RemoveWebAuthnCredential($credentialId: String!) {
    removeWebAuthnCredential(credentialId: $credentialId) {
      success
      message
    }
  }
`;

export const GET_MY_NOTIFICATION_PREFERENCES = gql`
  query GetMyNotificationPreferences {
    getMyNotificationPreferences {
      emailEnabled
      smsEnabled
      pushEnabled
      quietHoursStart
      quietHoursEnd
      quietHoursTimezone
      alertNotifications
      taskNotifications
      systemNotifications
    }
  }
`;

export const UPDATE_MY_NOTIFICATION_PREFERENCES = gql`
  mutation UpdateMyNotificationPreferences($input: UpdateNotificationPreferencesInput!) {
    updateMyNotificationPreferences(input: $input) {
      emailEnabled
      smsEnabled
      pushEnabled
      quietHoursStart
      quietHoursEnd
      quietHoursTimezone
      alertNotifications
      taskNotifications
      systemNotifications
    }
  }
`;
