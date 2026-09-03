import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeSecurityBoundaries } from './security-boundary-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-security-boundary-adapter-'));
const apiRoot = join(workspace, 'apps/gateway-api/src');
const unguardedRoot = join(workspace, 'apps/unguarded-api/src');
const webRoot = join(workspace, 'web/shell/src');
mkdirSync(apiRoot, { recursive: true });
mkdirSync(unguardedRoot, { recursive: true });
mkdirSync(webRoot, { recursive: true });
mkdirSync(join(workspace, '.claude', 'worktrees', 'stale', 'apps', 'bad-api', 'src'), { recursive: true });

writeFileSync(
  join(apiRoot, 'app.module.ts'),
  `
    import { APP_GUARD } from '@nestjs/core';
    import { AuthGuard } from './auth.guard';
    export const providers = [{ provide: APP_GUARD, useClass: AuthGuard }];
  `,
  'utf8',
);

writeFileSync(
  join(apiRoot, 'health.controller.ts'),
  `
    import { Controller, Get } from '@nestjs/common';
    import { Public, SkipTenantGuard } from './decorators';
    @Controller('health')
    @Public()
    @SkipTenantGuard()
    export class HealthController {
      @Get()
      check() { return 'ok'; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'unsafe-public.controller.ts'),
  `
    import { Controller, Post } from '@nestjs/common';
    import { Public } from './decorators';
    @Controller('admin')
    export class UnsafePublicController {
      @Public()
      @Post()
      create() { return 'bad'; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'unsafe.resolver.ts'),
  `
    import { Mutation, Resolver } from '@nestjs/graphql';
    @Resolver()
    export class UnsafeResolver {
      @Mutation(() => Boolean)
      mutate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(unguardedRoot, 'unsafe.resolver.ts'),
  `
    import { Mutation, Resolver } from '@nestjs/graphql';
    @Resolver()
    export class UnguardedUnsafeResolver {
      @Mutation(() => Boolean)
      mutate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'safe.resolver.ts'),
  `
    import { Mutation, Resolver } from '@nestjs/graphql';
    import { Roles } from './decorators';
    @Resolver()
    @Roles('admin')
    export class SafeResolver {
      @Mutation(() => Boolean)
      mutate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(webRoot, 'unsafe-html.tsx'),
  `
    export function UnsafeHtml({ html }: { html: string }) {
      return <div dangerouslySetInnerHTML={{ __html: html }} />;
    }
  `,
  'utf8',
);
writeFileSync(
  join(webRoot, 'safe-html.tsx'),
  `
    import DOMPurify from 'dompurify';
    export function SafeHtml({ html }: { html: string }) {
      return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
    }
  `,
  'utf8',
);
writeFileSync(
  join(webRoot, 'comment-only-html.tsx'),
  `
    export function CommentOnlyHtml() {
      // Do not use dangerouslySetInnerHTML here.
      return <div>safe</div>;
    }
  `,
  'utf8',
);
writeFileSync(
  join(apiRoot, 'raw-sdk.service.ts'),
  `
    import Anthropic from '@anthropic-ai/sdk';
    export const client = new Anthropic();
  `,
  'utf8',
);
writeFileSync(
  join(workspace, '.claude', 'worktrees', 'stale', 'apps', 'bad-api', 'src', 'stale.controller.ts'),
  `
    import { Controller, Post } from '@nestjs/common';
    import { Public } from './decorators';
    @Controller('stale')
    export class StaleController {
      @Public()
      @Post()
      create() { return 'must-not-be-read'; }
    }
  `,
  'utf8',
);

const output = analyzeSecurityBoundaries({ roots: ['apps/gateway-api/src', 'apps/unguarded-api/src', 'web/shell/src'] }, workspace);
const directRootOutput = analyzeSecurityBoundaries({ roots: ['.'] }, workspace);

assert.equal(output.metadata.adapter, 'security-boundary-adapter');
assert.equal(output.observations.some((item) => item.type === 'security_boundary_endpoint'), true);
assert.equal(output.observations.some((item) => item.type === 'security_sensitive_sink'), true);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'public_write_endpoint_without_allowlist' && finding.path.endsWith('unsafe-public.controller.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'mutation_missing_role_boundary' && finding.path.includes('/unguarded-api/'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'dangerous_html_without_sanitizer' && finding.path.endsWith('unsafe-html.tsx'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'raw_security_sensitive_import' && finding.path.endsWith('raw-sdk.service.ts'),
  ),
  true,
);
assert.equal(output.findings.some((finding) => finding.path.endsWith('health.controller.ts')), false);
assert.equal(output.findings.some((finding) => finding.path.includes('/gateway-api/') && finding.path.endsWith('/unsafe.resolver.ts')), false);
assert.equal(output.findings.some((finding) => finding.path.endsWith('/safe.resolver.ts')), false);
assert.equal(output.findings.some((finding) => finding.path.endsWith('/safe-html.tsx')), false);
assert.equal(output.findings.some((finding) => finding.path.endsWith('/comment-only-html.tsx')), false);
assert.equal(output.observations.some((observation) => observation.path?.endsWith('/comment-only-html.tsx')), false);
assert.equal(directRootOutput.read_paths.some((path) => path.includes('.claude/worktrees')), false);
assert.equal(directRootOutput.findings.some((finding) => finding.message.includes('must-not-be-read')), false);

process.stdout.write('security-boundary-adapter tests passed\n');
