/**
 * INVARIANT — one declaration per billing admin command, and one metadata key
 * (BILLING-CRITICAL-003, ADR-0014).
 *
 * Two asymmetries had grown between a sender and its consumer, and both were
 * silent:
 *
 *   1. `BILLING_ADMIN_COMMAND_SUBJECTS` names every command billing accepts
 *      over NATS. A subject with no consumer times out at 15s; a subject with
 *      no `services.yaml` grant is refused by the NATS server; a subject
 *      published from an inline anonymous payload drifts from the contract
 *      without a compile error anywhere. All three are invisible until an
 *      operator clicks the button.
 *   2. The producer binds a tenant into Stripe metadata under
 *      `internalTenantId`; all five webhook consumers read `metadata.tenantId`
 *      and warn-and-returned. Every Stripe webhook the platform received was
 *      discarded — no payment recorded, no subscription cancelled, no refund
 *      applied — and a warn-and-return is indistinguishable from a webhook for
 *      somebody else's object, so nothing ever surfaced it.
 *
 * This gate derives all of it from ONE declaration each: the subject map, and
 * `STRIPE_TENANT_METADATA_KEY`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

const CONTRACT = 'libs/event-contracts/src/billing-admin-commands.ts';
const SENDER =
  'apps/admin-api-service/src/billing/services/billing-admin-command-client.service.ts';
const SERVICES_YAML = 'infrastructure/nats/services.yaml';
const METADATA_SSOT = 'libs/backend-common/src/billing/stripe-metadata.ts';
const STRIPE_PRODUCER = 'libs/backend-common/src/billing/stripe-api.service.ts';
const WEBHOOK_CONSUMER = 'apps/billing-service/src/billing/controllers/stripe-webhook.service.ts';

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

/**
 * Source with comments removed. A gate that trips on the prose explaining the
 * defect it prevents is a gate nobody can document around — the files below
 * all NAME the old `metadata.tenantId` key in their docblocks on purpose.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listFiles(...globs: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...globs], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/** `MEMBER: 'request.billing.…'` — the map IS the declaration. */
function declaredSubjects(): Map<string, string> {
  const block = read(CONTRACT);
  const start = block.indexOf('BILLING_ADMIN_COMMAND_SUBJECTS = {');
  expect(start).toBeGreaterThan(-1);
  const end = block.indexOf('} as const;', start);
  const body = block.slice(start, end);
  const subjects = new Map<string, string>();
  for (const [, member, subject] of body.matchAll(
    /^\s*([A-Z0-9_]+):\s*'(request\.billing\.[^']+)'/gm,
  )) {
    subjects.set(member!, subject!);
  }
  return subjects;
}

describe('INVARIANT (BILLING-CRITICAL-003): one declaration per billing admin command', () => {
  const subjects = declaredSubjects();
  const consumerSource = listFiles('apps/billing-service/src/**/*.ts')
    .filter((file) => !file.includes('__tests__'))
    .map(read)
    .join('\n');
  const senderSource = read(SENDER);
  const grants = read(SERVICES_YAML);

  it('sees the fleet', () => {
    // A guard on the parser itself: a rename that breaks the regex would
    // otherwise make every assertion below vacuously true.
    expect(subjects.size).toBeGreaterThanOrEqual(30);
  });

  it.each([...subjects.keys()])('%s is published by a contract-typed sender', (member) => {
    // `sendBillingCommand<TCommand, TResult>(SUBJECTS.X, …)` — the type
    // arguments are what make an inline anonymous payload a compile error.
    expect(senderSource).toContain(`BILLING_ADMIN_COMMAND_SUBJECTS.${member}`);
  });

  it.each([...subjects.keys()])('%s has a consumer @MessagePattern', (member) => {
    expect(consumerSource).toContain(`@MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.${member})`);
  });

  it.each([...subjects.entries()])('%s is granted in services.yaml (%s)', (_member, subject) => {
    // Either named outright or covered by a wildcard the billing side holds.
    const wildcard = subject.replace(/\.[^.]+$/, '.>');
    expect(grants.includes(`'${subject}'`) || grants.includes(`'${wildcard}'`)).toBe(true);
  });
});

describe('INVARIANT (ADR-0014): the Stripe tenant metadata key has one declaration', () => {
  it('declares the key exactly once, in backend-common', () => {
    const declarations = listFiles('libs/**/*.ts', 'apps/*/src/**/*.ts').filter((file) =>
      /export const STRIPE_TENANT_METADATA_KEY/.test(read(file)),
    );
    expect(declarations).toEqual([METADATA_SSOT]);
  });

  it('has the producer write it through the constant, never as a literal', () => {
    const producer = read(STRIPE_PRODUCER);
    expect(producer).toContain('[STRIPE_TENANT_METADATA_KEY]: args.tenantId');
    // A second literal would be a second producer key, which is the drift.
    const literals = producer.match(/'internalTenantId'|"internalTenantId"/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('has the webhook consumer read metadata ONLY through the shared helper', () => {
    const consumer = code(WEBHOOK_CONSUMER);
    expect(consumer).toContain('readStripeTenantHint');

    // Any hand-rolled reach into a Stripe object's metadata is the defect
    // returning: the consumer must resolve the tenant from the owning row and
    // touch the metadata only through the helper that marks it as a hint.
    const handRolled = [...consumer.matchAll(/metadata\??\.\s*\w+/g)].map((m) => m[0]);
    expect(handRolled).toEqual([]);
  });

  it('leaves no Stripe consumer reading the old `metadata.tenantId` key', () => {
    // Scoped to the Stripe surface: `metadata.tenantId` is a perfectly good
    // key elsewhere (GDPR consent records carry one), and a fleet-wide ban on
    // a common property name would be a heuristic dressed as an invariant.
    const offenders = listFiles('apps/*/src/**/*.ts', 'libs/**/*.ts')
      .filter((file) => !file.includes('__tests__'))
      .filter((file) => /stripe|webhook/i.test(file))
      .filter((file) => /metadata\??\.tenantId\b/.test(code(file)));
    expect(offenders).toEqual([]);
  });
});

describe('INVARIANT (ADR-0014): billing.subscriptions is written through handlers only', () => {
  it('has no raw INSERT/UPDATE/DELETE against billing.subscriptions in service code', () => {
    // Three raw `UPDATE`s (cancel, reactivate, extend-trial) and one raw
    // `INSERT` (tenant provisioning) used to live beside the CQRS handlers that
    // do the same thing properly. Between them they told Stripe nothing, wrote
    // no outbox event, projected nothing onto `auth.tenants`, validated no state
    // transition under a lock, and — the INSERT — left `stripe_customer_id` and
    // `stripe_subscription_id` NULL, so an operator-provisioned tenant had a
    // subscription Stripe had never heard of.
    //
    // Migrations are exempt: DDL and one-off backfills are exactly the place
    // raw SQL belongs. This is about the RUNTIME write path.
    const rawWrite = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(billing\.)?"?subscriptions"?\b/i;

    const offenders = listFiles('apps/billing-service/src/**/*.ts')
      .filter((file) => !file.includes('__tests__') && !file.includes('/migrations/'))
      .filter((file) => rawWrite.test(code(file)));

    expect(offenders).toEqual([]);
  });

  it('routes every lifecycle transition through a @CommandHandler', () => {
    // The admin NATS surface is the one that used to bypass them.
    const adminHandler = code(
      'apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts',
    );
    for (const command of [
      'CancelSubscriptionCommand',
      'ReactivateSubscriptionCommand',
      'ExtendSubscriptionTrialCommand',
    ]) {
      expect(adminHandler).toContain(`new ${command}(`);
    }

    // …and each of those commands has a handler that actually handles it.
    const handlers = listFiles('apps/billing-service/src/billing/handlers/*.ts')
      .filter((file) => !file.includes('__tests__'))
      .map(code)
      .join('\n');
    for (const command of [
      'CancelSubscriptionCommand',
      'ReactivateSubscriptionCommand',
      'ExtendSubscriptionTrialCommand',
      'CreateSubscriptionCommand',
    ]) {
      expect(handlers).toContain(`@CommandHandler(${command})`);
    }
  });

  it('has one place that writes a subscription row, and both paths use it', () => {
    const writer = 'apps/billing-service/src/billing/services/subscription-writer.service.ts';
    expect(code(writer)).toContain('async createWithin(');

    // The GraphQL path and the admin provisioning path, which minted no Stripe
    // objects at all before ADR-0014.
    for (const caller of [
      'apps/billing-service/src/billing/handlers/create-subscription.handler.ts',
      'apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts',
    ]) {
      expect(code(caller)).toContain('subscriptionWriter.createWithin(');
      expect(code(caller)).toContain('ensureStripeObjects(');
    }
  });
});
