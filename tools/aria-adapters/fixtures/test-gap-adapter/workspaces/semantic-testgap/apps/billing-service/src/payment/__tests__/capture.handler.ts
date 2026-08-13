// FP-trap coverage signal: lives under __tests__/ so the adapter counts it
// as capture.handler's test, while no jest project ever collects it — it
// is SCAN DATA for the semantic_regression lane, not a runnable test.
import { CaptureHandler } from '../capture.handler';
export const covered = new CaptureHandler().createCapture();
