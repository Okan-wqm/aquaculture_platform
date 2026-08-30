export const MARINE_PROVIDER_MAX_JSON_RESPONSE_BYTES = 16 * 1024;

export async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null && !response.body.locked) {
    await response.body.cancel();
  }
}

/**
 * Reads a provider JSON response without ever buffering more than the explicit
 * byte budget. Declared and streamed oversize responses are cancelled before
 * returning, and malformed JSON is represented as null.
 */
export async function readBoundedJsonResponse(
  response: Response,
  maxBytes = MARINE_PROVIDER_MAX_JSON_RESPONSE_BYTES,
): Promise<unknown | null> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      await cancelResponseBody(response);
      return null;
    }
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      await cancelResponseBody(response);
      return null;
    }
  }
  if (response.body === null) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(combined)) as unknown;
  } catch {
    return null;
  }
}
