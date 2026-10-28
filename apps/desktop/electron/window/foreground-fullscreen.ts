import { spawn, type ChildProcess } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { shouldHideForFullscreen, type ForegroundWindowInfo } from './fullscreen-detect'

export { coversDisplay } from './fullscreen-detect'

interface FullscreenSample extends ForegroundWindowInfo {
  monitorLeft: number
  monitorTop: number
  monitorRight: number
  monitorBottom: number
}

/**
 * 每 200ms 上报一次"前台根窗口"相对灵动岛所在显示器的信息。
 * 判定在 fullscreen-detect.ts（纯函数）：桌面整理助手的面板是挂在桌面下的
 * 子窗口（根为 Progman）且带 WS_EX_TOOLWINDOW，不能被当成全屏应用。
 */
const SCRIPT = (islandHandle: string) => `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$islandHandle = [IntPtr]::new([long]${islandHandle})

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandForeground {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", EntryPoint="GetMonitorInfoW", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  public static bool GetIslandMonitorBounds(IntPtr hWnd, out RECT rect) {
    rect = new RECT(); IntPtr monitor = MonitorFromWindow(hWnd, 2);
    if (monitor == IntPtr.Zero) return false;
    MONITORINFO info = new MONITORINFO(); info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(monitor, ref info)) return false;
    rect = info.rcMonitor; return true;
  }
}
'@

while ($true) {
  $monitor = New-Object IslandForeground+RECT
  if (-not [IslandForeground]::GetIslandMonitorBounds($islandHandle, [ref]$monitor)) {
    [Console]::Out.WriteLine('-')
    [System.Threading.Thread]::Sleep(200)
    continue
  }
  $fg = [IslandForeground]::GetForegroundWindow()
  # GA_ROOT：点击桌面整理面板时前台是它的子窗口，取根窗口才能看出它属于桌面。
  $hwnd = if ($fg -eq [IntPtr]::Zero) { [IntPtr]::Zero } else { [IslandForeground]::GetAncestor($fg, 2) }
  if ($hwnd -eq [IntPtr]::Zero) {
    [Console]::Out.WriteLine('-')
  } else {
    $class = New-Object System.Text.StringBuilder 128
    [void][IslandForeground]::GetClassName($hwnd, $class, $class.Capacity)
    $rect = New-Object IslandForeground+RECT
    if ([IslandForeground]::GetWindowRect($hwnd, [ref]$rect)) {
      $obj = [ordered]@{
        className = $class.ToString()
        exStyle   = [IslandForeground]::GetWindowLongPtr($hwnd, -20).ToInt64()
        style     = [IslandForeground]::GetWindowLongPtr($hwnd, -16).ToInt64()
        zoomed    = [IslandForeground]::IsZoomed($hwnd)
        owner     = [IslandForeground]::GetWindow($hwnd, 4).ToInt64()
        visible   = [IslandForeground]::IsWindowVisible($hwnd)
        iconic    = [IslandForeground]::IsIconic($hwnd)
        left      = $rect.Left
        top       = $rect.Top
        right     = $rect.Right
        bottom    = $rect.Bottom
        monitorLeft = $monitor.Left
        monitorTop = $monitor.Top
        monitorRight = $monitor.Right
        monitorBottom = $monitor.Bottom
      }
      [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    } else {
      [Console]::Out.WriteLine('-')
    }
  }
  [System.Threading.Thread]::Sleep(200)
}
`

/** 进入全屏要稳定一小段时间；退出时短暂防抖后立即恢复。 */
const HIDE_DELAY_MS = 500
const RESTORE_DELAY_MS = 200

export class ForegroundFullscreenMonitor {
  private child: ChildProcess | null = null
  private buffer = ''
  private current = false
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly window: BrowserWindow, private readonly onChange: (fullscreen: boolean) => void) {}

  start(): void {
    if (process.platform !== 'win32' || this.child) return
    const handle = this.window.getNativeWindowHandle()
    const islandHandle = (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString()
    const encoded = Buffer.from(SCRIPT(islandHandle), 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    this.child = child
    child.stdout?.on('data', chunk => {
      this.buffer += String(chunk)
      const lines = this.buffer.split(/\r?\n/)
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (process.env.ISLAND_FULLSCREEN_DEBUG) console.log('[fullscreen]', trimmed)
        if (!trimmed || trimmed === '-') { this.update(false); continue }
        let info: FullscreenSample | null = null
        try { info = JSON.parse(trimmed) as FullscreenSample } catch { info = null }
        const targetBounds = info ? {
          x: info.monitorLeft,
          y: info.monitorTop,
          width: info.monitorRight - info.monitorLeft,
          height: info.monitorBottom - info.monitorTop,
        } : null
        // Win32 supplies both rectangles in the same coordinate system. The
        // island's monitor is queried live, so moving it between displays is safe.
        this.update(targetBounds ? shouldHideForFullscreen(info, targetBounds) : false)
      }
    })
    child.on('error', () => { this.child = null; this.update(false) })
    child.on('close', () => { if (this.child === child) { this.child = null; this.update(false) } })
  }

  private update(fullscreen: boolean): void {
    if (fullscreen === this.current) {
      if (this.pending) { clearTimeout(this.pending); this.pending = null }
      return
    }
    if (this.pending) { clearTimeout(this.pending); this.pending = null }
    this.pending = setTimeout(() => {
      this.pending = null
      this.current = fullscreen
      this.onChange(fullscreen)
    }, fullscreen ? HIDE_DELAY_MS : RESTORE_DELAY_MS)
  }

  stop(): void {
    if (this.pending) { clearTimeout(this.pending); this.pending = null }
    const child = this.child
    this.child = null
    if (child) child.kill()
  }
}
