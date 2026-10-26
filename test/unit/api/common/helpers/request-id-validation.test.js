import { beforeEach, describe, expect, test, vi } from 'vitest'
import Hapi from '@hapi/hapi'
import { getTraceId } from '@defra/hapi-tracing'
import { requestTracing } from '../../../../../src/api/common/helpers/request-tracing.js'

const mockLoggerWarn = vi.fn()

vi.mock('../../../../../src/logging/logger.js', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    error: vi.fn(),
    info: vi.fn()
  })
}))

vi.mock('../../../../../src/config/index.js', () => ({
  config: {
    get: (key) => key === 'tracing.header' ? 'x-cdp-request-id' : undefined
  }
}))

const { rejectOversizedRequestId } = await import('../../../../../src/api/common/helpers/request-id-validation.js')

describe('request-id validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const routes = [
    {
      name: 'blob route',
      path: '/api/v1/blob/123e4567-e89b-42d3-a456-426614174000',
      method: 'GET'
    },
    {
      name: 'metadata route',
      path: '/api/v1/metadata/sbi/123456789',
      method: 'GET'
    },
    {
      name: 'unauthenticated route',
      path: '/health',
      method: 'GET'
    }
  ]

  test.each(routes)('rejects oversized request ids before $name handles the request', async ({ path, method }) => {
    const server = Hapi.server()
    server.ext('onRequest', rejectOversizedRequestId)
    let traceId
    let requestId
    server.ext('onPreResponse', (request, h) => {
      traceId = getTraceId()
      requestId = request.headers['x-cdp-request-id']
      return h.continue
    })
    await server.register(requestTracing)
    server.route({ method, path, handler: () => ({ ok: true }) })
    await server.initialize()

    const response = await server.inject({
      method,
      url: path,
      headers: { 'x-cdp-request-id': 'a'.repeat(51) }
    })

    expect(response.statusCode).toBe(400)
    expect(response.result.message).toContain('x-cdp-request-id')
    expect(response.result.message).toContain('50')
    expect(traceId).toBeUndefined()
    expect(requestId).toBeUndefined()
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('a'.repeat(51))
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'request_id_too_long',
          category: path,
          reason: 'header_length=51',
          outcome: 'failure',
          kind: 400
        })
      }),
      expect.stringContaining('x-cdp-request-id exceeds 50 characters')
    )

    await server.stop()
  })

  test.each(routes)('allows request ids of exactly 50 characters before $name handles the request', async ({ path, method }) => {
    const server = Hapi.server()
    server.ext('onRequest', rejectOversizedRequestId)
    server.route({ method, path, handler: () => ({ ok: true }) })
    await server.initialize()

    const response = await server.inject({
      method,
      url: path,
      headers: { 'x-cdp-request-id': 'b'.repeat(50) }
    })
    expect(response.statusCode).toBe(200)
    expect(mockLoggerWarn).not.toHaveBeenCalled()

    await server.stop()
  })

  test.each(routes)('allows requests without x-cdp-request-id before $name handles the request', async ({ path, method }) => {
    const server = Hapi.server()
    server.ext('onRequest', rejectOversizedRequestId)
    server.route({ method, path, handler: () => ({ ok: true }) })
    await server.initialize()

    const response = await server.inject({
      method,
      url: path
    })

    expect(response.statusCode).toBe(200)
    expect(mockLoggerWarn).not.toHaveBeenCalled()

    await server.stop()
  })
})
