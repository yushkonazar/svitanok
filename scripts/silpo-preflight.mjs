#!/usr/bin/env node
// Public, unauthenticated diagnostics only. No env/secrets, OAuth registration,
// tool calls, cookies, redirects, cart access or production writes.
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://mcp.silpo.ua';
const RESOURCE = `${ORIGIN}/mcp`;
const MAX_BODY_BYTES = 32768;

/** @param {Response} response */
async function readMetadata(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    throw new Error('invalid_metadata');
  if (!response.body) throw new Error('invalid_metadata');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('invalid_metadata');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const metadata = JSON.parse(new TextDecoder().decode(body));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('invalid_metadata');
  return metadata;
}

/**
 * Fixed official public URLs; importing this file never performs a request.
 * Success means OAuth discovery works, NOT authenticated catalog access.
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} deps
 */
export async function silpoPreflight(deps = {}) {
  const request = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000)
    throw new Error('invalid_timeout');
  const checks = [];
  for (const [stage, url, expectedStatus] of [
    ['resource', RESOURCE, 401],
    ['protected_resource', `${ORIGIN}/.well-known/oauth-protected-resource/mcp`, 200],
    ['authorization_server', `${ORIGIN}/.well-known/oauth-authorization-server`, 200],
  ]) {
    let response;
    let check;
    try {
      response = await request(String(url), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      check = { stage, status: response.status, ok: false, reason: 'unexpected_status' };
      if (response.status === expectedStatus) {
        if (stage === 'resource') {
          // Do not follow or print arbitrary URLs supplied by the server.
          const challenge = response.headers.get('www-authenticate') ?? '';
          check.ok =
            /^Bearer\b/i.test(challenge) &&
            challenge.includes(
              `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
            );
        } else {
          const metadata = await readMetadata(response);
          if (stage === 'protected_resource') {
            check.ok =
              metadata.resource === RESOURCE &&
              Array.isArray(metadata.authorization_servers) &&
              metadata.authorization_servers.length === 1 &&
              metadata.authorization_servers[0] === ORIGIN &&
              Array.isArray(metadata.bearer_methods_supported) &&
              metadata.bearer_methods_supported.includes('header');
          } else {
            check.ok =
              metadata.issuer === ORIGIN &&
              metadata.authorization_endpoint === `${ORIGIN}/authorize` &&
              metadata.token_endpoint === `${ORIGIN}/token` &&
              metadata.registration_endpoint === `${ORIGIN}/register` &&
              Array.isArray(metadata.code_challenge_methods_supported) &&
              metadata.code_challenge_methods_supported.includes('S256') &&
              Array.isArray(metadata.grant_types_supported) &&
              metadata.grant_types_supported.includes('authorization_code') &&
              metadata.grant_types_supported.includes('refresh_token');
          }
        }
        check.reason = check.ok ? 'verified' : 'metadata_changed';
      }
    } catch (error) {
      // Never expose provider body, cookies, arbitrary metadata or error text.
      check = {
        stage,
        status: response?.status ?? null,
        ok: false,
        reason:
          error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? 'timeout'
            : response
              ? 'invalid_metadata'
              : 'transport_error',
      };
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
    checks.push(check);
    // No retries, no downstream requests after a failed discovery step.
    if (!check.ok) break;
  }
  return {
    checkedAt: new Date().toISOString(),
    publicDiscoveryVerified: checks.length === 3 && checks.every((check) => check.ok),
    authenticatedCatalogVerified: false,
    dailyMonitoringEnabled: false,
    checks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await silpoPreflight();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.publicDiscoveryVerified ? 0 : 1;
}
