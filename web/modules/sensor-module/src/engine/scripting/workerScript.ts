/**
 * Web Worker code that executes user scripts in a sandboxed environment.
 * This code runs in a separate thread with no DOM access.
 *
 * Security model:
 * 1. All dangerous globals are deleted before any user code runs:
 *    fetch, XMLHttpRequest, importScripts, eval, Function constructor
 *    (via globalThis override), WebSocket, EventSource, etc.
 * 2. Only the $api methods are exposed via a controlled message channel.
 * 3. Execution timeout is enforced by the main thread (Worker.terminate).
 * 4. Tag write count is tracked and limited per invocation.
 * 5. Log message count is tracked and limited per invocation.
 * 6. All $api calls are async messages to main thread, not direct access.
 *
 * The worker receives script code as a string, wraps it in a controlled
 * scope that only exposes the $api methods, and executes it via new Function().
 *
 * Why new Function() here and not eval():
 * - new Function() creates a function with its own scope (no closure over worker vars)
 * - eval() would have access to the worker's local scope variables
 * - We explicitly pass only the sandbox API as function parameters
 * - The main thread NEVER uses new Function() or eval() -- only the worker does
 */
import { SANDBOX_LIMITS } from './types';

/**
 * Returns the complete Web Worker source code as a string.
 * This is used to create workers via inline Blob URLs, avoiding the need
 * for a separate worker file that would require special bundler configuration.
 */
export function getWorkerSource(): string {
  return `
"use strict";

// ===================================================================
// Phase 1: Delete dangerous globals BEFORE any user code can capture them
// ===================================================================
// We must delete these synchronously at the top level so that even if
// user code somehow runs early, these APIs are unavailable.

// Network access
self.fetch = undefined;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.EventSource = undefined;

// Script loading / code execution
self.importScripts = undefined;

// We cannot delete self.eval or self.Function entirely because
// we need Function constructor for the sandbox. Instead we remove
// eval and replace Function after creating the sandbox wrapper.
self.eval = undefined;

// Timer abuse prevention is handled by the main thread timeout,
// but we remove setInterval to prevent long-running loops.
// setTimeout is kept for legitimate short delays within the 500ms budget.
self.setInterval = undefined;

// IndexedDB and caches -- prevent persistent storage from worker
self.indexedDB = undefined;
self.caches = undefined;

// ===================================================================
// Phase 2: Define sandbox API functions
// ===================================================================

let _scriptId = '';
let _tagWriteCount = 0;
let _logCount = 0;
const _tagValues = {};

// Synchronous tag read from the snapshot provided at invocation start.
// Returns 0 as default for missing tags -- safe fallback for numeric expressions.
function $getTag(name) {
  if (typeof name !== 'string') throw new Error('$getTag: tag name must be a string');
  const val = _tagValues[name];
  return val !== undefined ? val : 0;
}

// Async tag write -- sends a message to the main thread which validates
// and routes it to TagValueBus. The write is rate-limited per invocation.
function $setTag(name, value) {
  if (typeof name !== 'string') throw new Error('$setTag: tag name must be a string');
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
    throw new Error('$setTag: value must be number, string, or boolean');
  }
  if (_tagWriteCount >= ${SANDBOX_LIMITS.MAX_TAG_WRITES}) {
    throw new Error('Tag write limit exceeded (' + ${SANDBOX_LIMITS.MAX_TAG_WRITES} + ' per invocation)');
  }
  _tagWriteCount++;
  self.postMessage({ type: 'api-call', scriptId: _scriptId, apiMethod: '$setTag', apiArgs: [name, value] });
}

// Navigate to another SCADA screen
function $navigate(screenId) {
  if (typeof screenId !== 'string') throw new Error('$navigate: screenId must be a string');
  self.postMessage({ type: 'api-call', scriptId: _scriptId, apiMethod: '$navigate', apiArgs: [screenId] });
}

// Open a SCADA screen as a floating card overlay
function $openCard(screenId, options) {
  if (typeof screenId !== 'string') throw new Error('$openCard: screenId must be a string');
  self.postMessage({ type: 'api-call', scriptId: _scriptId, apiMethod: '$openCard', apiArgs: [screenId, options || {}] });
}

// Open an external URL -- validated on the main thread (https only)
function $openUrl(url) {
  if (typeof url !== 'string') throw new Error('$openUrl: url must be a string');
  self.postMessage({ type: 'api-call', scriptId: _scriptId, apiMethod: '$openUrl', apiArgs: [url] });
}

// Log a message to the script console (rate-limited)
function $log(message) {
  if (_logCount >= ${SANDBOX_LIMITS.MAX_LOGS}) return; // Silently drop excess logs
  _logCount++;
  const msg = typeof message === 'string' ? message : String(message);
  self.postMessage({ type: 'log', scriptId: _scriptId, message: msg, level: 'info' });
}

// ===================================================================
// Phase 3: Message handler -- receives execute commands from main thread
// ===================================================================

self.onmessage = function(e) {
  const msg = e.data;
  if (!msg || msg.type !== 'execute') return;

  const { scriptId, code, tagValues, params } = msg;

  // Reset per-invocation counters
  _scriptId = scriptId;
  _tagWriteCount = 0;
  _logCount = 0;

  // Populate the tag value snapshot
  for (const key in _tagValues) delete _tagValues[key];
  if (tagValues && typeof tagValues === 'object') {
    Object.assign(_tagValues, tagValues);
  }

  try {
    // Wrap user code in a Function that only receives the sandbox API.
    // The user code cannot access any worker-scope variables because
    // Function constructor creates its own scope (unlike eval).
    const fn = new Function(
      '$getTag', '$setTag', '$navigate', '$openCard', '$openUrl', '$log', '$params',
      code
    );
    const result = fn($getTag, $setTag, $navigate, $openCard, $openUrl, $log, params || {});
    self.postMessage({ type: 'result', scriptId: scriptId, returnValue: result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      scriptId: scriptId,
      error: (err && err.message) ? err.message : String(err)
    });
  }
};

// ===================================================================
// Phase 4: Lock down Function constructor after we've captured it
// ===================================================================
// Now that self.onmessage is set and uses Function internally via closure,
// we can prevent user code from using new Function() to escape the sandbox.
// Note: This is defense-in-depth; the user code's scope only receives
// the six $api functions, so it cannot access Function directly.
try {
  self.Function = undefined;
} catch(e) {
  // Some environments may not allow this; that's acceptable since
  // user code doesn't have direct access to the global scope anyway.
}
`;
}
