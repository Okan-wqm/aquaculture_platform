/**
 * CSRF Middleware — Double-submit cookie pattern
 *
 * On safe methods (GET, HEAD, OPTIONS): sets a csrf-token cookie with a random value.
 * On state-changing methods (POST, PUT, DELETE, PATCH): validates that the
 * x-csrf-token request header matches the csrf-token cookie.
 *
 * The cookie is NOT httpOnly so that client-side JavaScript can read it and
 * echo it back in the x-csrf-token header. SameSite=Strict prevents the browser
 * from sending the cookie on cross-origin requests.
 */

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();

    if (SAFE_METHODS.has(method)) {
      // Set (or refresh) the CSRF token cookie on safe requests
      const token = crypto.randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,   // JS must read this to echo it back
        sameSite: 'strict',
        secure: process.env['NODE_ENV'] === 'production',
        path: '/',
      });
      return next();
    }

    // State-changing method — validate double-submit
    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;
    const headerToken = req.headers[CSRF_HEADER_NAME] as string | undefined;

    if (!cookieToken || !headerToken) {
      this.logger.warn(`CSRF validation failed: missing token (method=${method}, path=${req.path})`);
      res.status(403).json({ error: 'CSRF token missing' });
      return;
    }

    // Timing-safe comparison to prevent timing attacks
    if (
      cookieToken.length !== headerToken.length ||
      !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
    ) {
      this.logger.warn(`CSRF validation failed: token mismatch (method=${method}, path=${req.path})`);
      res.status(403).json({ error: 'CSRF token mismatch' });
      return;
    }

    next();
  }
}
