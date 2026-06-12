export interface GraphQLErrorPayload {
  message?: string;
  path?: readonly string[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLResponse<TData> {
  data?: TData;
  errors?: readonly GraphQLErrorPayload[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeErrors(value: unknown): readonly GraphQLErrorPayload[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((item) => ({
    message: typeof item.message === 'string' ? item.message : undefined,
    path: Array.isArray(item.path)
      ? item.path.filter((part): part is string => typeof part === 'string')
      : undefined,
    extensions: isRecord(item.extensions) ? item.extensions : undefined,
  }));
}

export async function readGraphQLResponse<TData>(
  response: Response,
): Promise<GraphQLResponse<TData>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    return {};
  }

  return {
    data: payload.data as TData | undefined,
    errors: normalizeErrors(payload.errors),
  };
}

export function firstGraphQLError(response: GraphQLResponse<unknown>, fallback: string): string {
  return response.errors?.[0]?.message ?? fallback;
}
