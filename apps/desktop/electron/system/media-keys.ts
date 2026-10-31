import { spawn } from 'node:child_process'

export function sendMediaKey(action: 'previous' | 'toggle' | 'next'): void {
  if (process.platform !== 'win32') return
  const key = action === 'previous' ? 0xB1 : action === 'next' ? 0xB0 : 0xB3
  const command = `$sig='[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'; Add-Type -MemberDefinition $sig -Name MediaKey -Namespace Native; [Native.MediaKey]::keybd_event(${key},0,1,[UIntPtr]::Zero); [Native.MediaKey]::keybd_event(${key},0,3,[UIntPtr]::Zero)`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' })
  child.unref()
}

