import { Module } from '@nestjs/common';
import { AiChatResponder } from './ai-chat.responder';
import { AgentModule } from '../agent/agent.module';

@Module({
  // AI chat is a NATS request-reply responder (request.ai.chat), NOT a REST
  // controller — served over the platform's real-time path (gateway socket.io
  // + NATS), consistent with messaging/sensor/st-language. A @MessagePattern
  // handler is registered as a "controller" on the microservice transport.
  imports: [AgentModule],
  controllers: [AiChatResponder],
})
export class ChatModule {}
