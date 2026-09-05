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
import { ESLintUtils } from '@typescript-eslint/utils';
type MessageIds = 'frameWithoutSandbox' | 'srcDocOutsideSandboxedPreview';
declare const _default: ESLintUtils.RuleModule<
  MessageIds,
  [],
  unknown,
  ESLintUtils.RuleListener
> & {
  name: string;
};
export default _default;
//# sourceMappingURL=no-unsandboxed-html-frame.d.ts.map
