import { generateKeyPairSync, sign } from 'node:crypto'
import Wreck from '@hapi/wreck'
import { vi } from 'vitest'

import { config } from '../../src/config/index.js'

const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111'
const TEST_GROUP_ID = '22222222-2222-2222-2222-222222222222'
const TEST_JWKS_KEY_ID = 'test-entra-kid'

const encodeBase64Url = (value) => Buffer.from(value).toString('base64url')

const buildValidEntraToken = (privateKey) => {
  const issuer = `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0`
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', kid: TEST_JWKS_KEY_ID }
  const payload = {
    iss: issuer,
    aud: 'api://default',
    typ: 'at+jwt',
    nbf: now - 60,
    exp: now + 60,
    iat: now,
    groups: [TEST_GROUP_ID]
  }

  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

export const createEntraTestServer = async () => {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = {
    kty: 'RSA',
    kid: TEST_JWKS_KEY_ID,
    use: 'sig',
    alg: 'RS256',
    n: keyPair.publicKey.export({ format: 'jwk' }).n,
    e: keyPair.publicKey.export({ format: 'jwk' }).e
  }
  const originalAuthConfig = {
    entraEnabled: config.get('auth.entra.enabled'),
    entraTenants: config.get('auth.entra.tenants'),
    cognitoEnabled: config.get('auth.cognito.enabled')
  }

  config.set('auth.entra.enabled', true)
  config.set('auth.entra.tenants', [{ tenantId: TEST_TENANT_ID, allowedGroupIds: [TEST_GROUP_ID] }])
  config.set('auth.cognito.enabled', false)

  const wreckGetSpy = vi.spyOn(Wreck, 'get').mockResolvedValue({ payload: { keys: [jwk] } })

  try {
    const { createServer } = await import('../../src/api/index.js')
    const server = await createServer()
    await server.initialize()

    return {
      server,
      token: buildValidEntraToken(keyPair.privateKey),
      cleanup: async () => {
        await server.stop()
        wreckGetSpy.mockRestore()
      }
    }
  } catch (error) {
    wreckGetSpy.mockRestore()
    throw error
  } finally {
    config.set('auth.entra.enabled', originalAuthConfig.entraEnabled)
    config.set('auth.entra.tenants', originalAuthConfig.entraTenants)
    config.set('auth.cognito.enabled', originalAuthConfig.cognitoEnabled)
  }
}
