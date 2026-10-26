import { constants as httpConstants } from 'node:http2'
import { vi, describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { mockMetadataResponse } from '../../../mocks/metadata.js'
import { config } from '../../../../src/config/index.js'
import { getDb, connectDb, closeDb } from '../../../../src/data/db.js'
import { assertValidAuditEvent } from '../../../helpers/validate-audit-payload.js'
import { createEntraTestServer } from '../../../helpers/create-entra-test-server.js'

let db

beforeAll(async () => {
  await connectDb()
  db = getDb()
})

afterAll(async () => {
  await closeDb()
})

const PAGE_SIZE_CONFIG_KEY = 'mongo.metadataSbiPageSize'
const capturedAuditEvents = []
const rejectedAuditEvents = []

vi.mock('@defra/fcp-audit-publisher', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    publishAuditEvent: vi.fn().mockImplementation(async (event, config) => {
      if (typeof event.correlationid === 'string' && event.correlationid.length > 50) {
        rejectedAuditEvents.push(event)
        throw new Error('correlationid must be 50 characters or fewer')
      }

      // Simulate what @defra/fcp-audit-publisher does: add required fields
      const enrichedEvent = {
        datetime: new Date().toISOString(),
        version: config?.version || '1.0.0',
        application: config?.application,
        component: config?.component,
        environment: config?.environment,
        ip: config?.ip || '0.0.0.0',
        correlationid: event.correlationid ?? (config?.generateCorrelationId ? crypto.randomUUID() : undefined),
        security: event.security,
        audit: event.audit
      }
      capturedAuditEvents.push(enrichedEvent)
    })
  }
})

let server
let createServer
let originalCollection
let collection

// should be inserting the RAW metadata object including the 'raw' and 's3' keys to test that it successfully filters

beforeAll(async () => {
  // set a new collection for each integration test to avoid db clashes between tests
  ; ({ createServer } = await import('../../../../src/api'))
  vi.restoreAllMocks()
  originalCollection = config.get('mongo.collections.uploadMetadata')
  config.set('mongo.collections.uploadMetadata', 'metadata-test-collection')
  collection = config.get('mongo.collections.uploadMetadata')
  await db.collection(collection).deleteMany({})
})

afterEach(async () => {
  await db.collection(collection).deleteMany({})
})

afterAll(async () => {
  // test cleanup
  vi.restoreAllMocks()
  config.set('mongo.collections.uploadMetadata', originalCollection)
})

describe('GET to the /api/v1/metadata/sbi route', () => {
  const sbi = mockMetadataResponse[0].metadata.sbi
  let authServer
  let validToken
  let cleanupAuthServer

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()

    const authContext = await createEntraTestServer()
    authServer = authContext.server
    validToken = authContext.token
    cleanupAuthServer = authContext.cleanup
  })

  afterAll(async () => {
    await cleanupAuthServer()
  })

  test('validates request ids on the real route before auth without auditing oversized values', async () => {
    const payloads = [
      { headers: { Authorization: `Bearer ${validToken}`, 'x-cdp-request-id': 'a'.repeat(51) }, expectedStatus: 400, expectedCorrelationId: /^[0-9a-f-]{36}$/i },
      { headers: { Authorization: `Bearer ${validToken}`, 'x-cdp-request-id': 'b'.repeat(50) }, expectedStatus: 200, expectedCorrelationId: 'b'.repeat(50) },
      { headers: { Authorization: `Bearer ${validToken}` }, expectedStatus: 200, expectedCorrelationId: /^[0-9a-f-]{36}$/i },
      { headers: { 'x-cdp-request-id': 'c'.repeat(51) }, expectedStatus: 400, expectedCorrelationId: /^[0-9a-f-]{36}$/i },
      { headers: { 'x-cdp-request-id': 'd'.repeat(50) }, expectedStatus: 401, expectedCorrelationId: 'd'.repeat(50) },
      { headers: {}, expectedStatus: 401, expectedCorrelationId: /^[0-9a-f-]{36}$/i }
    ]

    await db.collection(collection).insertMany(mockMetadataResponse)

    for (const { headers, expectedStatus, expectedCorrelationId } of payloads) {
      capturedAuditEvents.length = 0
      rejectedAuditEvents.length = 0
      const response = await authServer.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}`,
        headers
      })

      expect(response.statusCode).toBe(expectedStatus)
      expect(rejectedAuditEvents).toHaveLength(0)

      if (expectedStatus === 200) {
        expect(response.result.data).toHaveLength(2)
        expect(response.result.page).toMatchObject({ count: 2 })
      } else {
        expect(response.result?.data).toBeUndefined()
      }

      expect(capturedAuditEvents).toHaveLength(expectedStatus === 400 ? 0 : 1)
      if (expectedStatus === 401) {
        expect(capturedAuditEvents[0].audit.entities[0]).toMatchObject({ entity: 'request', action: 'failed' })
      } else if (expectedStatus === 200) {
        expect(capturedAuditEvents[0].audit.entities[0]).toMatchObject({ entity: 'document', action: 'read' })
      }

      if (expectedStatus !== 400) {
        const correlationId = capturedAuditEvents[0].correlationid
        if (expectedCorrelationId instanceof RegExp) {
          expect(correlationId).toMatch(expectedCorrelationId)
        } else {
          expect(correlationId).toBe(expectedCorrelationId)
        }
      }
    }
  })

  describe('when there is valid data in the database', async () => {
    test('should return an array of metadata objects when one document found', async () => {
      await db.collection(collection).insertOne(mockMetadataResponse[0])

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}`
      })

      expect(response.result.data).toBeInstanceOf(Array)
      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(response.result.data[0]).toStrictEqual({
        _id: expect.anything(),
        metadata: mockMetadataResponse[0].metadata,
        file: mockMetadataResponse[0].file
      })
    })

    test('should return the page envelope with the configured default page size when no query is supplied', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}`
      })

      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(response.result.page).toStrictEqual({
        pageSize: config.get(PAGE_SIZE_CONFIG_KEY),
        count: mockMetadataResponse.length,
        hasMore: false,
        nextCursor: null
      })
    })

    test('should return one record, hasMore and a next cursor when the page size is smaller than the result set', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}?pageSize=1`
      })

      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(response.result.data).toHaveLength(1)
      expect(response.result.page).toStrictEqual({
        pageSize: 1,
        count: 1,
        hasMore: true,
        nextCursor: response.result.data[0]._id.toHexString()
      })
    })

    test('should return the next older records with no overlap when after is set to the previous next cursor', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const firstPage = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}?pageSize=1`
      })
      const secondPage = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}?pageSize=1&after=${firstPage.result.page.nextCursor}`
      })

      expect(secondPage.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(secondPage.result.data).toHaveLength(1)

      const firstFileIds = firstPage.result.data.map(doc => doc.file.fileId)
      const secondFileIds = secondPage.result.data.map(doc => doc.file.fileId)
      expect(secondFileIds.some(fileId => firstFileIds.includes(fileId))).toBe(false)

      // newest first across pages: every record on the second page is older than the cursor
      expect(firstFileIds).toEqual([mockMetadataResponse[1].file.fileId])
      expect(secondFileIds).toEqual([mockMetadataResponse[0].file.fileId])
      expect(secondPage.result.data[0]._id.toHexString() < firstPage.result.page.nextCursor).toBe(true)

      expect(secondPage.result.page).toStrictEqual({
        pageSize: 1,
        count: 1,
        hasMore: false,
        nextCursor: null
      })
    })

    test('should return an empty final page rather than 404 when the cursor is older than every record', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)
      const olderThanEveryRecord = '000000000000000000000000'

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}?after=${olderThanEveryRecord}`
      })

      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(response.result.data).toEqual([])
      expect(response.result.page).toStrictEqual({
        pageSize: config.get(PAGE_SIZE_CONFIG_KEY),
        count: 0,
        hasMore: false,
        nextCursor: null
      })
    })

    test('should return an array of metadata objects newest first when multiple documents found', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}`
      })

      expect(response.result.data).toBeInstanceOf(Array)
      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(response.result.data.length).toBe(2)
      // newest first: the second document inserted is returned first
      expect(response.result.data).toStrictEqual([{
        _id: expect.anything(),
        metadata: mockMetadataResponse[1].metadata,
        file: mockMetadataResponse[1].file
      },
      {
        _id: expect.anything(),
        metadata: mockMetadataResponse[0].metadata,
        file: mockMetadataResponse[0].file
      }])
    })

    test('should not expose messaging.correlationId in each returned record', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}`
      })

      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
      expect(response.result.data[0].messaging).toBeUndefined()
      expect(response.result.data[1].messaging).toBeUndefined()
    })

    test('should return null and 404 status when no documents found', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const unknownSbi = 123456789
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${unknownSbi}`
      })

      expect(response.result.statusCode).toBe(httpConstants.HTTP_STATUS_NOT_FOUND)
      expect(response.result.error).toBe('Not Found')
      expect(response.result.message).toBe('No documents found')
    })

    test('should return 400 bad request when invalid sbi used', async () => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const invalidSbi = 'not-an-sbi'
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${invalidSbi}`
      })

      expect(response.result.statusCode).toBe(httpConstants.HTTP_STATUS_BAD_REQUEST)
      expect(response.result.error).toBe('Bad Request')
      expect(response.result.message).toBe('Invalid SBI format')
    })

    test.each([
      ['a page size above the configured maximum', () => `pageSize=${config.get('mongo.metadataSbiMaxPageSize') + 1}`],
      ['a page size of 0', () => 'pageSize=0'],
      ['a non numeric page size', () => 'pageSize=ten'],
      ['a non hex cursor', () => 'after=zzf9c1e2a3b4c5d6e7f80912'],
      ['a 23 character cursor', () => 'after=66f9c1e2a3b4c5d6e7f8091']
    ])('should return 400 bad request for %s', async (_description, buildQuery) => {
      await db.collection(collection).insertMany(mockMetadataResponse)

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}?${buildQuery()}`
      })

      expect(response.result.statusCode).toBe(httpConstants.HTTP_STATUS_BAD_REQUEST)
      expect(response.result.error).toBe('Bad Request')
      expect(response.result.validation.source).toBe('query')
    })

    test('should return 500 without exposing the record when a stored record fails response validation', async () => {
      const invalidCrn = 12345
      await db.collection(collection).insertOne({
        ...mockMetadataResponse[0],
        metadata: { ...mockMetadataResponse[0].metadata, crn: invalidCrn }
      })

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/metadata/sbi/${sbi}`
      })

      expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR)
      expect(response.result.message).toBe('An internal server error occurred')
      expect(response.payload).not.toContain(String(invalidCrn))
    })

    test('should return 500 server error when db is unavailable', async () => {
      await db.client.close()

      const errorServer = await createServer()
      const response = await errorServer.inject({
        method: 'GET',
        url: '/api/v1/metadata/sbi/123456789'
      })

      expect(response.result.statusCode).toBe(httpConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR)
      expect(response.result.error).toBe('Internal Server Error')
      expect(response.result.message).toBe('An internal server error occurred')

      await db.client.connect() // reconnect to allow test clean up
    })
  })
})

const assertEmptyReadEvent = (event, sbi) => {
  assertValidAuditEvent(event)
  expect(event.audit.entities).toEqual([{ entity: 'document', action: 'read' }])
  expect(event.audit.accounts).toEqual({ sbi: String(sbi) })
  expect(event.audit.status).toBe('success')
  expect(event.audit.details).toEqual({ count: 0, pageSize: config.get(PAGE_SIZE_CONFIG_KEY) })
  expect(JSON.stringify(event)).not.toContain('crn')
}

describe('GET /api/v1/metadata/sbi/{sbi} — audit event schema validation', async () => {
  let auditServer

  beforeAll(async () => {
    auditServer = await createServer()
    await auditServer.initialize()

    await db.collection(collection).deleteMany({})
    await db.collection(collection).insertMany(mockMetadataResponse)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    if (auditServer && typeof auditServer.stop === 'function') {
      await auditServer.stop()
    }
    await db.collection(collection).deleteMany({})
  })

  test('emits exactly one schema-valid document/read event listing every returned document', async () => {
    capturedAuditEvents.length = 0
    const sbi = mockMetadataResponse[0].metadata.sbi

    const response = await auditServer.inject({
      method: 'GET',
      url: `/api/v1/metadata/sbi/${sbi}`
    })

    expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
    expect(capturedAuditEvents).toHaveLength(1)

    const [event] = capturedAuditEvents
    assertValidAuditEvent(event)
    expect(event.audit.status).toBe('success')
    expect(event.audit.accounts).toEqual({ sbi: String(sbi) })
    expect(event.audit.details).toEqual({
      count: mockMetadataResponse.length,
      pageSize: config.get(PAGE_SIZE_CONFIG_KEY)
    })
    expect(event.audit.entities).toHaveLength(mockMetadataResponse.length)
    expect(event.audit.entities).toEqual(
      response.result.data.map(doc => ({ entity: 'document', action: 'read', entityid: doc.file.fileId }))
    )
  })

  test('emits a document/read event that carries no CRN', async () => {
    capturedAuditEvents.length = 0
    const { sbi, crn } = mockMetadataResponse[0].metadata

    await auditServer.inject({
      method: 'GET',
      url: `/api/v1/metadata/sbi/${sbi}`
    })

    expect(capturedAuditEvents).toHaveLength(1)
    const serialised = JSON.stringify(capturedAuditEvents[0])
    expect(serialised).not.toContain('crn')
    expect(serialised).not.toContain(String(crn))
  })

  test('emits exactly one schema-valid empty read event for an empty page, which is still returned with 200', async () => {
    capturedAuditEvents.length = 0
    const sbi = mockMetadataResponse[0].metadata.sbi
    const olderThanEveryRecord = '000000000000000000000000'

    const response = await auditServer.inject({
      method: 'GET',
      url: `/api/v1/metadata/sbi/${sbi}?after=${olderThanEveryRecord}`
    })

    expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_OK)
    expect(response.result.data).toEqual([])
    expect(capturedAuditEvents).toHaveLength(1)
    assertEmptyReadEvent(capturedAuditEvents[0], sbi)
  })

  test('emits exactly one schema-valid empty read event for an SBI with no documents, which still returns 404', async () => {
    capturedAuditEvents.length = 0
    const unknownSbi = 123456789

    const response = await auditServer.inject({
      method: 'GET',
      url: `/api/v1/metadata/sbi/${unknownSbi}`
    })

    expect(response.statusCode).toBe(httpConstants.HTTP_STATUS_NOT_FOUND)
    expect(capturedAuditEvents).toHaveLength(1)
    assertEmptyReadEvent(capturedAuditEvents[0], unknownSbi)
  })
})
