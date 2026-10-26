import { constants as httpConstants } from 'node:http2'
import { describe, test, expect } from 'vitest'

import { buildOversizedRequestIdLog } from '../../../src/utils/build-oversized-request-id-log.js'

describe('buildOversizedRequestIdLog', () => {
  test('returns the request details and oversized header length as approved ECS event fields', () => {
    const request = {
      method: 'GET',
      path: '/api/v1/metadata/sbi/105000000'
    }

    expect(buildOversizedRequestIdLog(request, 51)).toEqual({
      event: {
        type: 'request_id_too_long',
        action: 'GET',
        category: '/api/v1/metadata/sbi/105000000',
        reason: 'header_length=51',
        outcome: 'failure',
        kind: httpConstants.HTTP_STATUS_BAD_REQUEST
      }
    })
  })
})
