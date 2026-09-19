/**
 * @module AI Chat E2E Tests
 * @description End-to-end tests for AI channel creation, persona assignment,
 * AI privacy consent management, and access control.
 *
 * NATS is mocked in E2E — these tests verify the GraphQL/CQRS/DB layer,
 * not actual AI responses.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import {
  createE2eTestApp,
  gqlRequest,
  setupTenantSchemas,
  cleanupTenantData,
  flushAllTestRedisKeys,
  TENANT_A,
  USER_A1,
  USER_A2,
  E2eTestContext,
  closeE2eTestApp,
} from './e2e-setup';

// ── GraphQL Operations ─────────────────────────────────────────────────────

const CREATE_CHANNEL = `
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      id type aiPersona
      members { userId }
    }
  }
`;

const GET_CHANNEL = `
  query GetChannel($id: ID!) {
    channel(id: $id) { id type aiPersona name }
  }
`;

const UPDATE_USER_AI_CONSENT = `
  mutation UpdateUserAiConsent($consent: Boolean!) {
    updateUserAiConsent(consent: $consent)
  }
`;

const GET_AI_SETTINGS = `
  query AiSettings {
    aiSettings { tenantAiEnabled userAiConsent }
  }
`;

const AVAILABLE_AI_PERSONAS = `
  query AvailableAiPersonas {
    availableAiPersonas { id name description }
  }
`;

// ── Test Suite ──────────────────────────────────────────────────────────────

describe('AI Chat (E2E)', () => {
  let ctx: E2eTestContext;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let aiChannelWithPersonaId: string;
  let aiChannelWithoutPersonaId: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await closeE2eTestApp(ctx);
  });

  // ── AI Channel Creation ──────────────────────────────────────────────────

  describe('AI Channel Creation', () => {
    it('should create an AI channel with a persona the caller is entitled to', async () => {
      const res = await gqlRequest(
        httpServer,
        TENANT_A,
        USER_A1,
        ['MODULE_USER'],
        ['ai_personas:expert'],
      )
        .query(CREATE_CHANNEL, {
          input: {
            type: 'AI',
            memberIds: [USER_A1],
            aiPersona: 'expert-v1',
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const channel = res.body.data.createChannel;
      expect(channel.type).toBe('AI');
      expect(channel.aiPersona).toBe('expert-v1');
      expect(channel.members).toHaveLength(1);
      expect(channel.members[0].userId).toBe(USER_A1);

      aiChannelWithPersonaId = channel.id;
    });

    it('should refuse a persona the caller is not entitled to', async () => {
      // No `ai_personas:expert` claim: the resolver applies the catalogue's
      // requiredCapabilities server-side, so a crafted mutation cannot pin
      // a persona the picker would never have offered.
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(CREATE_CHANNEL, {
          input: {
            type: 'AI',
            memberIds: [USER_A1],
            aiPersona: 'expert-v1',
          },
        })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(res.body.errors[0].message).toMatch(/permission to use the AI persona expert-v1/);
    });

    it('should create an AI channel without a persona (general assistant)', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(CREATE_CHANNEL, {
          input: {
            type: 'AI',
            memberIds: [USER_A1],
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const channel = res.body.data.createChannel;
      expect(channel.type).toBe('AI');
      expect(channel.aiPersona).toBeNull();

      aiChannelWithoutPersonaId = channel.id;
    });

    it('should persist persona on AI channel query', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(GET_CHANNEL, { id: aiChannelWithPersonaId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.channel.type).toBe('AI');
      expect(res.body.data.channel.aiPersona).toBe('expert-v1');
    });
  });

  // ── AI Consent Management ───────────────────────────────────────────────

  describe('AI Consent', () => {
    it('should grant AI consent for a user', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(UPDATE_USER_AI_CONSENT, { consent: true })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserAiConsent).toBe(true);
    });

    it('should reflect granted consent in AI settings', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(GET_AI_SETTINGS)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const settings = res.body.data.aiSettings;
      expect(settings.userAiConsent).toBe(true);
    });

    it('should revoke AI consent for a user', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(UPDATE_USER_AI_CONSENT, { consent: false })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUserAiConsent).toBe(true);
    });

    it('should reflect revoked consent in AI settings', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(GET_AI_SETTINGS)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.aiSettings.userAiConsent).toBe(false);
    });
  });

  // Tenant AI enablement is no longer a messaging mutation — it moved to
  // ai-service (updateAiProviderSettings.isEnabled), the SSoT. The removed
  // updateTenantAiSetting E2E block went with it.

  // ── AI Personas ─────────────────────────────────────────────────────────

  describe('AI Personas', () => {
    it('should list only the personas the caller is entitled to', async () => {
      // No persona capability: the picker still carries the tenant-default
      // entry (id null) and nothing else.
      const bare = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(AVAILABLE_AI_PERSONAS)
        .expect(200);
      expect(bare.body.errors).toBeUndefined();
      const bareIds = bare.body.data.availableAiPersonas.map((p: { id: string | null }) => p.id);
      expect(bareIds).toEqual([null]);

      // `ai_personas:expert` unlocks the expert tier only; a farm specialist
      // additionally needs `ai_specialties:farm`.
      const expert = await gqlRequest(
        httpServer,
        TENANT_A,
        USER_A1,
        ['MODULE_USER'],
        ['ai_personas:expert'],
      )
        .query(AVAILABLE_AI_PERSONAS)
        .expect(200);
      expect(expert.body.errors).toBeUndefined();
      const expertIds = expert.body.data.availableAiPersonas.map(
        (p: { id: string | null }) => p.id,
      );
      expect(expertIds).toContain('expert-v1');
      expect(expertIds).not.toContain('manager-v1');
      expect(expertIds).not.toContain('expert-farm-water-health-v1');

      const farmExpert = await gqlRequest(
        httpServer,
        TENANT_A,
        USER_A1,
        ['MODULE_USER'],
        ['ai_personas:expert', 'ai_specialties:farm'],
      )
        .query(AVAILABLE_AI_PERSONAS)
        .expect(200);
      expect(farmExpert.body.errors).toBeUndefined();
      const farmIds = farmExpert.body.data.availableAiPersonas.map(
        (p: { id: string | null }) => p.id,
      );
      expect(farmIds).toContain('expert-farm-water-health-v1');
      for (const persona of farmExpert.body.data.availableAiPersonas) {
        expect(persona.name).toBeTruthy();
        expect(persona.description).toBeTruthy();
      }
    });
  });

  // ── Access Control ──────────────────────────────────────────────────────

  describe('AI Channel Access Control', () => {
    it('should deny non-member access to AI channel', async () => {
      // USER_A2 is not a member of the AI channel created by USER_A1
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(GET_CHANNEL, { id: aiChannelWithPersonaId })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden|not (an active )?member|not a member/i);
    });

    it('should allow the creator to access their AI channel', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(GET_CHANNEL, { id: aiChannelWithoutPersonaId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.channel.id).toBe(aiChannelWithoutPersonaId);
    });
  });
});
