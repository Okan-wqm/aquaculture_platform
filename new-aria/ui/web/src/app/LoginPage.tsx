import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { validateToken } from '../api/client.ts';
import { isApiClientError, toError } from '../api/errors.ts';
import { setToken } from '../api/token-store.ts';
import { Badge } from '../design/Badge.tsx';
import { Callout } from '../design/Callout.tsx';
import { useHealth } from './HealthProvider.tsx';
import { useToken } from './RequireAuth.tsx';
import { ROUTES } from './routes.ts';
import './LoginPage.css';

interface LocationState {
  readonly from?: string;
}

function readFrom(state: unknown): string {
  if (typeof state === 'object' && state !== null && typeof (state as LocationState).from === 'string') {
    const from = (state as LocationState).from ?? ROUTES.overview;
    return from.startsWith('/') && !from.startsWith('//') ? from : ROUTES.overview;
  }
  return ROUTES.overview;
}

/**
 * Token entry.
 *
 * WHY: the token is validated against a protected endpoint BEFORE it is stored,
 * so a mistyped token never lingers in session storage and the operator learns
 * immediately whether the projection server accepted it.
 */
export function LoginPage(): ReactNode {
  const existing = useToken();
  const health = useHealth();
  const navigate = useNavigate();
  const location = useLocation();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (existing !== null) {
    return <Navigate to={readFrom(location.state)} replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const candidate = value.trim();
    if (candidate === '') {
      setError('Enter the operator token to continue.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await validateToken(candidate);
      setToken(candidate);
      navigate(readFrom(location.state), { replace: true });
    } catch (reason) {
      const failure = toError(reason);
      if (isApiClientError(failure) && failure.isUnauthorized) {
        setError('The server rejected this token (401). A token identifies one person; ask the operator for yours, or check ARIA_UI_TOKEN if you run the console.');
      } else if (isApiClientError(failure)) {
        setError(`The server answered ${failure.status} ${failure.payload.error}. The console cannot verify the token until that is resolved.`);
      } else {
        setError(`The projection server could not be reached: ${failure.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login" id="main">
      <form
        className="login__card"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        aria-labelledby="login-title"
      >
        <div className="login__brand">
          <span className="login__wordmark">ARIA</span>
          <h1 id="login-title">Operator console</h1>
        </div>
        <p className="login__intro">
          This console projects ARIA's ledgers read-only; sign in with the <code>ARIA_UI_TOKEN</code> configured on the
          projection server.
        </p>
        <label className="field" htmlFor="token">
          <span>Operator token</span>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
            required
          />
        </label>
        {error !== null ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Verifying…' : 'Sign in'}
        </button>
        <p className="login__note">The token is held in this browser tab only, and is discarded when the tab closes.</p>
        <footer className="login__health">
          {health.state.status === 'success' ? (
            <>
              <Badge tone="success">{health.state.data.status}</Badge>
              <span className="mono">
                {health.state.data.service} {health.state.data.version}
              </span>
              <Badge tone={health.state.data.toolsDirPresent ? 'success' : 'danger'}>
                tools dir: {health.state.data.toolsDirPresent ? 'present' : 'missing'}
              </Badge>
              <Badge tone={health.state.data.actionsEnabled ? 'warning' : 'muted'}>
                actions: {health.state.data.actionsEnabled ? 'enabled' : 'disabled'}
              </Badge>
            </>
          ) : health.state.status === 'error' ? (
            <span>The health endpoint did not answer: {health.state.error.message}</span>
          ) : (
            <span>Reading server health…</span>
          )}
        </footer>
      </form>
    </main>
  );
}
