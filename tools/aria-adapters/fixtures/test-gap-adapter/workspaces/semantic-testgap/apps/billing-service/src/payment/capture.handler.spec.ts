import { CaptureHandler } from './capture.handler';
test('capture', () => expect(new CaptureHandler().createCapture()).toBe(true));
