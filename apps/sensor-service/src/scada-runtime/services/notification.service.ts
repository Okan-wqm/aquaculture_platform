/**
 * NotificationService
 *
 * Delivers alarm notifications over Email (SMTP via nodemailer) and
 * Webhook (HTTP POST via axios).
 *
 * Features:
 *   - Per-config severity filter (only notify on matching severities)
 *   - Configurable delay before first notification (delayMinutes)
 *   - Configurable repeat interval while alarm is active (repeatIntervalMinutes)
 *   - Rate-limiter: tracks last-sent timestamps to prevent spam
 *   - 'single' mode: only one notification per alarm activation
 *   - 'all' mode: notify on every new alarm of matching severity
 *
 * SMTP config (env):
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Design: no circular deps — this service receives plain AlarmInstance
 * objects and NotificationConfig arrays; it does not import the engine.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  AlarmInstance,
  NotificationConfig,
  AlarmSeverity,
} from '../../../../../../web/modules/sensor-module/src/types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Nodemailer / axios — loaded lazily to keep startup fast             */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodemailer = require('nodemailer') as typeof import('nodemailer');

import * as https from 'https';
import * as http from 'http';

/* ------------------------------------------------------------------ */
/*  Internal types                                                      */
/* ------------------------------------------------------------------ */

interface NotificationRecord {
  /** Unix ms of the first notification sent. */
  firstSentAt: number;
  /** Unix ms of the most-recent notification sent. */
  lastSentAt: number;
  /** Total notifications sent for this alarm instance. */
  count: number;
}

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * Rate-limit map: `${configId}:${alarmId}` → NotificationRecord.
   * Cleared when an alarm leaves the active set.
   */
  private readonly sentLog = new Map<string, NotificationRecord>();

  /** Nodemailer transporter (lazy-initialised). */
  private transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

  constructor(private readonly configService: ConfigService) {}

  /* ---------------------------------------------------------------- */
  /*  Public API                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Evaluate all notification configs against the given alarm and
   * send notifications where warranted.
   *
   * Called by AlarmEngineService on every alarm state change.
   */
  async processAlarm(
    alarm: AlarmInstance,
    configs: NotificationConfig[],
  ): Promise<void> {
    if (!configs || configs.length === 0) return;

    const now = Date.now();

    for (const config of configs) {
      if (!config.enabled) continue;

      try {
        await this.evaluateConfig(alarm, config, now);
      } catch (error) {
        this.logger.error(
          `processAlarm: notification delivery failed for config=${config.id} — ` +
            `${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Clear rate-limit records for a resolved alarm.
   * Call this when an alarm transitions to ACKNOWLEDGED or INACTIVE.
   */
  clearAlarmRecords(alarmId: string): void {
    for (const key of this.sentLog.keys()) {
      if (key.endsWith(`:${alarmId}`)) {
        this.sentLog.delete(key);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Internal evaluation                                               */
  /* ---------------------------------------------------------------- */

  private async evaluateConfig(
    alarm: AlarmInstance,
    config: NotificationConfig,
    now: number,
  ): Promise<void> {
    // Severity filter
    if (!this.matchesSeverity(alarm.severity, config.severities)) return;

    const key = `${config.id}:${alarm.id}`;
    const record = this.sentLog.get(key);
    const delayMs = config.delayMinutes * 60_000;
    const repeatMs = config.repeatIntervalMinutes * 60_000;

    // First notification?
    if (!record) {
      // Respect initial delay
      if (delayMs > 0) {
        // Store a "pending" record at the time the alarm first triggered
        this.sentLog.set(key, { firstSentAt: 0, lastSentAt: now, count: 0 });

        // Schedule the delayed send
        setTimeout(async () => {
          const current = this.sentLog.get(key);
          if (!current) return; // alarm resolved before delay elapsed
          await this.deliver(alarm, config);
          current.firstSentAt = Date.now();
          current.lastSentAt = Date.now();
          current.count = 1;
        }, delayMs);

        return;
      }

      // No delay — send immediately
      await this.deliver(alarm, config);
      this.sentLog.set(key, { firstSentAt: now, lastSentAt: now, count: 1 });
      return;
    }

    // Already sent at least once — respect 'single' mode
    if (config.mode === 'single') return;

    // 'all' mode — check repeat interval
    if (repeatMs <= 0) return; // no repeats configured

    const elapsed = now - record.lastSentAt;
    if (elapsed < repeatMs) return; // too soon

    // Send repeat notification
    await this.deliver(alarm, config);
    record.lastSentAt = now;
    record.count++;
  }

  private matchesSeverity(
    alarmSeverity: AlarmSeverity,
    configSeverities: AlarmSeverity[],
  ): boolean {
    return configSeverities.includes(alarmSeverity);
  }

  /* ---------------------------------------------------------------- */
  /*  Delivery                                                          */
  /* ---------------------------------------------------------------- */

  private async deliver(alarm: AlarmInstance, config: NotificationConfig): Promise<void> {
    if (config.channel === 'email') {
      await this.sendEmail(alarm, config.receiver);
    } else if (config.channel === 'webhook') {
      await this.sendWebhook(alarm, config.receiver);
    } else {
      this.logger.warn(`deliver: unknown channel '${(config as NotificationConfig).channel}'`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Email                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Send a free-form email directly.
   *
   * Used by the ScriptEngineService to deliver messages from server-side
   * scripts via the $sendMessage() sandbox function.
   */
  async sendDirectEmail(to: string, subject: string, body: string): Promise<void> {
    const transporter = this.getTransporter();
    if (!transporter) {
      this.logger.warn('sendDirectEmail: SMTP not configured — skipping');
      return;
    }

    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'SCADA Alarms <noreply@scada.local>';

    try {
      await transporter.sendMail({ from, to, subject, html: body });
      this.logger.log(`sendDirectEmail: delivered to=${to} subject="${subject}"`);
    } catch (error) {
      this.logger.error(
        `sendDirectEmail: delivery failed to=${to} — ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async sendEmail(alarm: AlarmInstance, recipient: string): Promise<void> {
    const transporter = this.getTransporter();
    if (!transporter) {
      this.logger.warn('sendEmail: SMTP not configured — skipping');
      return;
    }

    const subject = `[SCADA ALARM] ${alarm.severity.toUpperCase()} — ${alarm.ruleName}`;
    const onTimeStr = new Date(alarm.onTime).toISOString();

    const html = `
      <h2 style="color:${this.severityColor(alarm.severity)}">
        ${alarm.severity.toUpperCase()} Alarm: ${alarm.ruleName}
      </h2>
      <table style="border-collapse:collapse;font-family:monospace">
        <tr><td><b>Message</b></td><td>${alarm.message}</td></tr>
        <tr><td><b>Tag Value</b></td><td>${alarm.currentValue} (threshold: ${alarm.threshold})</td></tr>
        <tr><td><b>Status</b></td><td>${alarm.status}</td></tr>
        <tr><td><b>Group</b></td><td>${alarm.group ?? '—'}</td></tr>
        <tr><td><b>Activated</b></td><td>${onTimeStr}</td></tr>
        <tr><td><b>Alarm ID</b></td><td>${alarm.id}</td></tr>
      </table>
    `;

    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'SCADA Alarms <noreply@scada.local>';

    try {
      await transporter.sendMail({
        from,
        to: recipient,
        subject,
        html,
      });

      this.logger.log(
        `sendEmail: delivered alarm=${alarm.id} severity=${alarm.severity} to=${recipient}`,
      );
    } catch (error) {
      this.logger.error(
        `sendEmail: delivery failed to=${recipient} — ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private getTransporter(): ReturnType<typeof nodemailer.createTransport> | null {
    if (this.transporter) return this.transporter;

    const host = this.configService.get<string>('SMTP_HOST');
    if (!host) return null;

    const port = parseInt(this.configService.get<string>('SMTP_PORT', '587'), 10);
    const secure = this.configService.get<string>('SMTP_SECURE', 'false') === 'true';
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });

    return this.transporter;
  }

  /* ---------------------------------------------------------------- */
  /*  Webhook                                                           */
  /* ---------------------------------------------------------------- */

  private sendWebhook(alarm: AlarmInstance, webhookUrl: string): Promise<void> {
    const payload = JSON.stringify({
      event: 'scada.alarm',
      alarm: {
        id: alarm.id,
        ruleId: alarm.ruleId,
        ruleName: alarm.ruleName,
        severity: alarm.severity,
        status: alarm.status,
        message: alarm.message,
        group: alarm.group,
        currentValue: alarm.currentValue,
        threshold: alarm.threshold,
        onTime: alarm.onTime,
        offTime: alarm.offTime,
        ackTime: alarm.ackTime,
      },
      sentAt: new Date().toISOString(),
    });

    return new Promise<void>((resolve, reject) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(webhookUrl);
      } catch {
        reject(new Error(`sendWebhook: invalid URL: ${webhookUrl}`));
        return;
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'SCADA-AlarmEngine/1.0',
        },
      };

      const req = transport.request(options, (res) => {
        // Drain response body to avoid socket hang
        res.resume();
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
          this.logger.log(
            `sendWebhook: delivered alarm=${alarm.id} severity=${alarm.severity} url=${webhookUrl} status=${res.statusCode}`,
          );
          resolve();
        } else {
          reject(new Error(`sendWebhook: HTTP ${res.statusCode ?? 'unknown'}`));
        }
      });

      req.setTimeout(10_000, () => {
        req.destroy(new Error('sendWebhook: request timed out'));
      });

      req.on('error', (err) => {
        this.logger.error(`sendWebhook: delivery failed url=${webhookUrl} — ${err.message}`);
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                           */
  /* ---------------------------------------------------------------- */

  private severityColor(severity: AlarmSeverity): string {
    switch (severity) {
      case 'critical': return '#dc2626';
      case 'high':     return '#ea580c';
      case 'warning':  return '#ca8a04';
      case 'info':     return '#2563eb';
      default:         return '#6b7280';
    }
  }
}
