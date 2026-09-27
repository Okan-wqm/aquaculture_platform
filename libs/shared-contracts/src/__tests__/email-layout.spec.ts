/**
 * The e-mail layout's contract (FE-MEDIUM-093).
 *
 * Three properties carry the whole change: the document paints from the design
 * tokens, every interpolated value is escaped before it reaches markup, and a
 * stored template can pick its accent at send time. Each is tested here rather
 * than through a service, because all five senders now share this one module.
 */
import { colors } from '../design/color-tokens';
import {
  emailButton,
  emailCallout,
  emailLinkFallback,
  emailParagraph,
  emailPlainText,
  emailRows,
  emailSection,
  emailToneColor,
  escapeHtml,
  renderEmail,
  safeHref,
} from '../design/email-layout';

describe('email layout', () => {
  describe('the document', () => {
    it('paints the band and the shell from the design tokens', () => {
      const html = renderEmail({ title: 'Welcome', tone: 'brand', body: '' });

      expect(html).toContain(`background-color: ${colors.primary[500]}`);
      expect(html).toContain(`background-color: ${colors.neutral[100]}`);
      expect(html).toContain(`background-color:${colors.white}`);
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('escapes the title, the subtitle and the footer', () => {
      const html = renderEmail({
        title: 'Tank <A> & "B"',
        subtitle: "O'Brien",
        body: '',
        footerLines: ['<script>alert(1)</script>'],
      });

      expect(html).toContain('Tank &lt;A&gt; &amp; &quot;B&quot;');
      expect(html).toContain('O&#39;Brien');
      expect(html).not.toContain('<script>');
    });

    it('signs off with the product, or with the name a stored template uses', () => {
      expect(renderEmail({ title: 'x', body: '' })).toContain(
        'This is an automated message from Aquaculture Platform.',
      );
      expect(renderEmail({ title: 'x', body: '', productName: '{{platform_name}}' })).toContain(
        'This is an automated message from {{platform_name}}.',
      );
    });

    it('hides the preheader from the body while the client reads it', () => {
      const html = renderEmail({ title: 'x', body: '', preheader: 'Two tanks are alarming' });

      expect(html).toContain('display:none');
      expect(html).toContain('Two tanks are alarming');
    });
  });

  describe('a tone chosen at send time', () => {
    const html = renderEmail({
      title: '{{severity}} Alert',
      body: '',
      tone: {
        variable: 'severity_class',
        cases: { critical: 'error', warning: 'warning', info: 'info' },
        fallback: 'neutral',
      },
    });

    it('carries the placeholder in the header class', () => {
      expect(html).toContain('class="header header-{{severity_class}}"');
    });

    it('emits one rule per case, from the tokens', () => {
      expect(html).toContain(`.header-critical { background-color: ${colors.error[600]}; }`);
      expect(html).toContain(`.header-warning { background-color: ${colors.warning[500]}; }`);
      expect(html).toContain(`.header-info { background-color: ${colors.info[600]}; }`);
    });

    it('keeps the fallback on .header and writes no inline background', () => {
      expect(html).toContain(`.header { background-color: ${colors.neutral[700]}`);
      // An inline background would beat the class that carries the chosen tone.
      expect(html).toMatch(/class="header header-\{\{severity_class\}\}" style="color:[^"]*"/);
      expect(html).not.toMatch(
        /class="header header-\{\{severity_class\}\}" style="background-color/,
      );
    });

    it('paints a fixed tone inline, so a client that strips <style> still shows it', () => {
      const fixed = renderEmail({ title: 'x', body: '', tone: 'error' });

      expect(fixed).toContain(`<div class="header" style="background-color:${colors.error[600]}`);
    });
  });

  describe('the blocks', () => {
    it('escapes a row label and value', () => {
      const html = emailRows([{ label: 'Rule <b>', value: '<img src=x>' }]);

      expect(html).toContain('Rule &lt;b&gt;');
      expect(html).toContain('&lt;img src=x&gt;');
      expect(html).not.toContain('<img');
    });

    it('draws a toned row in that tone and a large row larger', () => {
      expect(emailRows([{ label: 'State', value: 'TRIPPED', tone: 'error' }])).toContain(
        `color:${colors.error[600]}`,
      );
      const large = emailRows([{ label: 'Amount Due', value: '$40', large: true }]);
      expect(large).toContain('font-size:20px;');
      expect(large).toContain('<strong>$40</strong>');
    });

    it('renders items as a list', () => {
      expect(emailRows([{ label: 'Actions', items: ['Isolate', 'Call vet'] }])).toContain(
        '<li>Isolate</li><li>Call vet</li>',
      );
    });

    it('titles a section and keeps the caller-composed extra', () => {
      const html = emailSection('Facility', [{ label: 'Site', value: 'Bay 2' }], '<p>note</p>');

      expect(html).toContain('Facility');
      expect(html).toContain('<p>note</p>');
    });

    it('paints the button and the callout from the tokens', () => {
      expect(emailButton('Pay Now', 'https://example.test/pay')).toContain(
        `background-color:${colors.primary[500]}`,
      );
      expect(emailButton('Reset', 'https://example.test/r', 'error')).toContain(
        `background-color:${colors.error[600]}`,
      );
      expect(emailCallout('careful')).toContain(`solid ${colors.warning[500]}`);
      expect(emailParagraph('hello')).toContain(`color:${colors.neutral[800]}`);
      expect(emailLinkFallback('https://example.test/r', 'Copy this:')).toContain('Copy this:');
    });

    it('gives every tone a colour', () => {
      for (const tone of [
        'brand',
        'success',
        'warning',
        'error',
        'info',
        'accent',
        'neutral',
      ] as const) {
        expect(emailToneColor(tone)).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
  });

  describe('safeHref', () => {
    it('keeps http, https and mailto', () => {
      expect(safeHref('https://example.test/a b')).toBe('https://example.test/a%20b');
      expect(safeHref('mailto:ops@example.test')).toBe('mailto:ops@example.test');
    });

    it('refuses anything a template could be talked into emitting', () => {
      expect(safeHref('javascript:alert(1)')).toBe('#');
      expect(safeHref('  JaVaScRiPt:alert(1)')).toBe('#');
      expect(safeHref('data:text/html;base64,x')).toBe('#');
    });

    it('accepts a whole-value placeholder, which the renderer substitutes later', () => {
      expect(safeHref('{{reset_link}}')).toBe('{{reset_link}}');
      expect(safeHref('{{ reset_link }}')).toBe('{{ reset_link }}');
      // Not a bare placeholder: the rest of the value is not a URL.
      expect(safeHref('javascript:{{x}}')).toBe('#');
    });

    it('escapes the quote that would break out of the attribute', () => {
      expect(safeHref('https://example.test/?a="b"')).not.toContain('"');
    });
  });

  describe('escapeHtml and the plain-text part', () => {
    it('escapes the five characters and passes a number through', () => {
      expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
      expect(escapeHtml(7)).toBe('7');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });

    it('drops the stylesheet, the scripts and the markup', () => {
      const text = emailPlainText(
        renderEmail({ title: 'Invoice', body: emailParagraph('Amount due: 40') }),
      );

      expect(text).toContain('Invoice');
      expect(text).toContain('Amount due: 40');
      expect(text).not.toContain('background-color');
      expect(text).not.toContain('<');
      expect(emailPlainText('<script>alert(1)</script>ok')).toBe('ok');
    });
  });
});
