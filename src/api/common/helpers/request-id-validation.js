import Boom from '@hapi/boom'

import { config } from '../../../config/index.js'
import { createLogger } from '../../../logging/logger.js'
import { buildOversizedRequestIdLog } from '../../../utils/build-oversized-request-id-log.js'

const logger = createLogger()
const tracingHeader = config.get('tracing.header')
const MAX_REQUEST_ID_LENGTH = 50 // fcp-audit-publisher Sets the max length for correlationid using Joi.string().max(50)

export const rejectOversizedRequestId = (request, h) => {
  const requestId = request.headers?.[tracingHeader]

  if (typeof requestId !== 'string' || requestId.length <= MAX_REQUEST_ID_LENGTH) {
    return h.continue
  }

  const headerLength = requestId.length
  // Hides the oversized id from later onRequest extensions.
  delete request.headers[tracingHeader]

  logger.warn(
    buildOversizedRequestIdLog(request, headerLength),
    `Request rejected because ${tracingHeader} exceeds ${MAX_REQUEST_ID_LENGTH} characters`
  )

  throw Boom.badRequest(`${tracingHeader} header must be ${MAX_REQUEST_ID_LENGTH} characters or fewer`)
}

const requestIdValidation = {
  plugin: {
    name: 'request-id-validation',
    register: (server) => {
      server.ext('onRequest', rejectOversizedRequestId)
    }
  }
}

export { requestIdValidation }
