import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Support Tickets E2E Workflow Test
 *
 * Tests the complete support ticket flow:
 * Create ticket -> Add comment -> Verify ticket with comments
 */
describe('Support Tickets', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;
  let createdTicketId: string;

  beforeAll(() => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);
  });

  afterAll(() => {
    client.clearToken();
  });

  test('Create ticket -> add comment -> verify', async () => {
    const ticketSubject = `E2E Test Ticket ${Date.now()}`;
    const ticketDescription = `This is an E2E test ticket created at ${new Date().toISOString()}. Testing support workflow.`;

    // Step 1: Create a new support ticket
    const createResult = await client.mutate<{
      createTicket: {
        id: string;
        ticketNumber: string;
        subject: string;
        description: string;
        category: string;
        priority: string;
        status: string;
        createdAt: string;
      };
    }>(
      `
      mutation CreateTicket($input: CreateTicketInput!) {
        createTicket(input: $input) {
          id
          ticketNumber
          subject
          description
          category
          priority
          status
          createdAt
        }
      }
      `,
      {
        input: {
          subject: ticketSubject,
          description: ticketDescription,
          category: 'TECHNICAL',
          priority: 'MEDIUM',
          tags: ['e2e-test'],
        },
      },
    );

    createdTicketId = createResult.createTicket.id;
    expect(createdTicketId).toBeDefined();
    expect(createResult.createTicket.ticketNumber).toBeDefined();
    expect(createResult.createTicket.subject).toBe(ticketSubject);
    expect(createResult.createTicket.status).toBe('open');
    expect(createResult.createTicket.category).toBe('technical');
    expect(createResult.createTicket.priority).toBe('medium');

    // Step 2: Add a comment to the ticket
    const commentContent = `E2E test comment added at ${new Date().toISOString()}`;

    const commentResult = await client.mutate<{
      addTicketComment: {
        id: string;
        ticketId: string;
        content: string;
        authorId: string;
        authorType: string;
        isInternal: boolean;
        createdAt: string;
      };
    }>(
      `
      mutation AddComment($input: AddTicketCommentInput!) {
        addTicketComment(input: $input) {
          id
          ticketId
          content
          authorId
          authorType
          isInternal
          createdAt
        }
      }
      `,
      {
        input: {
          ticketId: createdTicketId,
          content: commentContent,
          isInternal: false,
        },
      },
    );

    expect(commentResult.addTicketComment.id).toBeDefined();
    expect(commentResult.addTicketComment.ticketId).toBe(createdTicketId);
    expect(commentResult.addTicketComment.content).toBe(commentContent);
    expect(commentResult.addTicketComment.isInternal).toBe(false);

    // Step 3: Verify ticket by querying it directly
    const ticketResult = await client.query<{
      ticket: {
        id: string;
        ticketNumber: string;
        subject: string;
        description: string;
        category: string;
        priority: string;
        status: string;
        createdAt: string;
      };
    }>(
      `
      query GetTicket($id: ID!) {
        ticket(id: $id) {
          id
          ticketNumber
          subject
          description
          category
          priority
          status
          createdAt
        }
      }
      `,
      { id: createdTicketId },
    );

    expect(ticketResult.ticket.id).toBe(createdTicketId);
    expect(ticketResult.ticket.subject).toBe(ticketSubject);

    // Step 4: Verify comments on the ticket
    const commentsResult = await client.query<{
      ticketComments: Array<{
        id: string;
        ticketId: string;
        authorId: string;
        authorName: string;
        authorType: string;
        content: string;
        isInternal: boolean;
        createdAt: string;
      }>;
    }>(
      `
      query TicketComments($ticketId: ID!) {
        ticketComments(ticketId: $ticketId) {
          id
          ticketId
          authorId
          authorName
          authorType
          content
          isInternal
          createdAt
        }
      }
      `,
      { ticketId: createdTicketId },
    );

    // Should have at least the comment we added
    expect(commentsResult.ticketComments.length).toBeGreaterThanOrEqual(1);

    const foundComment = commentsResult.ticketComments.find(
      (c) => c.content === commentContent,
    );
    expect(foundComment).toBeDefined();
    if (foundComment) {
      expect(foundComment.ticketId).toBe(createdTicketId);
      expect(foundComment.isInternal).toBe(false);
    }

    // Step 5: Verify ticket appears in myTickets list
    const listResult = await client.query<{
      myTickets: Array<{
        id: string;
        ticketNumber: string;
        subject: string;
        status: string;
        commentCount: number;
      }>;
    }>(`
      query MyTickets {
        myTickets {
          id
          ticketNumber
          subject
          status
          commentCount
        }
      }
    `);

    const foundTicket = listResult.myTickets.find(
      (t) => t.id === createdTicketId,
    );
    expect(foundTicket).toBeDefined();
    if (foundTicket) {
      expect(foundTicket.commentCount).toBeGreaterThanOrEqual(1);
    }
  });
});
