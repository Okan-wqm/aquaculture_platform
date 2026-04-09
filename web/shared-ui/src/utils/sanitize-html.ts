/**
 * HTML Sanitization Utility
 *
 * SECURITY: FE-HIGH-031 — SCADA widget custom HTML rendering uses
 * dangerouslySetInnerHTML without sanitization. This module provides
 * a strict HTML sanitizer that removes all script execution vectors.
 *
 * Uses the browser's built-in DOMParser for sanitization — no external
 * dependency needed. This is a defense-in-depth layer; the CSP meta tag
 * also restricts inline script execution.
 *
 * @see FE-HIGH-031
 */

// ============================================================================
// Allowed Tags & Attributes
// ============================================================================

/** Tags allowed in custom widget HTML */
const ALLOWED_TAGS = new Set([
  // Block
  'div', 'span', 'p', 'br', 'hr',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Lists
  'ul', 'ol', 'li',
  // Inline
  'strong', 'em', 'b', 'i', 'u', 'sub', 'sup', 'small', 'mark',
  // Table
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  // Media (no script)
  'img',
  // Semantic
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
  'figure', 'figcaption', 'details', 'summary',
]);

/** Attributes allowed on any element */
const ALLOWED_ATTRIBUTES = new Set([
  'class', 'id', 'style',
  'title', 'lang', 'dir',
  'role', 'aria-label', 'aria-labelledby', 'aria-describedby',
  'aria-hidden', 'aria-live', 'aria-atomic',
  'data-testid', 'data-widget-id',
]);

/** Tag-specific allowed attributes */
const TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

/** URL schemes allowed in src attributes */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'data:']);

// ============================================================================
// Sanitizer
// ============================================================================

/**
 * Sanitize HTML string by removing dangerous elements and attributes.
 *
 * @param dirty - The untrusted HTML string
 * @returns Sanitized HTML safe for dangerouslySetInnerHTML
 *
 * @example
 * sanitizeHtml('<div onclick="alert(1)">Hello</div>')
 * // => '<div>Hello</div>'
 *
 * sanitizeHtml('<script>evil()</script><p>Safe</p>')
 * // => '<p>Safe</p>'
 */
export function sanitizeHtml(dirty: string): string {
  if (!dirty || typeof dirty !== 'string') return '';

  // Parse into a DOM tree using the browser's built-in parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(dirty, 'text/html');
  const body = doc.body;

  if (!body) return '';

  // Walk the tree and sanitize in-place
  sanitizeNode(body);

  return body.innerHTML;
}

/**
 * Recursively sanitize a DOM node and its children.
 */
function sanitizeNode(node: Node): void {
  // Process children in reverse order so removals don't shift indices
  const children = Array.from(node.childNodes);

  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as Element;
      const tagName = element.tagName.toLowerCase();

      // Remove disallowed tags entirely
      if (!ALLOWED_TAGS.has(tagName)) {
        node.removeChild(child);
        continue;
      }

      // Remove disallowed attributes
      const attrs = Array.from(element.attributes);
      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();

        // SECURITY: Remove all event handler attributes (onclick, onerror, etc.)
        if (attrName.startsWith('on')) {
          element.removeAttribute(attr.name);
          continue;
        }

        // Check against global allowlist
        if (ALLOWED_ATTRIBUTES.has(attrName)) continue;

        // Check against tag-specific allowlist
        const tagSpecific = TAG_ATTRIBUTES[tagName];
        if (tagSpecific?.has(attrName)) {
          // Validate URL attributes
          if (attrName === 'src') {
            if (!isAllowedUrl(attr.value)) {
              element.removeAttribute(attr.name);
            }
          }
          continue;
        }

        // Not in any allowlist — remove
        element.removeAttribute(attr.name);
      }

      // Sanitize style attribute to remove expression/url() tricks
      if (element.hasAttribute('style')) {
        const style = element.getAttribute('style') || '';
        const sanitizedStyle = sanitizeStyle(style);
        if (sanitizedStyle) {
          element.setAttribute('style', sanitizedStyle);
        } else {
          element.removeAttribute('style');
        }
      }

      // Recursively sanitize children
      sanitizeNode(element);
    } else if (child.nodeType === Node.COMMENT_NODE) {
      // Remove HTML comments (can contain conditional IE directives)
      node.removeChild(child);
    }
    // Text nodes are always safe
  }
}

/**
 * Validate a URL value for safe schemes.
 */
function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://placeholder.local');
    return SAFE_URL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Sanitize inline CSS to remove JavaScript execution vectors.
 * Removes expression(), url(javascript:), and -moz-binding.
 */
function sanitizeStyle(style: string): string {
  const lower = style.toLowerCase();

  // SECURITY: Block CSS expression evaluation
  if (lower.includes('expression(')) return '';
  if (lower.includes('-moz-binding')) return '';
  if (lower.includes('javascript:')) return '';
  if (lower.includes('vbscript:')) return '';
  if (lower.includes('behavior:')) return '';

  return style;
}
