import { spawn, type ChildProcess } from 'node:child_process'
import { screen } from 'electron'
import { shouldHideForFullscreen, type ForegroundWindowInfo } from './fullscreen-detect'

export { coversDisplay } from './fullscreen-detect'

/**
 * 每 500ms 上报一次"前台根窗口"的 class / exStyle / owner / 可见性 / 矩形。
 * 判定在 fullscreen-detect.ts（纯函数）：桌面整理助手的面板是挂在桌面下的
 * 子窗口（根为 Progman）且带 WS_EX_TOOLWINDOW，不能被当成全屏应用。
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandForeground {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@

while ($true) {
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
        owner     = [IslandForeground]::GetWindow($hwnd, 4).ToInt64()
        visible   = [IslandForeground]::IsWindowVisible($hwnd)
        iconic    = [IslandForeground]::IsIconic($hwnd)
        left      = $rect.Left
        top       = $rect.Top
        right     = $rect.Right
        bottom    = $rect.Bottom
      }
      [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    } else {
      [Console]::Out.WriteLine('-')
    }
  }
  [System.Threading.Thread]::Sleep(500)
}
`

/** 全屏状态要持续这么久才真的隐藏小岛，避免点击/切换瞬间闪一下。 */
const HIDE_DELAY_MS = 700

export class ForegroundFullscreenMonitor {
  private child: ChildProcess | null = null
  private buffer = ''
  private current = false
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onChange: (fullscreen: boolean) => void) {}

  start(): void {
    if (process.platform !== 'win32' || this.child) return
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
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
        let info: ForegroundWindowInfo | null = null
        try { info = JSON.parse(trimmed) as ForegroundWindowInfo } catch { info = null }
        // 小岛放在主显示器上：别的显示器上的全屏应用不该把它藏起来。
        this.update(shouldHideForFullscreen(info, screen.getPrimaryDisplay().bounds))
      }
    })
    child.on('error', () => { this.child = null; this.update(false) })
    child.on('close', () => { if (this.child === child) { this.child = null; this.update(false) } })
  }

  private update(fullscreen: boolean): void {
    if (!fullscreen) {
      if (this.pending) { clearTimeout(this.pending); this.pending = null }
      if (!this.current) return
      this.current = false
      this.onChange(false)
      return
    }
    if (this.current || this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      this.current = true
      this.onChange(true)
    }, HIDE_DELAY_MS)
  }

  stop(): void {
    if (this.pending) { clearTimeout(this.pending); this.pending = null }
    const child = this.child
    this.child = null
    if (child) child.kill()
  }
}
