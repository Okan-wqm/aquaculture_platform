export { SendMessageCommand } from './send-message.command';
export { SendMessageHandler } from './send-message.handler';
export { EditMessageCommand } from './edit-message.command';
export { EditMessageHandler } from './edit-message.handler';
export { DeleteMessageCommand } from './delete-message.command';
export { DeleteMessageHandler } from './delete-message.handler';
export { MarkReadCommand } from './mark-read.command';
export { MarkReadHandler } from './mark-read.handler';
export { ForwardMessageCommand } from './forward-message.command';
export { ForwardMessageHandler } from './forward-message.handler';

/** All command handlers — register in MessageModule */
export const CommandHandlers = [
  SendMessageHandler,
  EditMessageHandler,
  DeleteMessageHandler,
  MarkReadHandler,
  ForwardMessageHandler,
];
