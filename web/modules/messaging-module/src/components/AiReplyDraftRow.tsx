import { useI18n, useTypewriter } from '@aquaculture/shared-ui';
import React, { useLayoutEffect } from 'react';

import type { AiReplyDraft } from '../lib/aiReplyDrafts';

import { PersonaAvatar } from './PersonaAvatar';
import { AiSpoken } from './PersonaText';

interface AiReplyDraftRowProps {
  draft: AiReplyDraft;
  /** The channel's persona id: the face beside the bubble. */
  aiPersona: string | null | undefined;
  /** The persona's job in the UI language: the author line. */
  authorName: string;
  /** Called after each change of the typed text, once it is laid out. */
  onGrow: () => void;
}

/**
 * The AI's reply while it is being written (MSG-MEDIUM-089): the same row an
 * AI message has, with the text typed out and a caret until the reply is
 * stored. The stored message replaces it. The text is model output and is
 * rendered as text only.
 */
export function AiReplyDraftRow({
  draft,
  aiPersona,
  authorName,
  onGrow,
}: AiReplyDraftRowProps): React.ReactElement {
  const { t } = useI18n();
  const shown = useTypewriter(draft.text);
  useLayoutEffect(() => {
    onGrow();
  }, [shown, onGrow]);
  const writing = !draft.stored || shown.length < draft.text.length;

  return (
    <div className="sd-msg-row" data-testid="ai-reply-draft" aria-busy={writing}>
      <span aria-hidden className="mt-[18px] flex">
        <PersonaAvatar aiPersona={aiPersona} size="sm" tagged={false} />
      </span>
      <div className="min-w-0 max-w-[80%]">
        <div className="sd-msg-author">
          {authorName}
          <AiSpoken />
          {writing && <span className="italic">{t('messaging.aiWriting')}</span>}
        </div>
        <div className="sd-msg sd-msg--ai">
          {shown}
          {writing && <span aria-hidden className="sd-msg-caret" />}
        </div>
      </div>
    </div>
  );
}
