import { describe, expect, it } from '@jest/globals'
import {
  findEditabilityViolation,
  getEditableFields,
  isTerminalStatus,
  type JobFieldValues,
} from '../job-editability'
import type { ItadJobStatus } from '../job-types'

const pickup = new Date('2026-10-10T08:00:00.000Z')

const current: JobFieldValues = {
  customerId: '11111111-1111-4111-8111-111111111111',
  name: 'Bank refresh',
  customerReference: 'NB-RET-1042',
  scheduledPickupAt: pickup,
  expectedAssetEstimate: 500,
  defaultDataBearing: null,
  pickupCoordinatorUserId: null,
}

const job = (status: ItadJobStatus, statusBeforeHold: ItadJobStatus | null = null) => ({ status, statusBeforeHold })

describe('getEditableFields (spec: Field editability by status)', () => {
  it.each([
    ['draft', ['customerId', 'name', 'customerReference', 'scheduledPickupAt', 'expectedAssetEstimate', 'defaultDataBearing', 'pickupCoordinatorUserId']],
    ['scheduled', ['name', 'customerReference', 'scheduledPickupAt', 'expectedAssetEstimate', 'defaultDataBearing', 'pickupCoordinatorUserId']],
    ['in_transit', ['name', 'customerReference', 'expectedAssetEstimate', 'defaultDataBearing']],
    ['receiving', ['name', 'customerReference', 'defaultDataBearing']],
    ['processing', ['name', 'customerReference']],
    ['closeout_review', ['name', 'customerReference']],
    ['completed', []],
    ['cancelled', []],
  ] as const)('%s', (status, expected) => {
    expect(getEditableFields(job(status))).toEqual(expected)
  })

  it('on_hold follows the pre-hold status column', () => {
    expect(getEditableFields(job('on_hold', 'in_transit'))).toEqual(getEditableFields(job('in_transit')))
    expect(getEditableFields(job('on_hold', 'scheduled'))).toEqual(getEditableFields(job('scheduled')))
  })
})

describe('findEditabilityViolation', () => {
  it('accepts unchanged locked values (CrudForm submits the whole form)', () => {
    expect(
      findEditabilityViolation(job('receiving'), current, {
        customerId: current.customerId,
        scheduledPickupAt: new Date(pickup.getTime()),
        expectedAssetEstimate: 500,
        name: 'Renamed',
      }),
    ).toBeNull()
  })

  it('lets the default dataBearing change and clear until receiving ends (sanitization spec Q11)', () => {
    expect(findEditabilityViolation(job('receiving'), current, { defaultDataBearing: true })).toBeNull()
    expect(findEditabilityViolation(job('receiving'), { ...current, defaultDataBearing: true }, { defaultDataBearing: null })).toBeNull()
    expect(findEditabilityViolation(job('processing'), current, { defaultDataBearing: true })).toEqual({
      field: 'defaultDataBearing',
      reason: 'locked',
    })
  })

  it('locks customerId after draft', () => {
    expect(
      findEditabilityViolation(job('scheduled'), current, { customerId: '22222222-2222-4222-8222-222222222222' }),
    ).toEqual({ field: 'customerId', reason: 'locked' })
  })

  it('allows clearing scheduledPickupAt only in draft', () => {
    expect(findEditabilityViolation(job('draft'), current, { scheduledPickupAt: null })).toBeNull()
    expect(findEditabilityViolation(job('scheduled'), current, { scheduledPickupAt: null })).toEqual({
      field: 'scheduledPickupAt',
      reason: 'not_clearable',
    })
  })

  it('locks scheduledPickupAt from in_transit and the estimate from receiving', () => {
    const later = new Date('2026-10-11T08:00:00.000Z')
    expect(findEditabilityViolation(job('in_transit'), current, { scheduledPickupAt: later })).toEqual({
      field: 'scheduledPickupAt',
      reason: 'locked',
    })
    expect(findEditabilityViolation(job('in_transit'), current, { expectedAssetEstimate: 487 })).toBeNull()
    expect(findEditabilityViolation(job('receiving'), current, { expectedAssetEstimate: 487 })).toEqual({
      field: 'expectedAssetEstimate',
      reason: 'locked',
    })
  })

  it('applies the pre-hold column while on hold', () => {
    expect(findEditabilityViolation(job('on_hold', 'scheduled'), current, { expectedAssetEstimate: 10 })).toBeNull()
    expect(
      findEditabilityViolation(job('on_hold', 'receiving'), current, { expectedAssetEstimate: 10 }),
    ).toEqual({ field: 'expectedAssetEstimate', reason: 'locked' })
  })
})

describe('isTerminalStatus', () => {
  it('flags only completed and cancelled', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('on_hold')).toBe(false)
    expect(isTerminalStatus('draft')).toBe(false)
  })
})

describe('pickupCoordinatorUserId (pickup calendar spec REQ-513)', () => {
  const coordinator = '33333333-3333-4333-8333-333333333333'

  it('can be set and cleared while draft or scheduled, also on hold from scheduled', () => {
    for (const subject of [job('draft'), job('scheduled'), job('on_hold', 'scheduled')]) {
      expect(findEditabilityViolation(subject, current, { pickupCoordinatorUserId: coordinator })).toBeNull()
      expect(findEditabilityViolation(subject, { ...current, pickupCoordinatorUserId: coordinator }, { pickupCoordinatorUserId: null })).toBeNull()
    }
  })

  it('is locked once the pickup happened', () => {
    expect(findEditabilityViolation(job('in_transit'), current, { pickupCoordinatorUserId: coordinator })).toEqual({
      field: 'pickupCoordinatorUserId',
      reason: 'locked',
    })
  })
})
