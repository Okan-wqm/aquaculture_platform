import { declaresTool, toolBoundaryViolations } from './helpers/ai-tool-boundary';

/**
 * The AI tool boundary checker's own rules (K10 layer 1 — V-T1a-2/3/4/8).
 *
 * WHY: ai-tenant-boundary.spec.ts §A passes only when the checker finds
 * nothing in the real tools; a checker that stopped seeing an escape would
 * pass too. Each case feeds it one synthetic tool that takes one way out and
 * proves the rule fires — the experiment that shows §A would go red.
 */

const FILE = 'apps/ai-service/src/tools/farm/probe.tool.ts';

function tool(
  body: string,
  ctor = 'private readonly farm: TenantBoundNatsClient',
  imports = '',
): string {
  return `
import { Tool } from '../core/tool.decorator';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
${imports}
@Tool({ name: 'probe' })
export class ProbeTool {
  constructor(${ctor}) {}
  async run(ctx: unknown) { ${body} }
}`;
}

const check = (text: string): string[] => toolBoundaryViolations(FILE, text);

describe('toolBoundaryViolations', () => {
  it('passes a tool that reaches farm-service only through its injected TenantBoundNatsClient', () => {
    expect(check(tool('return this.farm.request(ctx, { subject: "s", fields: {} });'))).toEqual([]);
  });

  it.each([
    [
      'the raw event bus token',
      "const bus = this.moduleRef.get('EVENT_BUS');",
      "names the DI token 'EVENT_BUS'",
    ],
    [
      'getRawConnection().request',
      'return bus.getRawConnection().request("x", "y");',
      'names getRawConnection',
    ],
    ['ModuleRef', 'const ref: ModuleRef | null = null; return ref;', 'names ModuleRef'],
    ['NatsEventBus', 'const b: NatsEventBus | null = null; return b;', 'names NatsEventBus'],
    ['the global fetch', 'return fetch("https://gateway/graphql");', 'calls the global fetch'],
    [
      'a .request( on another object',
      'return other.request(ctx, {});',
      '.request( on something other',
    ],
    [
      'minting a context',
      'return buildServicePrincipalContext({});',
      'names buildServicePrincipalContext',
    ],
  ])('flags %s', (_case, body, expected) => {
    expect(check(tool(body))).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it.each([
    ['node:http', "import { request } from 'node:http';"],
    ['https', "import https from 'https';"],
    ['axios', "import axios from 'axios';"],
    ['@nestjs/axios', "import { HttpModule } from '@nestjs/axios';"],
    [
      'the signed HTTP client',
      "import { SignedHttpClient } from '@aquaculture/backend-common/http';",
    ],
    [
      'the service-identity signer',
      "import { generateServiceIdentityHeadersV2 } from '@aquaculture/backend-common/utils/service-identity.util';",
    ],
    ['@platform/event-bus', "import { NatsRequestReply } from '@platform/event-bus';"],
    ['typeorm', "import { DataSource } from 'typeorm';"],
    [
      'the context factory',
      "import { buildHumanTurnContext } from '../../tenant-boundary/tool-context.factory';",
    ],
    [
      'a TenantBinding value',
      "import { TenantBinding } from '../../tenant-boundary/tenant-binding';",
    ],
  ])('flags an import of %s', (_case, imports) => {
    expect(check(tool('return 1;', undefined, imports)).length).toBeGreaterThan(0);
  });

  it('allows TenantBinding as a type-only import', () => {
    expect(
      check(
        tool(
          'return 1;',
          undefined,
          "import type { TenantBinding } from '../../tenant-boundary/tenant-binding';",
        ),
      ),
    ).toEqual([]);
  });

  it('flags a tool that injects anything but TenantBoundNatsClient, or @Inject with another token', () => {
    expect(check(tool('return 1;', 'private readonly http: HttpService'))).toEqual(
      expect.arrayContaining([expect.stringContaining('injects HttpService')]),
    );
    expect(
      check(tool('return 1;', "@Inject('NATS_SERVICE') private readonly nats: unknown")),
    ).toEqual(expect.arrayContaining([expect.stringContaining("@Inject('NATS_SERVICE')")]));
  });

  it('recognises a @Tool class wherever it lives (the boundary follows the decorator)', () => {
    expect(declaresTool(tool('return 1;'))).toBe(true);
    expect(declaresTool('export class NotATool {}')).toBe(false);
    expect(declaresTool('// @Tool( in a comment\nexport class X {}')).toBe(false);
  });
});
