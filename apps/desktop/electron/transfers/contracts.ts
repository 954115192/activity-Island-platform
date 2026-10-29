/** 局域网传输契约 v1；LocalSend 线协议使用 v2。 */
export type TransferState = 'waiting' | 'transferring' | 'verifying' | 'completed' | 'rejected' | 'cancelled' | 'failed'

export interface NearbyDevice {
  id: string
  alias: string
  deviceType: string
  deviceModel: string
  host: string
  port: number
  protocol: 'http' | 'https'
  fingerprint: string
  lastSeen: number
}

export interface TransferFile {
  id: string
  fileName: string
  size: number
  fileType: string
  sha256?: string
  kind?: 'text'
  preview?: string
  text?: string
  canLocate?: boolean
}

export interface TransferSession {
  id: string
  direction: 'incoming' | 'outgoing'
  peer: string
  deviceId: string
  files: TransferFile[]
  state: TransferState
  bytes: number
  preparedBytes?: number
  currentFile?: string
  speedBytesPerSecond?: number
  speedUpdatedAt?: number
  canRetry?: boolean
  total: number
  createdAt: number
  error?: string
}

export interface TransferSnapshot {
  version: 1
  alias: string
  port: number
  addresses: string[]
  saveDirectory: string
  status: 'starting' | 'running' | 'error' | 'stopped'
  error?: string
  devices: NearbyDevice[]
  draft: TransferFile[]
  draftNotice?: string
  sessions: TransferSession[]
}
