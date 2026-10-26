import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DELIVERY_OUTCOME } from '../../../../src/constants/outbox.js'

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  loggerWarn: vi.fn(),
  configGet: vi.fn((key) => {
    switch (key) {
      case 'mongo.collections.outbox': return 'outbox'
      case 'mongo.outboxQueryLimit': return 2
      case 'messaging.outboxMaxAttempts': return 3
      case 'messaging.outboxClaimLeaseMs': return 300000
      default: return null
    }
  })
}))

vi.mock('../../../src/config/index.js', () => ({
  config: { get: mocks.configGet }
}))

vi.mock('../../../src/data/db.js', () => {
  const db = { collection: mocks.collection }
  return { getDb: () => db }
})

vi.mock('../../../src/logging/logger.js', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn })
}))

vi.mock('../../../src/messaging/outbound/audit/send-audit-event.js', () => ({
  sendAuditEvent: vi.fn()
}))

const {
  claimProcessableOutboxEntries,
  finalizeClaimedOutboxEntries,
  getPendingOutboxMetrics
} = await import('../../../src/repos/outbox.js')

describe('outbox claims', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('atomically claims eligible entries oldest first up to the query limit', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    const claimedUntil = new Date('2026-08-07T10:05:00.000Z')
    const findOneAndUpdate = vi.fn()
      .mockResolvedValueOnce({ _id: 'entry-1', status: 'PENDING', createdAt: new Date('2026-08-07T09:00:00.000Z') })
      .mockResolvedValueOnce({ _id: 'entry-2', status: 'PENDING', createdAt: new Date('2026-08-07T09:01:00.000Z') })
    mocks.collection.mockReturnValue({ findOneAndUpdate })

    const result = await claimProcessableOutboxEntries('worker-1', now)

    expect(findOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(findOneAndUpdate).toHaveBeenCalledWith({
      attempts: { $lt: 3 },
      $or: [
        { status: 'PENDING' },
        { status: 'PROCESSING', claimedUntil: { $lt: now } }
      ]
    }, {
      $set: {
        status: 'PROCESSING',
        claimedAt: now,
        claimedUntil,
        claimedBy: 'worker-1'
      },
      $inc: { attempts: 1 }
    }, {
      sort: { createdAt: 1 },
      returnDocument: 'before'
    })
    expect(result).toEqual([
      expect.objectContaining({ _id: 'entry-1', status: 'PROCESSING', claimedBy: 'worker-1', claimedUntil }),
      expect.objectContaining({ _id: 'entry-2', status: 'PROCESSING', claimedBy: 'worker-1', claimedUntil })
    ])
  })

  test('stops claiming when no eligible entry remains', async () => {
    const findOneAndUpdate = vi.fn()
      .mockResolvedValueOnce({ _id: 'entry-1', status: 'PENDING' })
      .mockResolvedValueOnce(null)
    mocks.collection.mockReturnValue({ findOneAndUpdate })

    const result = await claimProcessableOutboxEntries('worker-1')

    expect(result).toHaveLength(1)
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2)
  })

  test('does not reclaim a PERMANENT_FAILURE entry even when attempts are below the limit', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    const permanentFailureDoc = { status: 'PERMANENT_FAILURE', attempts: 1 }
    // Mirrors Mongo's own filter matching so this proves the $or on status - not attempts - excludes the doc.
    const findOneAndUpdate = vi.fn().mockImplementation((filter) => {
      const matchesStatus = filter.$or.some(condition => condition.status === permanentFailureDoc.status)
      const matchesAttempts = permanentFailureDoc.attempts < filter.attempts.$lt
      return Promise.resolve(matchesStatus && matchesAttempts ? permanentFailureDoc : null)
    })
    mocks.collection.mockReturnValue({ findOneAndUpdate })

    const result = await claimProcessableOutboxEntries('worker-1', now)

    expect(result).toEqual([])
  })

  test('logs when an expired processing claim is reclaimed', async () => {
    const expiredClaim = {
      _id: { toString: () => 'entry-1' },
      status: 'PROCESSING',
      payload: { file: { fileId: 'file-1' }, messaging: { correlationId: 'correlation-1' } },
      claimedBy: 'worker-old',
      claimedUntil: new Date('2026-08-07T09:59:00.000Z')
    }
    mocks.collection.mockReturnValue({
      findOneAndUpdate: vi.fn()
        .mockResolvedValueOnce(expiredClaim)
        .mockResolvedValueOnce(null)
    })

    await claimProcessableOutboxEntries('worker-new', new Date('2026-08-07T10:00:00.000Z'))

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      {
        event: {
          type: 'outbox_claim_reclaimed',
          action: 'reclaim_expired_claim',
          reference: 'entry-1',
          outcome: 'success',
          created: new Date('2026-08-07T10:00:00.000Z'),
          duration: 300000000000,
          reason: 'expired_claim previousOwner=worker-old previousClaimedUntil=2026-08-07T09:59:00.000Z'
        },
        process: { name: 'worker-new' }
      },
      'Reclaimed expired outbox claim; entryId=file-1'
    )
  })

  test('finalizes successful entries only while the worker owns a valid claim', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    const updateMany = vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 2 })
    mocks.collection.mockReturnValue({ updateMany })
    const session = { id: 'session-1' }

    const result = await finalizeClaimedOutboxEntries(
      session,
      ['entry-1', 'entry-2'],
      'worker-1',
      DELIVERY_OUTCOME.SUCCEEDED,
      null,
      now
    )

    expect(updateMany).toHaveBeenCalledWith({
      _id: { $in: ['entry-1', 'entry-2'] },
      status: 'PROCESSING',
      claimedBy: 'worker-1',
      claimedUntil: { $gt: now }
    }, {
      $set: { status: 'SENT', lastAttemptedAt: now },
      $unset: { claimedAt: '', claimedUntil: '', claimedBy: '', error: '' }
    }, { session })
    expect(result.matchedCount).toBe(2)
  })

  test('finalizes failed attempts with retry and terminal status pipeline', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    const updateMany = vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 })
    mocks.collection.mockReturnValue({ updateMany })

    const result = await finalizeClaimedOutboxEntries(
      null,
      ['entry-1'],
      'worker-1',
      DELIVERY_OUTCOME.FAILED,
      'SNS unavailable',
      now
    )

    expect(updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['entry-1'] },
        status: 'PROCESSING',
        claimedBy: 'worker-1',
        claimedUntil: { $gt: now }
      },
      [
        {
          $set: {
            lastAttemptedAt: now,
            error: 'SNS unavailable'
          }
        },
        {
          $set: {
            status: { $cond: [{ $gte: ['$attempts', 3] }, 'PERMANENT_FAILURE', 'PENDING'] }
          }
        },
        { $unset: ['claimedAt', 'claimedUntil', 'claimedBy'] }
      ],
      {}
    )
    expect(result).toEqual({ acknowledged: true, matchedCount: 1 })
  })

  test('returns matchedCount 0 when FAILED entry claim has expired', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    const updateMany = vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 0 })
    mocks.collection.mockReturnValue({ updateMany })

    const result = await finalizeClaimedOutboxEntries(null, ['entry-1'], 'worker-1', DELIVERY_OUTCOME.FAILED, null, now)

    expect(result).toEqual({ acknowledged: true, matchedCount: 0 })
  })

  test('rejects an unsupported delivery outcome', async () => {
    mocks.collection.mockReturnValue({ updateMany: vi.fn() })

    await expect(finalizeClaimedOutboxEntries(
      null,
      ['entry-1'],
      'worker-1',
      'PROCESSING'
    )).rejects.toThrow('Unsupported delivery outcome: PROCESSING')
  })

  test('throws when finalization is not acknowledged', async () => {
    mocks.collection.mockReturnValue({
      updateMany: vi.fn().mockResolvedValue({ acknowledged: false })
    })

    await expect(finalizeClaimedOutboxEntries(
      null,
      ['entry-1'],
      'worker-1',
      DELIVERY_OUTCOME.SUCCEEDED
    )).rejects.toThrow('Failed to finalize claimed outbox entries')
  })

  test('throws when failed-attempt finalization is not acknowledged', async () => {
    mocks.collection.mockReturnValue({
      updateMany: vi.fn().mockResolvedValue({ acknowledged: false })
    })

    await expect(finalizeClaimedOutboxEntries(
      null,
      ['entry-1'],
      'worker-1',
      DELIVERY_OUTCOME.FAILED
    )).rejects.toThrow('Failed to finalize claimed outbox entries')
  })
})

describe('getPendingOutboxMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('returns count and oldest pending entry timestamp', async () => {
    const oldestCreatedAt = new Date('2026-08-07T09:00:00.000Z')
    const next = vi.fn().mockResolvedValue({ createdAt: oldestCreatedAt })
    const project = vi.fn().mockReturnValue({ next })
    const limit = vi.fn().mockReturnValue({ project })
    const sort = vi.fn().mockReturnValue({ limit })
    const find = vi.fn().mockReturnValue({ sort })
    const aggregate = vi.fn().mockReturnValue({ next: vi.fn().mockResolvedValue({ n: 3 }) })
    mocks.collection.mockReturnValue({ aggregate, find })

    await expect(getPendingOutboxMetrics()).resolves.toEqual({
      count: 3,
      oldestCreatedAt
    })
    expect(find).toHaveBeenCalledWith({ status: { $in: ['PENDING', 'PROCESSING'] } })
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 })
    expect(limit).toHaveBeenCalledWith(1)
    expect(project).toHaveBeenCalledWith({ _id: 0, createdAt: 1 })
  })

  test('returns null timestamp when no pending entry exists', async () => {
    const next = vi.fn().mockResolvedValue(null)
    const project = vi.fn().mockReturnValue({ next })
    const limit = vi.fn().mockReturnValue({ project })
    const sort = vi.fn().mockReturnValue({ limit })
    const find = vi.fn().mockReturnValue({ sort })
    mocks.collection.mockReturnValue({
      aggregate: vi.fn().mockReturnValue({ next: vi.fn().mockResolvedValue(null) }),
      find
    })

    await expect(getPendingOutboxMetrics()).resolves.toEqual({
      count: 0,
      oldestCreatedAt: null
    })
  })
})
