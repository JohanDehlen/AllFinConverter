const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1_000] as const;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
]);

export interface RetriedFetchResponse {
  readonly response: Response;
  readonly bodyText: string;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function hasRetryableNetworkCode(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || (typeof current !== 'object' && typeof current !== 'function')) {
      continue;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    const cause = (current as { cause?: unknown }).cause;
    if (cause !== undefined) pending.push(cause);

    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
  }

  return false;
}

function isRetryableFetchError(error: unknown, signal: AbortSignal): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return signal.aborted;
  }
  return error instanceof TypeError && hasRetryableNetworkCode(error);
}

function isRetryableBodyError(error: unknown, signal: AbortSignal): boolean {
  return isRetryableFetchError(error, signal);
}

export async function retryFetch(
  fetchFn: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<RetriedFetchResponse> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    let retry = false;

    try {
      try {
        response = await fetchFn(input, { ...init, signal: controller.signal });
      } catch (error) {
        if (!isRetryableFetchError(error, controller.signal) || attempt === MAX_ATTEMPTS) {
          throw error;
        }
        retry = true;
      }

      if (response) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
          await response.body?.cancel();
          retry = true;
        } else {
          try {
            const bodyText = await response.text();
            return { response, bodyText };
          } catch (error) {
            if (!isRetryableBodyError(error, controller.signal) || attempt === MAX_ATTEMPTS) {
              throw error;
            }
            retry = true;
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (retry) {
      await wait(RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  throw new Error('Retry attempt loop completed without a response.');
}
