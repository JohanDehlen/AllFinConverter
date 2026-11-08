// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';

import { retryFetch } from '../src/lib/providers/retryFetch.ts';

const NETWORK_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
];

function networkTypeError(code: string): TypeError {
  const cause = new Error(`Network error ${code}`);
  Object.defineProperty(cause, 'code', { value: code });
  const error = new TypeError('fetch failed');
  Object.defineProperty(error, 'cause', { value: { cause } });
  return error;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

describe('retryFetch error classification', () => {
  it('retries TypeErrors whose nested causes contain recognized network codes', async () => {
    for (const code of NETWORK_CODES) {
      let attempts = 0;
      const result = await retryFetch(
        async () => {
          attempts++;
          if (attempts === 1) throw networkTypeError(code);
          return new Response('ok');
        },
        'https://example.test',
        {},
        100
      );

      assert.equal(attempts, 2, code);
      assert.equal(result.bodyText, 'ok', code);
    }
  });

  it('does not retry generic TypeErrors or unrelated programming errors', async () => {
    for (const error of [new TypeError('invalid argument'), new Error('programming error')]) {
      let attempts = 0;
      await assert.rejects(
        () =>
          retryFetch(
            async () => {
              attempts++;
              throw error;
            },
            'https://example.test',
            {},
            100
          ),
        error
      );
      assert.equal(attempts, 1);
    }
  });

  it('retries an AbortError only when this attempt timed out', async () => {
    let attempts = 0;
    const result = await retryFetch(
      async (_input, init) => {
        attempts++;
        if (attempts === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        }
        return new Response('recovered');
      },
      'https://example.test',
      {},
      10
    );
    assert.equal(attempts, 2);
    assert.equal(result.bodyText, 'recovered');

    attempts = 0;
    await assert.rejects(
      () =>
        retryFetch(
          async () => {
            attempts++;
            throw abortError();
          },
          'https://example.test',
          {},
          100
        ),
      /operation was aborted/
    );
    assert.equal(attempts, 1);
  });

  it('retries transient response-body transport failures but not generic body TypeErrors', async () => {
    let attempts = 0;
    const result = await retryFetch(
      async () => {
        attempts++;
        if (attempts === 1) {
          const response = new Response();
          Object.defineProperty(response, 'text', {
            value: async () => {
              throw networkTypeError('UND_ERR_BODY_TIMEOUT');
            },
          });
          return response;
        }
        return new Response('recovered');
      },
      'https://example.test',
      {},
      100
    );
    assert.equal(attempts, 2);
    assert.equal(result.bodyText, 'recovered');

    attempts = 0;
    const response = new Response();
    Object.defineProperty(response, 'text', {
      value: async () => {
        throw new TypeError('body is locked');
      },
    });
    await assert.rejects(
      () =>
        retryFetch(
          async () => {
            attempts++;
            return response;
          },
          'https://example.test',
          {},
          100
        ),
      /body is locked/
    );
    assert.equal(attempts, 1);
  });
});
