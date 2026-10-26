import { constants as httpConstants } from 'node:http2'

/**
 * Build the structured log payload for an oversized tracing header rejection.
 *
 * @param {object} request - The inbound HTTP request.
 * @param {number} headerLength - The offending `x-cdp-request-id` header length.
 * @returns {{ event: { type: string, action: string, category: string, reason: string, outcome: string, kind: number } }}
 *   The ECS-style event payload to log when the header exceeds the configured limit.
 */
export const buildOversizedRequestIdLog = (request, headerLength) => ({
  event: {
    type: 'request_id_too_long',
    action: request.method,
    category: request.path,
    reason: `header_length=${headerLength}`,
    outcome: 'failure',
    kind: httpConstants.HTTP_STATUS_BAD_REQUEST
  }
})
