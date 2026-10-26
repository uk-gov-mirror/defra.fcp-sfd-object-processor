import path from 'node:path'
import hapi from '@hapi/hapi'
import hapiSwagger from 'hapi-swagger'
import Inert from '@hapi/inert'
import Vision from '@hapi/vision'
import Jwt from '@hapi/jwt'
import { secureContext } from '@defra/hapi-secure-context'

import { config } from '../config/index.js'
import { router } from './router.js'
import { correlationScope } from './common/helpers/correlation-scope.js'
import { requestLogger } from './common/helpers/request-logger.js'
import { pulse } from './common/helpers/pulse.js'
import { requestTracing } from './common/helpers/request-tracing.js'
// Must run before requestLogger and requestTracing so they never see an oversized request id.
import { requestIdValidation } from './common/helpers/request-id-validation.js'
import { setupProxy } from './common/helpers/proxy/setup-proxy.js'
import { auth } from '../plugins/auth/index.js'
import { mongoDb } from '../plugins/mongodb.js'

const createServer = async () => {
  setupProxy()

  const server = hapi.server({
    port: config.get('port'),
    routes: {
      validate: {
        options: {
          abortEarly: false
        }
      },
      files: {
        relativeTo: path.resolve(config.get('root'), '.public')
      },
      security: {
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: false
        },
        xss: 'enabled',
        noSniff: true,
        xframe: true
      }
    },
    router: {
      stripTrailingSlash: true
    }
  })

  await server.register([
    Jwt,
    auth,
    // correlationScope must be registered before requestLogger: it enters the correlation
    // store's async scope in onRequest so hapi-pino's own [response] log line, and every
    // handler line, can read a value once one is set. Registering it after requestLogger
    // would leave hapi-pino's onRequest handling running first, with no scope entered.
    correlationScope,
    requestIdValidation,
    requestLogger,
    requestTracing,
    secureContext,
    // mongoDb must follow secureContext so the connection trusts the CDP CA certificates.
    mongoDb,
    pulse,
    router,
    Inert,
    Vision,
    {
      plugin: hapiSwagger,
      options: config.get('hapiSwagger')
    }
  ])
  return server
}

export { createServer }
