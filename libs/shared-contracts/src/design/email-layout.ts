/**
 * One HTML e-mail layout, painted from the design tokens (FE-MEDIUM-093).
 *
 * WHY: three services each hand-built the same 600-pixel card — notification
 * (6 templates), admin-api (6) and alert-engine — with their own `<style>`
 * block and their own palette. The brand blue was `#0066cc` in one and
 * `#3B82F6` in another, danger `#dc3545` beside `#DC2626`, the footer grey
 * `#666` beside `#6b7280`. These are the surfaces a customer sees first: the
 * invitation, the password reset, the alert that wakes someone at night.
 *
 * This module owns the shell — doctype, head, the inlined stylesheet, the
 * header band, the content well and the footer — and the blocks the templates
 * compose it from. A caller supplies text and structure; the colours come from
 * `colors`, so an e-mail cannot drift from the product. Every interpolated
 * value is escaped here, not at the call site.
 *
 * Inlined, not linked: mail clients drop external stylesheets, and many strip
 * `<style>` too, so each block also carries the few properties it cannot live
 * without as a `style` attribute.
 */
import { colors } from './color-tokens';

/**
 * The accent band at the top of the card and the colour its buttons take.
 *
 * The five product tones plus the two the severity ladder needs: `accent` is
 * the hue between warning and error (FE-HIGH-085 maps a HIGH severity onto it),
 * and `neutral` is the band an informational notice takes.
 */
export type EmailTone = 'brand' | 'success' | 'warning' | 'error' | 'info' | 'accent' | 'neutral';

const TONE_COLOR: Readonly<Record<EmailTone, string>> = {
  brand: colors.primary[500],
  success: colors.success[600],
  warning: colors.warning[500],
  error: colors.error[600],
  info: colors.info[600],
  accent: colors.accent[600],
  neutral: colors.neutral[700],
};

/**
 * An accent chosen when the message is sent rather than when it is written.
 *
 * A stored template is one string for every severity, so its band cannot be
 * painted at build time. The document then emits a rule per case and the header
 * carries `header-{{variable}}`, which the service's own substitution turns into
 * the matching class: one template paints a critical alert red and an
 * informational one grey. The band takes its colour from the stylesheet in this
 * mode, so a client that strips `<style>` shows it unpainted — the price of one
 * template instead of one per severity, and what these templates already did.
 */
export interface EmailToneByVariable {
  /** The placeholder the sending service substitutes, written without braces. */
  variable: string;
  /** Substituted value → tone. Each key becomes a `header-<key>` rule. */
  cases: Readonly<Record<string, EmailTone>>;
  /** The tone the band keeps when the variable matches no case. */
  fallback: EmailTone;
}

function isToneByVariable(tone: EmailTone | EmailToneByVariable): tone is EmailToneByVariable {
  return typeof tone !== 'string';
}

const HTML_ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for an HTML body or attribute. Every block below runs its inputs through it. */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}

/**
 * Escapes a URL for an `href`: only http(s) and mailto survive, so a template
 * cannot be talked into emitting `javascript:` by a value from the database.
 */
export function safeHref(url: string): string {
  const trimmed = url.trim();
  // A seeded template's href is a `{{placeholder}}` the renderer substitutes at
  // send time, after its own escaping; a bare placeholder is the one non-URL
  // this accepts, and only when it is the whole value.
  if (/^\{\{\s*[a-z_][a-z0-9_]*\s*\}\}$/i.test(trimmed)) return trimmed;
  if (!/^(https?:|mailto:)/i.test(trimmed)) return '#';
  return escapeHtml(encodeURI(trimmed));
}

export interface EmailRow {
  label: string;
  /** The value as text. Ignored when `items` is given. */
  value?: string;
  /** A bullet list instead of a single value — clinical signs, immediate actions. */
  items?: readonly string[];
  /** Draws the value in a tone's colour and bold: a severity, a confirmation state. */
  tone?: EmailTone;
  /** Bolds the value: a confirmed count, a report's subtotal. */
  strong?: boolean;
  /** The figure the reader opened the mail for: the amount due, the reading that tripped. */
  large?: boolean;
}

function rowValue(row: EmailRow): string {
  if (row.items !== undefined) {
    const points = row.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `<ul style="margin:0;padding-left:20px;">${points}</ul>`;
  }
  const text = escapeHtml(row.value);
  const bold = row.strong === true || row.large === true;
  const body = bold ? `<strong>${text}</strong>` : text;
  const large = row.large === true ? 'font-size:20px;' : '';
  return row.tone === undefined && large === ''
    ? body
    : `<span style="${large}${row.tone === undefined ? '' : `color:${TONE_COLOR[row.tone]};font-weight:600;`}">${body}</span>`;
}

/** A label/value list on a tinted panel — the "here is what happened" block. */
export function emailRows(rows: readonly EmailRow[]): string {
  const cells = rows
    .map(
      (row) =>
        `<tr>` +
        `<td style="padding:4px 0;font-weight:600;color:${colors.neutral[500]};font-size:13px;vertical-align:top;">${escapeHtml(row.label)}</td>` +
        `<td style="padding:4px 0 4px 16px;color:${colors.neutral[800]};font-size:14px;">${rowValue(row)}</td>` +
        `</tr>`,
    )
    .join('');
  return `<table role="presentation" class="info-box" cellpadding="0" cellspacing="0" style="width:100%;background-color:${colors.neutral[50]};border-radius:8px;padding:20px;margin:20px 0;">${cells}</table>`;
}

/** The single call to action. */
export function emailButton(label: string, url: string, tone: EmailTone = 'brand'): string {
  return (
    `<div class="button-container" style="text-align:center;margin:32px 0;">` +
    `<a href="${safeHref(url)}" class="button" style="display:inline-block;background-color:${TONE_COLOR[tone]};color:${colors.white};padding:16px 48px;text-decoration:none;border-radius:6px;font-size:16px;font-weight:600;">${escapeHtml(label)}</a>` +
    `</div>`
  );
}

/** A tinted note: the expiry warning, the "you can ignore this" aside. */
export function emailCallout(body: string, tone: EmailTone = 'warning'): string {
  const accent = TONE_COLOR[tone];
  return `<div class="callout" style="background-color:${colors.neutral[50]};border-left:4px solid ${accent};border-radius:6px;padding:12px 16px;margin:20px 0;font-size:14px;color:${colors.neutral[800]};">${body}</div>`;
}

/** A paragraph of body copy. `html` is already-escaped markup a template composed. */
export function emailParagraph(html: string): string {
  return `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${colors.neutral[800]};">${html}</p>`;
}

/** The URL under the button, for clients that swallow the link. */
export function emailLinkFallback(url: string, note: string): string {
  return `<p class="link-fallback" style="font-size:12px;color:${colors.neutral[500]};word-break:break-all;margin-top:16px;">${escapeHtml(note)}<br>${escapeHtml(url)}</p>`;
}

/** A titled group of rows — the regulatory report's Facility / Contact / Event blocks. */
export function emailSection(title: string, rows: readonly EmailRow[], extra = ''): string {
  return (
    `<div class="section" style="margin-bottom:24px;border-bottom:1px solid ${colors.neutral[200]};padding-bottom:16px;">` +
    `<div style="font-size:13px;font-weight:700;color:${colors.neutral[600]};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">${escapeHtml(title)}</div>` +
    emailRows(rows) +
    extra +
    `</div>`
  );
}

/** A short pill in the header band — "URGENT / HASTER". */
export function emailBadge(label: string): string {
  return `<div style="background-color:rgba(255,255,255,0.2);display:inline-block;padding:4px 12px;border-radius:4px;margin-bottom:8px;font-size:12px;font-weight:600;">${escapeHtml(label)}</div>`;
}

export interface EmailDocument {
  /** The `<title>` and the headline in the accent band. */
  title: string;
  /** The line under the headline. */
  subtitle?: string;
  /** The accent band's colour; also the default button colour. */
  tone?: EmailTone | EmailToneByVariable;
  /** The card's body: blocks from this module, already escaped. */
  body: string;
  /** The lines under the rule. The product name line is added for you. */
  footerLines?: readonly string[];
  /** The one-line summary a mail client shows beside the subject. */
  preheader?: string;
  /**
   * The name the footer signs off with. A stored template passes its own
   * placeholder here so the sign-off matches the name the rest of it uses.
   */
  productName?: string;
}

const PRODUCT_NAME = 'Aquaculture Platform';
const FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

interface ResolvedHeader {
  /** The band's colour, and the colour a `brand`-toned button takes. */
  accent: string;
  /** The `.header-<case>` rules a send-time tone needs; empty for a fixed tone. */
  rules: string;
  /** The header element's class list. */
  className: string;
  /** The header element's inline style. */
  style: string;
}

/**
 * A tone's colour, for a channel that is not this HTML document: a chat
 * attachment stripe, a push accent. Keeps those in step with the mail.
 */
export function emailToneColor(tone: EmailTone): string {
  return TONE_COLOR[tone];
}

const HEADER_BOX = `color:${colors.white};padding:32px;text-align:center;`;

function resolveHeader(tone: EmailTone | EmailToneByVariable): ResolvedHeader {
  if (isToneByVariable(tone)) {
    const rules = Object.entries(tone.cases)
      .map(
        ([value, caseTone]) =>
          `\n      .header-${value} { background-color: ${TONE_COLOR[caseTone]}; }`,
      )
      .join('');
    return {
      accent: TONE_COLOR[tone.fallback],
      rules,
      className: `header header-{{${tone.variable}}}`,
      // No inline background: it would beat the rule that carries the chosen tone.
      style: HEADER_BOX,
    };
  }
  const accent = TONE_COLOR[tone];
  return {
    accent,
    rules: '',
    className: 'header',
    style: `background-color:${accent};${HEADER_BOX}`,
  };
}

/**
 * Renders the shell around a composed body. Every service's e-mail is this
 * document; only the blocks inside differ.
 */
export function renderEmail(doc: EmailDocument): string {
  const header = resolveHeader(doc.tone ?? 'brand');
  const accent = header.accent;
  const footer = [
    ...(doc.footerLines ?? []),
    `This is an automated message from ${doc.productName ?? PRODUCT_NAME}.`,
  ]
    .map((line) => `<p style="margin:0 0 4px 0;">${escapeHtml(line)}</p>`)
    .join('');
  const preheader =
    doc.preheader === undefined
      ? ''
      : `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(doc.preheader)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(doc.title)}</title>
    <style>
      body { font-family: ${FONT_STACK}; margin: 0; padding: 0; background-color: ${colors.neutral[100]}; }
      .container { max-width: 600px; margin: 0 auto; background-color: ${colors.white}; }
      .header { background-color: ${accent}; color: ${colors.white}; padding: 32px; text-align: center; }${header.rules}
      .header h1 { margin: 0; font-size: 26px; }
      .header p { margin: 8px 0 0 0; opacity: 0.9; }
      .content { padding: 32px; color: ${colors.neutral[800]}; }
      .footer { padding: 24px 32px; font-size: 12px; color: ${colors.neutral[500]}; border-top: 1px solid ${colors.neutral[200]}; text-align: center; }
      a { color: ${colors.primary[600]}; }
    </style>
  </head>
  <body style="font-family:${FONT_STACK};margin:0;padding:0;background-color:${colors.neutral[100]};">
    ${preheader}
    <div class="container" style="max-width:600px;margin:0 auto;background-color:${colors.white};">
      <div class="${header.className}" style="${header.style}">
        <h1 style="margin:0;font-size:26px;">${escapeHtml(doc.title)}</h1>
        ${doc.subtitle === undefined ? '' : `<p style="margin:8px 0 0 0;opacity:0.9;">${escapeHtml(doc.subtitle)}</p>`}
      </div>
      <div class="content" style="padding:32px;color:${colors.neutral[800]};">
${doc.body}
      </div>
      <div class="footer" style="padding:24px 32px;font-size:12px;color:${colors.neutral[500]};border-top:1px solid ${colors.neutral[200]};text-align:center;">
        ${footer}
      </div>
    </div>
  </body>
</html>`;
}

/** The plain-text part: the same document with its markup removed. */
export function emailPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
