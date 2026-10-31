import {
  InputFilterService,
  OutputPiiScannerService,
  SsrfValidatorService,
} from '@aquaculture/backend-common/ai-safety';
import { collaborator } from '@aquaculture/testing';

import { AiSafetyMiddleware, type OutputSafetyStream } from '../ai-safety.middleware';
import { InstructionHierarchyService } from '../instruction-hierarchy.service';
import { ToolSchemaValidatorService } from '../tool-schema-validator.service';

const TENANT = '00000000-0000-4000-8000-000000000001';

// The output stage uses the real scanner; the other stages are not touched.
const build = (): AiSafetyMiddleware =>
  new AiSafetyMiddleware(
    collaborator<InputFilterService>({}, 'InputFilterService'),
    collaborator<InstructionHierarchyService>({}, 'InstructionHierarchyService'),
    new OutputPiiScannerService(),
    collaborator<SsrfValidatorService>({}, 'SsrfValidatorService'),
    collaborator<ToolSchemaValidatorService>({}, 'ToolSchemaValidatorService'),
  );

function run(stream: OutputSafetyStream, pieces: string[]): { shown: string[]; whole: string } {
  const shown = pieces.map((piece) => stream.push(piece));
  const { outputText } = stream.end();
  return { shown, whole: shown.join('') + outputText };
}

describe('AiSafetyMiddleware.postProcessStream', () => {
  const pieces = ['Mail ops@exa', 'mple.com about ', 'tank 4.'];

  it('redacts by default, holding an address back until it is complete', () => {
    const middleware = build();
    const stream = middleware.postProcessStream(TENANT);
    const { shown, whole } = run(stream, pieces);
    expect(shown).toEqual(['Mail ', '[REDACTED] about ', 'tank ']);
    expect(whole).toBe('Mail [REDACTED] about tank 4.');
  });

  it('reports what it redacted once the text ends', () => {
    const stream = build().postProcessStream(TENANT);
    pieces.forEach((piece) => stream.push(piece));
    expect(stream.end()).toMatchObject({
      piiRedacted: true,
      piiScan: { countByType: { email: 1 } },
    });
  });

  it('passes text through unchanged and scans the whole when redaction is off', () => {
    const middleware = build();
    middleware.configure({ outputPiiAutoRedact: false });
    const stream = middleware.postProcessStream(TENANT);
    expect(pieces.map((piece) => stream.push(piece))).toEqual(pieces);
    expect(stream.end()).toMatchObject({
      outputText: '',
      piiRedacted: false,
      piiScan: { countByType: { email: 1 } },
    });
  });

  it('passes text through unchanged when the output scan is off', () => {
    const middleware = build();
    middleware.configure({ outputPiiScanEnabled: false });
    const stream = middleware.postProcessStream(TENANT);
    expect(pieces.map((piece) => stream.push(piece))).toEqual(pieces);
    expect(stream.end()).toEqual({ outputText: '', piiRedacted: false });
  });
});
