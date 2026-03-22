import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Messaging E2E Workflow Test
 *
 * Tests the complete messaging flow:
 * Create thread -> Send message -> Verify message list -> Close thread
 */
describe('Messaging', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;
  let createdThreadId: string;

  beforeAll(() => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);
  });

  afterAll(async () => {
    // Cleanup: close the thread if it was created
    if (createdThreadId) {
      try {
        await client.mutate(`
          mutation CloseThread($threadId: ID!) {
            closeThread(threadId: $threadId) {
              id
              status
            }
          }
        `, { threadId: createdThreadId });
      } catch {
        // Cleanup failure is not a test failure
      }
    }

    client.clearToken();
  });

  test('Create thread -> send message -> verify', async () => {
    const subject = `E2E Test Thread ${Date.now()}`;
    const initialMessage = `This is an E2E test message created at ${new Date().toISOString()}`;

    // Step 1: Create a new message thread
    const createResult = await client.mutate<{
      createThread: {
        id: string;
        subject: string;
        status: string;
        tenantId: string;
        createdAt: string;
      };
    }>(
      `
      mutation CreateThread($input: CreateThreadInput!) {
        createThread(input: $input) {
          id
          subject
          status
          tenantId
          createdAt
        }
      }
      `,
      {
        input: {
          subject,
          initialMessage,
          tenantId: fixture.tenantId,
        },
      },
    );

    createdThreadId = createResult.createThread.id;
    expect(createdThreadId).toBeDefined();
    expect(createResult.createThread.status).toBe('open');

    // Step 2: Send a follow-up message in the thread
    const followUpContent = `Follow-up message at ${new Date().toISOString()}`;

    const sendResult = await client.mutate<{
      sendMessage: {
        id: string;
        threadId: string;
        content: string;
        senderId: string;
        senderType: string;
        status: string;
        createdAt: string;
      };
    }>(
      `
      mutation SendMessage($input: SendMessageInput!) {
        sendMessage(input: $input) {
          id
          threadId
          content
          senderId
          senderType
          status
          createdAt
        }
      }
      `,
      {
        input: {
          threadId: createdThreadId,
          content: followUpContent,
          isInternal: false,
        },
      },
    );

    expect(sendResult.sendMessage.threadId).toBe(createdThreadId);
    expect(sendResult.sendMessage.content).toBe(followUpContent);
    expect(sendResult.sendMessage.id).toBeDefined();

    // Step 3: Verify messages in thread
    const messagesResult = await client.query<{
      threadMessages: Array<{
        id: string;
        threadId: string;
        content: string;
        senderId: string;
        senderType: string;
        senderName: string;
        status: string;
        isInternal: boolean;
        createdAt: string;
      }>;
    }>(
      `
      query ThreadMessages($threadId: ID!) {
        threadMessages(threadId: $threadId) {
          id
          threadId
          content
          senderId
          senderType
          senderName
          status
          isInternal
          createdAt
        }
      }
      `,
      { threadId: createdThreadId },
    );

    const messages = messagesResult.threadMessages;

    // Should have at least 2 messages (initial + follow-up)
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Each message should have valid structure
    for (const msg of messages) {
      expect(msg.id).toBeDefined();
      expect(msg.threadId).toBe(createdThreadId);
      expect(typeof msg.content).toBe('string');
      expect(msg.content.length).toBeGreaterThan(0);
      expect(msg.senderId).toBeDefined();
      expect(typeof msg.senderName).toBe('string');

      const msgDate = new Date(msg.createdAt);
      expect(msgDate.getTime()).not.toBeNaN();
    }

    // Step 4: Verify thread appears in thread list
    const threadsResult = await client.query<{
      myThreads: Array<{
        id: string;
        subject: string;
        messageCount: number;
        status: string;
      }>;
    }>(`
      query MyThreads {
        myThreads {
          id
          subject
          messageCount
          status
        }
      }
    `);

    const foundThread = threadsResult.myThreads.find(
      (t) => t.id === createdThreadId,
    );
    expect(foundThread).toBeDefined();
    if (foundThread) {
      expect(foundThread.messageCount).toBeGreaterThanOrEqual(2);
      expect(foundThread.status).toBe('open');
    }
  });
});
