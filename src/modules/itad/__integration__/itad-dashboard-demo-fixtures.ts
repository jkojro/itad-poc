import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type APIRequestContext } from '@playwright/test'
import { createCompanyFixture, createPersonFixture } from '@open-mercato/core/helpers/integration/crmFixtures'
import { CONFIRM, advanceToReceiving, createJob, transitionOk } from './itad-job-fixtures'
import { importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'
import { currentAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { issueCertificateOk, passAsset } from './itad-certificate-fixtures'

/**
 * Operations dashboard demo ("Przygotowanie dashboardu do demo"): seven customers and jobs,
 * each stopped at the state the demo shows — four needing attention, one in progress, two
 * upcoming. Built through the ITAD APIs only (same commands, events and audit as the UI);
 * nothing is cleaned up. The manifests are the demo package's, kept next to this file.
 */

const MANIFESTS = path.resolve(process.cwd(), 'src/modules/itad/__integration__/demo-dashboard-manifests')
const MAPPING = { serial: 'Serial', customerAssetTag: 'Asset Tag', manufacturer: 'Manufacturer', model: 'Model', dataBearing: 'Carries Data' }

function manifest(file: string) {
  return { name: file, content: readFileSync(path.join(MANIFESTS, file), 'utf8').replace(/^﻿/, '') }
}

type Contact = { firstName: string; lastName: string; email: string }

async function customer(request: APIRequestContext, token: string, name: string, contact: Contact): Promise<string> {
  const companyId = await createCompanyFixture(request, token, name)
  await createPersonFixture(request, token, {
    firstName: contact.firstName,
    lastName: contact.lastName,
    displayName: `${contact.firstName} ${contact.lastName}`,
    companyEntityId: companyId,
    primaryEmail: contact.email,
  })
  return companyId
}

/** A local Warsaw time as an ISO instant (the demo dates fall after the DST change: UTC+1). */
const warsaw = (local: string) => new Date(`${local}:00+01:00`).toISOString()
/** Jobs already past pickup still need a valid future time to be created and scheduled. */
const soon = () => new Date(Date.now() + 15 * 60_000).toISOString()

async function scanAll(request: APIRequestContext, token: string, jobId: string, serials: string[]): Promise<void> {
  for (const serial of serials) await scanOk(request, token, jobId, serial)
}

const range = (prefix: string, from: number, to: number, width = 3) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${String(from + index).padStart(width, '0')}`)

export type DashboardDemoJob = { customer: string; job: string; reference: string; status: string; jobId: string }

async function created(request: APIRequestContext, token: string, input: {
  customerId: string
  customerName: string
  name: string
  customerReference: string
  scheduledPickupAt: string
  defaultDataBearing?: boolean
  expectedAssetEstimate?: number
  manifestFile: string
}) {
  const job = await createJob(request, token, {
    customerId: input.customerId,
    name: input.name,
    customerReference: input.customerReference,
    scheduledPickupAt: input.scheduledPickupAt,
    ...(input.expectedAssetEstimate ? { expectedAssetEstimate: input.expectedAssetEstimate } : {}),
    ...(input.defaultDataBearing !== undefined ? { defaultDataBearing: input.defaultDataBearing } : {}),
  })
  await importManifestOk(request, token, job.id, manifest(input.manifestFile), MAPPING)
  return job
}

export async function seedDashboardDemo(request: APIRequestContext, token: string): Promise<DashboardDemoJob[]> {
  const result: DashboardDemoJob[] = []
  const done = (customerName: string, name: string, job: { id: string; internalReference: string }, status: string) =>
    result.push({ customer: customerName, job: name, reference: job.internalReference, status, jobId: job.id })

  // 1. GreenField School — upcoming: scheduled, manifest ready, nothing received.
  {
    const customerName = 'GreenField School'
    const customerId = await customer(request, token, customerName, { firstName: 'Emma', lastName: 'Clarke', email: 'emma.clarke@greenfield-school.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Chromebook Collection', customerReference: 'ITAD-DEMO-GREENFIELD',
      scheduledPickupAt: warsaw('2026-10-28T09:00'), expectedAssetEstimate: 12, manifestFile: '06_GreenField_School_Chromebook_Collection.csv',
    })
    expect(await transitionOk(request, token, job.id, { action: 'schedule' })).toBe('scheduled')
    done(customerName, 'Chromebook Collection', job, 'scheduled')
  }

  // 2. CityMed Clinics — upcoming: data-bearing and non-data-bearing mix.
  {
    const customerName = 'CityMed Clinics'
    const customerId = await customer(request, token, customerName, { firstName: 'Daniel', lastName: 'Hughes', email: 'daniel.hughes@citymed.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Workstation Disposal', customerReference: 'ITAD-DEMO-CITYMED',
      scheduledPickupAt: warsaw('2026-11-02T11:00'), expectedAssetEstimate: 8, manifestFile: '07_CityMed_Workstation_Disposal.csv',
    })
    expect(await transitionOk(request, token, job.id, { action: 'schedule' })).toBe('scheduled')
    done(customerName, 'Workstation Disposal', job, 'scheduled')
  }

  // 3. Nordea — in progress: receiving 18/20, no exception (receiving is not finished).
  {
    const customerName = 'Nordea'
    const customerId = await customer(request, token, customerName, { firstName: 'Lars', lastName: 'Nielsen', email: 'lars.nielsen@nordea.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Branch Device Refresh', customerReference: 'ITAD-DEMO-NORDEA',
      scheduledPickupAt: soon(), manifestFile: '02_Nordea_Branch_Device_Refresh.csv',
    })
    await advanceToReceiving(request, token, job.id)
    await scanAll(request, token, job.id, range('NOR-LT-', 1, 18))
    done(customerName, 'Branch Device Refresh', job, 'receiving')
  }

  // 4. Fabrikam Logistics — processing with one open unexpected asset, nothing missing.
  {
    const customerName = 'Fabrikam Logistics'
    const customerId = await customer(request, token, customerName, { firstName: 'Megan', lastName: 'Bowen', email: 'megan.bowen@fabrikam.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Warehouse Scanner Refresh', customerReference: 'ITAD-DEMO-FABRIKAM',
      scheduledPickupAt: soon(), manifestFile: '04_Fabrikam_Warehouse_Scanner_Refresh.csv',
    })
    await advanceToReceiving(request, token, job.id)
    await scanAll(request, token, job.id, [...range('FAB-SCN-', 1, 7), 'FAB-EXTRA-001'])
    // The unexpected scanner has no manifest value and no job default: classify it as not carrying data.
    await classifyUndecided(request, token, job.id, false)
    expect(await transitionOk(request, token, job.id, { action: 'start_processing' })).toBe('processing')
    done(customerName, 'Warehouse Scanner Refresh', job, 'processing')
  }

  // 5. Alpine Energy — receiving with an unresolved duplicate scan.
  {
    const customerName = 'Alpine Energy'
    const customerId = await customer(request, token, customerName, { firstName: 'Sofia', lastName: 'Brunner', email: 'sofia.brunner@alpine-energy.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Field Laptop Return', customerReference: 'ITAD-DEMO-ALPINE',
      scheduledPickupAt: soon(), manifestFile: '05_Alpine_Energy_Field_Laptop_Return.csv',
    })
    await advanceToReceiving(request, token, job.id)
    await scanAll(request, token, job.id, ['ALP-LT-001', 'ALP-LT-002', 'ALP-LT-003'])
    expect((await scanOk(request, token, job.id, 'ALP-LT-002')).result).toBe('DUPLICATE')
    done(customerName, 'Field Laptop Return', job, 'receiving')
  }

  // 6. Contoso — closeout review: all 6 wiped, 5 of 6 certificates issued.
  {
    const customerName = 'Contoso'
    const customerId = await customer(request, token, customerName, { firstName: 'Olivia', lastName: 'Grant', email: 'olivia.grant@contoso.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Executive Laptop Refresh', customerReference: 'ITAD-DEMO-CONTOSO',
      scheduledPickupAt: soon(), manifestFile: '03_Contoso_Executive_Laptop_Refresh.csv',
    })
    const serials = range('CON-EXE-', 1, 6)
    await advanceToReceiving(request, token, job.id)
    await scanAll(request, token, job.id, serials)
    expect(await transitionOk(request, token, job.id, { action: 'start_processing' })).toBe('processing')
    for (const serial of serials) await passAsset(request, token, job.id, (await currentAssets(request, token, job.id, [serial]))[0])
    for (const asset of await currentAssets(request, token, job.id, serials.slice(0, 5))) await issueCertificateOk(request, token, job.id, asset.id)
    expect(await transitionOk(request, token, job.id, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')
    done(customerName, 'Executive Laptop Refresh', job, 'closeout_review')
  }

  // 7. ACME Bank — the main demo job, prepared last: processing with a failed wipe, a missing
  //    and an unexpected device (3 open exceptions) and four devices already wiped.
  {
    const customerName = 'ACME Bank'
    const customerId = await customer(request, token, customerName, { firstName: 'Anna', lastName: 'Kowalska', email: 'anna.kowalska@acmebank.example' })
    const job = await created(request, token, {
      customerId, customerName, name: 'Laptop Refresh Q4', customerReference: 'ITAD-DEMO-ACME',
      scheduledPickupAt: soon(), defaultDataBearing: true, manifestFile: '01_ACME_Bank_Laptop_Refresh_Q4.csv',
    })
    await advanceToReceiving(request, token, job.id)
    await scanAll(request, token, job.id, ['ABC123', ...range('ACME-LT-', 2, 9), 'ACME-EXTRA-9001'])
    expect(await transitionOk(request, token, job.id, { action: 'start_processing' })).toBe('processing')
    for (const serial of range('ACME-LT-', 2, 5)) await passAsset(request, token, job.id, (await currentAssets(request, token, job.id, [serial]))[0])
    const [failed] = await currentAssets(request, token, job.id, ['ABC123'])
    const runId = await startRunOk(request, token, job.id, failed)
    const response = await recordResult(request, token, job.id, runId, {
      result: 'FAIL',
      verificationMethod: 'full_verification',
      verificationNotes: 'Verification failed - residual data detected',
    })
    expect(response.status(), await response.text()).toBe(200)
    done(customerName, 'Laptop Refresh Q4', job, 'processing')
  }

  return result
}
