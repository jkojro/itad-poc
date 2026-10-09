/** Client shapes of the receiving API responses (see the route `openApi` schemas). */
export type ScanOutcome = 'MATCHED' | 'UNEXPECTED' | 'DUPLICATE'

export type ScanResponse = {
  result: ScanOutcome
  scan: { id: string; rawSerial: string; scannedAt: string }
  asset: {
    id: string
    serial: string
    customerAssetTag: string | null
    manufacturer: string | null
    model: string | null
    deleted: boolean
  }
  manifestItem: { id: string; serial: string } | null
}

type Actor = { id: string; name: string | null } | null

export type ScanListItem = {
  id: string
  rawSerial: string
  result: 'matched' | 'unexpected' | 'duplicate'
  scannedAt: string
  scannedBy: Actor
  asset: { id: string; serial: string; deleted: boolean }
  manifestItemId: string | null
  pending: boolean
  resolution: string | null
  resolutionNote: string | null
  resolvedAt: string | null
  resolvedBy: Actor
  flaggedDifferentDeviceAt: string | null
  flaggedDifferentDeviceBy: Actor
  flaggedDifferentDeviceNote: string | null
}

export type AssetRow = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  dataBearing: boolean | null
  status: string
  manifestItemId: string | null
  reconciliation: 'matched' | 'unexpected'
  receivedAt: string
  receivedBy: { id: string; name: string | null }
  updatedAt: string
}
