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
 * Token entry. The token is validated against a protected endpoint BEFORE it is
 * stored, so a mistyped token never lingers in sessionStorage.
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
      setError('Token boş olamaz.');
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
        setError('Token reddedildi (401). ARIA_UI_TOKEN değerini kontrol edin.');
      } else if (isApiClientError(failure)) {
        setError(`Sunucu hatası: ${failure.status} ${failure.payload.error}`);
      } else {
        setError(`Sunucuya ulaşılamadı: ${failure.message}`);
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
        <h1 id="login-title">ARIA Operatör Konsolu</h1>
        <p className="muted">
          Bu konsol ARIA çekirdeğinin ledger'larını salt-okunur yansıtır. Erişim için sunucudaki{' '}
          <code>ARIA_UI_TOKEN</code> değerini girin. Token yalnızca bu sekmenin oturum belleğinde tutulur.
        </p>
        <label className="field" htmlFor="token">
          <span>Operatör tokenı</span>
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
          {busy ? 'Doğrulanıyor…' : 'Giriş'}
        </button>
        <footer className="login__health">
          {health.state.status === 'success' ? (
            <>
              <Badge tone="success">{health.state.data.status}</Badge>
              <span className="mono">
                {health.state.data.service} v{health.state.data.version}
              </span>
              <Badge tone={health.state.data.toolsDirPresent ? 'success' : 'danger'}>
                tools dir: {health.state.data.toolsDirPresent ? 'present' : 'missing'}
              </Badge>
              <Badge tone={health.state.data.actionsEnabled ? 'warning' : 'muted'}>
                actions: {health.state.data.actionsEnabled ? 'enabled' : 'disabled'}
              </Badge>
            </>
          ) : health.state.status === 'error' ? (
            <span className="muted">Sağlık ucu yanıt vermedi: {health.state.error.message}</span>
          ) : (
            <span className="muted">Sağlık durumu sorgulanıyor…</span>
          )}
        </footer>
      </form>
    </main>
  );
}
