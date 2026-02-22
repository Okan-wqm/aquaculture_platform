/**
 * AI Service REST Routes (v2)
 *
 * Proxies REST requests to the AI service for chat and conversation endpoints.
 * Supports SSE streaming for real-time chat responses.
 */

import { Module, Controller, All, Req, Res, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import * as http from 'http';

@Controller('api/v2/ai')
export class AiRoutesController {
  private readonly logger = new Logger(AiRoutesController.name);
  private readonly aiServiceUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiServiceUrl = this.configService.get<string>(
      'AI_SERVICE_URL',
      'http://localhost:3008',
    );
  }

  @All('*')
  async proxy(@Req() req: Request, @Res() res: Response): Promise<void> {
    const targetUrl = `${this.aiServiceUrl}${req.originalUrl}`;
    this.logger.debug(`Proxying AI request to: ${targetUrl}`);

    const url = new URL(targetUrl);

    const proxyReq = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: url.host,
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      this.logger.error(`AI proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'AI service unavailable' });
      }
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  }
}

/**
 * AI Routes Module
 */
@Module({
  controllers: [AiRoutesController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AiRoutesModule {}
