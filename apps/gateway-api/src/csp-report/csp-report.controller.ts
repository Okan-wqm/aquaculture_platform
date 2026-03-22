/**
 * CSP Violation Report Controller
 *
 * Handles Content-Security-Policy violation reports sent by browsers.
 * Browsers automatically POST to the report-uri when a CSP directive is violated.
 *
 * - No authentication required (browsers send these automatically)
 * - Accepts application/csp-report and application/json content types
 * - Returns 204 No Content (browser expects no response body)
 * - Logs violations in structured JSON format for monitoring/alerting
 */

import { Controller, Post, Body, HttpCode, Req, Logger, Optional } from '@nestjs/common';
import { Request } from 'express';
import { SecurityEventService } from '@aquaculture/backend-common';

import { Public } from '../guards/auth.guard';

/**
 * CSP violation report shape as sent by browsers.
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP#violation_report_syntax
 */
interface CspViolationReport {
  'document-uri'?: string;
  referrer?: string;
  'violated-directive'?: string;
  'effective-directive'?: string;
  'original-policy'?: string;
  'blocked-uri'?: string;
  'status-code'?: number;
  'script-sample'?: string;
  disposition?: string;
  'source-file'?: string;
  'line-number'?: number;
  'column-number'?: number;
}

interface CspReportBody {
  'csp-report'?: CspViolationReport;
  // Reporting API v1 uses flat structure
  [key: string]: unknown;
}

@Controller('api')
@Public()
export class CspReportController {
  private readonly logger = new Logger(CspReportController.name);

  constructor(
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {}

  /**
   * Receive CSP violation reports from browsers.
   *
   * Browsers send POST requests with Content-Type: application/csp-report
   * when a CSP directive is violated. The Reporting API v1 uses
   * Content-Type: application/reports+json.
   *
   * We log the violation details in a structured format so they can be
   * picked up by log aggregation and monitoring tools.
   */
  @Post('csp-report')
  @HttpCode(204)
  cspReport(@Body() body: CspReportBody, @Req() req: Request): void {
    const report = body['csp-report'] ?? body;

    this.logger.warn('CSP Violation Report', {
      report: {
        documentUri: report['document-uri'],
        violatedDirective: report['violated-directive'],
        effectiveDirective: report['effective-directive'],
        blockedUri: report['blocked-uri'],
        disposition: report['disposition'],
        sourceFile: report['source-file'],
        lineNumber: report['line-number'],
        columnNumber: report['column-number'],
        statusCode: report['status-code'],
        referrer: report['referrer'],
      },
      clientIp: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Publish security event to NATS (best-effort, non-blocking)
    this.securityEventService?.publishCspViolation({
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
      documentUri: report['document-uri'] as string | undefined,
      violatedDirective: report['violated-directive'] as string | undefined,
      effectiveDirective: report['effective-directive'] as string | undefined,
      blockedUri: report['blocked-uri'] as string | undefined,
      disposition: report['disposition'] as string | undefined,
      sourceFile: report['source-file'] as string | undefined,
      lineNumber: report['line-number'] as number | undefined,
      columnNumber: report['column-number'] as number | undefined,
    }).catch(() => { /* best-effort */ });
  }
}
