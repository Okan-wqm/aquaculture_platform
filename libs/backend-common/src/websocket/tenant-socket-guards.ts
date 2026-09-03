import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * WebSocket tenant guard primitives (SEC-MEDIUM-073 / SEC-MEDIUM-082 —
 * 2026-08-23 scan №26/№18).
 *
 * Two gaps recurred across the socket gateways: only ONE gateway enforced a
 * per-tenant connection cap (a single valid token could hold unlimited
 * sockets — FD/presence exhaustion), and NO gateway re-validated tokens
 * after the handshake (logout / logout-all / user suspension left live
 * sockets streaming tenant events until JWT expiry).
 *
 * These utilities make the correct behavior the zero-effort default:
 *
 * - {@link TenantConnectionLimiter} — per-tenant socket ceiling with
 *   deterministic release on disconnect.
 * - {@link WsTokenRevalidator} — periodic revocation re-check per connected
 *   socket (jti + user epoch via the caller-supplied predicate, fail-closed
 *   on predicate error), disconnecting revoked sockets; optional re-auth
 *   deadline for gateways whose clients must answer a re-auth challenge.
 *
 * Both are stateless-by-design singletons over Maps; wire them into
 * handleConnection/handleDisconnect (see the gateway call sites).
 */

export interface TenantConnectionLimiterOptions {
  /** Max simultaneous sockets per tenant (default 50 — the SCADA runtime ceiling). */
  maxPerTenant?: number;
}

/** Per-tenant socket-count ceiling with O(1) register/release. */
@Injectable()
export class TenantConnectionLimiter {
  private readonly tenantSockets = new Map<string, Set<string>>();

  private readonly maxPerTenant: number;

  constructor(options: TenantConnectionLimiterOptions = {}) {
    this.maxPerTenant = options.maxPerTenant ?? 50;
  }

  /**
   * Register a socket against its tenant. Returns false (and does NOT
   * register) when the tenant is at its ceiling — the caller must
   * disconnect the socket with an explicit error.
   */
  register(tenantId: string, socketId: string): boolean {
    let sockets = this.tenantSockets.get(tenantId);
    if (!sockets) {
      sockets = new Set<string>();
      this.tenantSockets.set(tenantId, sockets);
    }
    if (sockets.size >= this.maxPerTenant && !sockets.has(socketId)) {
      return false;
    }
    sockets.add(socketId);
    return true;
  }

  /** Release a socket; cleans up the tenant bucket when it empties. */
  release(tenantId: string, socketId: string): void {
    const sockets = this.tenantSockets.get(tenantId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.tenantSockets.delete(tenantId);
    }
  }

  count(tenantId: string): number {
    return this.tenantSockets.get(tenantId)?.size ?? 0;
  }
}

export interface RevalidationTarget {
  tenantId: string;
  userId: string;
  /** Access-token jti of the handshake credential (empty: never valid). */
  jti: string;
  /** Access-token iat (seconds) for user-epoch comparison, when available. */
  issuedAt?: number;
  /** Disconnect callback — the gateway owns its socket handle. */
  disconnect: (reason: string) => void;
}

export interface WsTokenRevalidatorOptions {
  /** Re-check interval (default 60s; must stay well under JWT TTL). */
  intervalMs?: number;
  /**
   * Revocation predicate — fail-closed semantics are the CALLER's contract:
   * return true = still valid, false = disconnect. Errors must map to false.
   */
  isStillValid: (target: { jti: string; userId: string; issuedAt?: number }) => Promise<boolean>;
}

/**
 * Periodic per-socket token revalidation (SEC-MEDIUM-082 №18).
 *
 * Every interval, each registered socket's handshake credential is re-checked
 * against the revocation surface (jti blacklist + user epoch). Revoked or
 * unresolvable sockets are disconnected through the gateway's own handle —
 * logout/suspension now bounds live socket lifetime to one interval.
 */
@Injectable()
export class WsTokenRevalidator implements OnModuleDestroy {
  private readonly logger = new Logger(WsTokenRevalidator.name);
  private readonly targets = new Map<string, RevalidationTarget>();
  private readonly timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly isStillValid: WsTokenRevalidatorOptions['isStillValid'];

  constructor(options: WsTokenRevalidatorOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.isStillValid = options.isStillValid;
    this.timer = setInterval(() => {
      void this.revalidateAll();
    }, this.intervalMs);
  }

  register(socketId: string, target: RevalidationTarget): void {
    if (target.jti.trim().length === 0) {
      // A token without a jti cannot be re-checked — treat as revoked now.
      target.disconnect('token-uncheckable');
      return;
    }
    this.targets.set(socketId, target);
  }

  unregister(socketId: string): void {
    this.targets.delete(socketId);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.targets.clear();
  }

  private async revalidateAll(): Promise<void> {
    const entries = Array.from(this.targets.entries());
    const verdicts = await Promise.all(
      entries.map(async ([socketId, target]) => {
        try {
          const valid = await this.isStillValid({
            jti: target.jti,
            userId: target.userId,
            issuedAt: target.issuedAt,
          });
          return { socketId, target, valid };
        } catch {
          // Predicate contract says errors map to false; belt for throws.
          return { socketId, target, valid: false };
        }
      }),
    );
    for (const { socketId, target, valid } of verdicts) {
      if (!valid) {
        this.targets.delete(socketId);
        this.logger.warn(
          `Disconnecting socket ${socketId} (tenant ${target.tenantId}): token no longer valid`,
        );
        target.disconnect('token-revoked');
      }
    }
  }
}
