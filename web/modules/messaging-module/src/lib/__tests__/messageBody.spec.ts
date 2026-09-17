import { describe, expect, it } from 'vitest';

import { isAiErrorNotice, messageBodyKind, messageBodyLabelKey } from '../messageBody';

describe('messageBodyKind', () => {
  it('branches IMAGE/FILE/VOICE away from text rendering', () => {
    expect(messageBodyKind('IMAGE')).toBe('image');
    expect(messageBodyKind('FILE')).toBe('file');
    expect(messageBodyKind('VOICE')).toBe('voice');
  });

  it('keeps TEXT and SYSTEM as text bodies', () => {
    expect(messageBodyKind('TEXT')).toBe('text');
    expect(messageBodyKind('SYSTEM')).toBe('text');
  });

  it('maps each non-text kind to its localized label key', () => {
    expect(messageBodyLabelKey('image')).toBe('messaging.contentImage');
    expect(messageBodyLabelKey('file')).toBe('messaging.contentFile');
    expect(messageBodyLabelKey('voice')).toBe('messaging.contentVoice');
  });
});

describe('isAiErrorNotice (FAZ 2 backend contract)', () => {
  it('detects contentType SYSTEM + metadata.error === true', () => {
    expect(
      isAiErrorNotice({ contentType: 'SYSTEM', metadata: { error: true, errorCode: 'AI_TIMEOUT' } }),
    ).toBe(true);
  });

  it('rejects metadata.error without the SYSTEM stamp (forged user metadata)', () => {
    expect(isAiErrorNotice({ contentType: 'TEXT', metadata: { error: true } })).toBe(false);
  });

  it('rejects SYSTEM without metadata.error and missing/null metadata', () => {
    expect(isAiErrorNotice({ contentType: 'SYSTEM', metadata: null })).toBe(false);
    expect(isAiErrorNotice({ contentType: 'SYSTEM', metadata: { errorCode: 'AI_TIMEOUT' } })).toBe(false);
  });
});
