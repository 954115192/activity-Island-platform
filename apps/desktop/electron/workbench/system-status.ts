import os from 'node:os'
import { spawn } from 'node:child_process'

let previousCpu: { idle: number; total: number } | null = null
let previousNetwork: { received: number; sent: number; at: number } | null = null

export function cpuPercent(): number {
  const totals = os.cpus().reduce((result, cpu) => {
    const times = cpu.times
    result.idle += times.idle
    result.total += times.user + times.nice + times.sys + times.irq + times.idle
    return result
  }, { idle: 0, total: 0 })
  const old = previousCpu
  previousCpu = totals
  if (!old) return 0
  const totalDelta = totals.total - old.total
  return totalDelta > 0 ? Math.round(Math.max(0, Math.min(100, (1 - (totals.idle - old.idle) / totalDelta) * 100))) : 0
}
export async function networkStatus(): Promise<{ ok: boolean; downloadMbps: number; uploadMbps: number; latencyMs: number | null }> {
  if (process.platform !== 'win32') return { ok: false, downloadMbps: 0, uploadMbps: 0, latencyMs: null }
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout?.on('data', value => { output += String(value) })
    const finish = () => {
      try {
        const parsed = JSON.parse(output.trim())
        const rows = Array.isArray(parsed) ? parsed : [parsed]
        const received = rows.reduce((sum, row) => sum + Number(row?.ReceivedBytes || 0), 0)
        const sent = rows.reduce((sum, row) => sum + Number(row?.SentBytes || 0), 0)
        const at = Date.now(); const old = previousNetwork; previousNetwork = { received, sent, at }
        const seconds = old ? Math.max(0.001, (at - old.at) / 1000) : 1
        resolve({ ok: true, downloadMbps: old ? Math.max(0, (received - old.received) / seconds / 1024 / 1024) : 0, uploadMbps: old ? Math.max(0, (sent - old.sent) / seconds / 1024 / 1024) : 0, latencyMs: null })
      } catch { resolve({ ok: false, downloadMbps: 0, uploadMbps: 0, latencyMs: null }) }
    }
    child.on('close', finish); child.on('error', finish)
  })
}

