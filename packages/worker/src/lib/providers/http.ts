import { PermanentSendError, TransientSendError, type ProviderId } from './types';

export interface RelayResponse {
  status: number;
  body: unknown;
}

/**
 * POST JSON to a relay with a hard deadline, so one slow provider cannot
 * burn the whole Worker invocation budget before failover gets a chance.
 */
export async function relayPost(
  provider: ProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 10_000
): Promise<RelayResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TransientSendError(`${provider}: network timeout (${(error as Error).message})`, provider);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const detail = describeError(parsed) || response.statusText;
    // 429 = quota/rate, 401/403 = credential problem: both may succeed on
    // another provider, so they retry rather than permanently kill the mail.
    if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500) {
      throw new TransientSendError(`${provider} ${response.status}: ${detail}`, provider);
    }
    throw new PermanentSendError(`${provider} ${response.status}: ${detail}`, provider);
  }

  return { status: response.status, body: parsed };
}

/** GET for verification calls; throws on any non-2xx. */
export async function relayGet(
  provider: ProviderId,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8_000
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TransientSendError(`${provider}: network timeout (${(error as Error).message})`, provider);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new TransientSendError(`${provider} ${response.status}: ${describeError(safeParse(text)) || response.statusText}`, provider);
  }
  return safeParse(text);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function describeError(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const record = parsed as Record<string, unknown>;
  for (const key of ['message', 'error', 'ErrorErrorMessage', 'errors', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.slice(0, 300);
    if (Array.isArray(value) && value.length > 0) return JSON.stringify(value).slice(0, 300);
    if (value && typeof value === 'object') {
      const nested = describeError(value);
      if (nested) return nested;
    }
  }
  return JSON.stringify(record).slice(0, 300);
}
