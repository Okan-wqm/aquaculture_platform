import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import type { AuthState } from '@/types';

interface AuthContextValue extends AuthState {
  isLoading: boolean;
  isMobileDisabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = 'aquamobil_auth';

// GraphQL login mutation - use LoginInput and firstName + lastName
const LOGIN_MUTATION = `
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      accessToken
      refreshToken
      user {
        id
        email
        firstName
        lastName
        role
        tenantId
      }
    }
  }
`;

const REFRESH_MUTATION = `
  mutation RefreshToken($refreshToken: String!) {
    refreshToken(token: $refreshToken) {
      accessToken
      refreshToken
    }
  }
`;

const MOBILE_SETTINGS_QUERY = `
  query GetMyMobileSettings {
    getMyMobileSettings {
      isMobileEnabled
    }
  }
`;

async function checkMobileEnabled(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: MOBILE_SETTINGS_QUERY }),
    });
    const result = await response.json();
    return result.data?.getMyMobileSettings?.isMobileEnabled ?? true;
  } catch {
    // If we can't check, allow access (graceful degradation)
    return true;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    accessToken: null,
    refreshToken: null,
    tenantId: null,
    isAuthenticated: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isMobileDisabled, setIsMobileDisabled] = useState(false);

  // Load stored auth on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setState({
          ...parsed,
          isAuthenticated: !!parsed.accessToken,
        });
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setIsLoading(false);
  }, []);

  // Persist auth state changes
  useEffect(() => {
    if (state.isAuthenticated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }, [state]);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    setIsMobileDisabled(false);
    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: LOGIN_MUTATION,
          variables: { input: { email, password } },
        }),
      });

      const result = await response.json();

      if (result.errors) {
        throw new Error(result.errors[0]?.message || 'Login failed');
      }

      const { accessToken, refreshToken, user } = result.data.login;

      // Check if user has mobile access enabled
      const mobileEnabled = await checkMobileEnabled(accessToken);
      if (!mobileEnabled) {
        setIsMobileDisabled(true);
        throw new Error('Mobile access is not enabled for your account. Please contact your administrator.');
      }

      // Build display name from firstName + lastName
      const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];

      setState({
        user: {
          ...user,
          name: displayName,
        },
        accessToken,
        refreshToken,
        tenantId: user.tenantId,
        isAuthenticated: true,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      tenantId: null,
      isAuthenticated: false,
    });
    setIsMobileDisabled(false);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const refreshAuth = useCallback(async () => {
    if (!state.refreshToken) return;

    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: REFRESH_MUTATION,
          variables: { refreshToken: state.refreshToken },
        }),
      });

      const result = await response.json();

      if (result.errors) {
        logout();
        return;
      }

      const { accessToken, refreshToken } = result.data.refreshToken;

      setState((prev) => ({
        ...prev,
        accessToken,
        refreshToken,
      }));
    } catch {
      logout();
    }
  }, [state.refreshToken, logout]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        isLoading,
        isMobileDisabled,
        login,
        logout,
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
