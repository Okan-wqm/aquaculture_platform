'use strict';
/**
 * no-unsandboxed-html-frame — untrusted HTML renders only through the sandbox.
 *
 * A `<iframe srcDoc={html}>` without `sandbox` runs the document in the
 * parent's origin: a stored `<script>` in an operator-editable template reads
 * the parent's localStorage, auth context and cookies. On the admin panel
 * that is the SUPER_ADMIN session (ADMIN-CRITICAL-015). The `sandbox`
 * attribute is the control, and a control a call site can forget is not one.
 *
 * Two reports:
 *   - `frameWithoutSandbox` — any JSX `<iframe>` with no `sandbox` attribute.
 *   - `srcDocOutsideSandboxedPreview` — any `srcDoc` on an `<iframe>` outside
 *     `web/shared-ui/src/components/SandboxedHtmlPreview/`. Inline HTML is by
 *     definition content the page assembled (usually from a store); it goes
 *     through the shared component, whose sandbox is not a prop.
 *
 * Severity: `error` from the first commit — the single existing violation
 * was migrated in the same change, so there is nothing to burn down.
 */
Object.defineProperty(exports, '__esModule', { value: true });
const utils_1 = require('@typescript-eslint/utils');
const createRule = utils_1.ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`,
);
const SANDBOXED_PREVIEW_PATH = /web\/shared-ui\/src\/components\/SandboxedHtmlPreview\//;
function jsxName(node) {
  return node.type === 'JSXIdentifier' ? node.name : undefined;
}
function attributeNamed(node, name) {
  for (const attribute of node.attributes) {
    if (attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier') {
      if (attribute.name.name === name) return attribute;
    }
  }
  return undefined;
}
exports.default = createRule({
  name: 'no-unsandboxed-html-frame',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every <iframe> declares a sandbox, and inline HTML (srcDoc) renders only through SandboxedHtmlPreview from @aquaculture/shared-ui (ADMIN-CRITICAL-015).',
    },
    schema: [],
    messages: {
      frameWithoutSandbox:
        "An <iframe> without a `sandbox` attribute runs its document with the parent origin's power. Declare `sandbox` (the empty string denies everything) or render through SandboxedHtmlPreview. ADMIN-CRITICAL-015.",
      srcDocOutsideSandboxedPreview:
        'Inline HTML (`srcDoc`) is untrusted content and renders only through SandboxedHtmlPreview from @aquaculture/shared-ui, whose sandbox is not a prop. ADMIN-CRITICAL-015.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.getFilename();
    const insideSandboxedPreview = SANDBOXED_PREVIEW_PATH.test(filename.replace(/\\/g, '/'));
    return {
      JSXOpeningElement(node) {
        if (jsxName(node.name) !== 'iframe') return;
        const hasSpread = node.attributes.some(
          (attribute) => attribute.type === 'JSXSpreadAttribute',
        );
        const sandbox = attributeNamed(node, 'sandbox');
        if (!sandbox && !hasSpread) {
          context.report({ node, messageId: 'frameWithoutSandbox' });
        }
        const srcDoc = attributeNamed(node, 'srcDoc');
        if (srcDoc && !insideSandboxedPreview) {
          context.report({ node: srcDoc, messageId: 'srcDocOutsideSandboxedPreview' });
        }
      },
    };
  },
});
//# sourceMappingURL=no-unsandboxed-html-frame.js.map
