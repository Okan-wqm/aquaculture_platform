import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { IsString, IsOptional, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { Request, Response } from 'express';
import { AgentRunnerService, ChatRequest } from '../agent/agent-runner.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: {
    sub?: string;
    tenantId?: string;
    roles?: string[];
    email?: string;
  };
}

class ChatBodyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  message!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'conversationId must be a valid UUID',
  })
  conversationId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(operator|manager|expert|supervisor)-v\d+$/, {
    message: 'persona must be a valid persona ID (e.g., operator-v1)',
  })
  persona?: string;
}

/**
 * Chat Controller for AI-powered aquaculture assistant.
 *
 * SECURITY (H-07): JwtAuthGuard ensures all endpoints require a valid JWT token.
 * The ai-service uses TenantGuard and RolesGuard as global APP_GUARDs (see app.module.ts),
 * but those guards rely on req.user being populated. For REST controllers that bypass
 * the GraphQL execution context, this guard ensures the JWT is validated and req.user is set
 * before the request reaches the handler. Without this guard, an unauthenticated request
 * could reach the chat endpoint and only be caught by the manual tenantId/userId check below.
 */
@UseGuards(JwtAuthGuard)
@Controller('api/v2/ai')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly agentRunner: AgentRunnerService) {}

  @Post('chat')
  async chat(
    @Body() body: ChatBodyDto,
    @Req() req: TenantRequest,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = req.tenantId ?? req.user?.tenantId;
    const userId = req.user?.sub;
    const userRoles = req.user?.roles ?? [];

    if (!tenantId || !userId) {
      throw new HttpException('Authentication required', HttpStatus.UNAUTHORIZED);
    }

    if (!body.message?.trim()) {
      throw new HttpException('Message is required', HttpStatus.BAD_REQUEST);
    }

    // Build schema name from tenant ID
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    const schemaName = `tenant_${cleanId}`;

    const correlationId =
      (req.headers['x-correlation-id'] as string) ??
      (req.headers['x-request-id'] as string) ??
      crypto.randomUUID();

    try {
      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Correlation-Id', correlationId);
      res.flushHeaders();

      // Send initial event
      res.write(`data: ${JSON.stringify({ type: 'start', conversationId: null })}\n\n`);

      const chatRequest: ChatRequest = {
        message: body.message,
        conversationId: body.conversationId,
        persona: body.persona ?? 'operator-v1',
        tenantId,
        userId,
        userRoles,
        schemaName,
        correlationId,
      };

      const result = await this.agentRunner.chat(chatRequest);

      // Send tool calls as events
      for (const toolCall of result.toolCalls) {
        res.write(
          `data: ${JSON.stringify({
            type: 'tool_call',
            name: toolCall.name,
            input: toolCall.input,
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: 'tool_result',
            name: toolCall.name,
            result: toolCall.result,
          })}\n\n`,
        );
      }

      // Send final message
      res.write(
        `data: ${JSON.stringify({
          type: 'message',
          conversationId: result.conversationId,
          content: result.message,
          tokenUsage: result.tokenUsage,
        })}\n\n`,
      );

      // Send done event
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    } catch (error) {
      this.logger.error(
        `Chat error: ${error instanceof Error ? error.message : String(error)}`,
      );

      // If headers already sent, send error as SSE event
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'Internal error',
          })}\n\n`,
        );
        res.end();
      } else {
        throw new HttpException(
          error instanceof Error ? error.message : 'Internal error',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
  }

  @Post('conversations')
  async getConversations(): Promise<unknown> {
    // Placeholder for conversation listing
    return { conversations: [] };
  }
}
