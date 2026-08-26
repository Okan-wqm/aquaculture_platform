import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { NatsRequestReply, RequestReplyResponderHandle } from '@platform/event-bus';
import { INGEST_BACKEND_POLICY_SUBJECTS, IngressOwnerPolicy } from '@platform/event-contracts';

import { IngressOwnerPolicyService } from './ingress-owner-policy.service';

@Injectable()
export class OwnerPolicySnapshotResponder implements OnModuleInit, OnModuleDestroy {
  private handle: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly requestReply: NatsRequestReply,
    private readonly policyService: IngressOwnerPolicyService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.handle = await this.requestReply.respond<Record<string, never>, IngressOwnerPolicy[]>(
      INGEST_BACKEND_POLICY_SUBJECTS.ownerSnapshot,
      () => this.policyService.getSnapshot(),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.drain();
    }
  }
}
