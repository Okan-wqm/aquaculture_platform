/**
 * Droplet alert-rule runbook coverage invariant (B2 / OBS-HIGH-002).
 * ============================================================================
 *
 * Every alert in the droplet Prometheus rule files
 * (infrastructure/monitoring/droplet/rules/*.yml) MUST carry a `runbook_url`
 * annotation, and that URL MUST resolve to a real file in the repo. A page at
 * 03:00 with no runbook is the worst on-call experience there is — the operator
 * is handed a firing alert and a blank wall. This invariant makes "alert
 * without a runbook" a CI failure rather than an incident-time discovery.
 *
 * It also closes the dormant-rules gap recorded in OBS-HIGH-002: the K8s
 * aquaculture-rules.yaml shipped ZERO runbook_url annotations; the extracted
 * droplet rules are held to 100% coverage here.
 *
 * When this fails: add `runbook_url:` (under the alert's `annotations:`) and
 * create the referenced docs/runbooks/monitoring/<name>.md.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RULES_DIR = path.join(REPO_ROOT, 'infrastructure/monitoring/droplet/rules');
const GH_BLOB_PREFIX =
  'https://github.com/Okan-wqm/aquaculture_platform/blob/main/';

interface AlertRule {
  alert?: string;
  annotations?: { runbook_url?: string };
}
interface RuleGroup {
  name?: string;
  rules?: AlertRule[];
}
interface RuleFile {
  groups?: RuleGroup[];
}

interface CollectedRule {
  file: string;
  group: string;
  alert: string;
  runbookUrl?: string;
}

function collectAlertRules(): CollectedRule[] {
  const collected: CollectedRule[] = [];
  for (const fileName of fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.yml'))) {
    const doc = yaml.load(fs.readFileSync(path.join(RULES_DIR, fileName), 'utf8')) as RuleFile;
    for (const group of doc.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (!rule.alert) continue;
        collected.push({
          file: fileName,
          group: group.name ?? '(unnamed)',
          alert: rule.alert,
          runbookUrl: rule.annotations?.runbook_url,
        });
      }
    }
  }
  return collected;
}

describe('INVARIANT: every droplet alert rule has a runbook_url whose file exists (B2)', () => {
  const rules = collectAlertRules();

  it('found the droplet alert rules (rule files are present and parse)', () => {
    expect(rules.length).toBeGreaterThanOrEqual(8);
  });

  for (const rule of rules) {
    describe(`${rule.file} :: ${rule.group} :: ${rule.alert}`, () => {
      it('declares a runbook_url annotation', () => {
        expect(rule.runbookUrl).toBeTruthy();
      });

      it('runbook_url resolves to a committed docs/runbooks/monitoring/ file', () => {
        const url = rule.runbookUrl ?? '';
        expect(url.startsWith(GH_BLOB_PREFIX)).toBe(true);
        const relPath = url.slice(GH_BLOB_PREFIX.length);
        expect(relPath.startsWith('docs/runbooks/monitoring/')).toBe(true);
        expect(fs.existsSync(path.join(REPO_ROOT, relPath))).toBe(true);
      });
    });
  }
});
