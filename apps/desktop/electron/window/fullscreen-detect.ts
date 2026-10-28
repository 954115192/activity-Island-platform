/**
 * 全屏前台窗口的判定（纯函数，便于单测）。
 *
 * 只看"窗口矩形是否盖住显示器"是不够的：桌面整理助手（360 桌面整理等）的面板
 * 是挂在桌面下的子窗口，点击时同样铺满屏幕。必须同时排除：
 * - 桌面/任务栏等外壳窗口；
 * - 子窗口（先取 GA_ROOT，根是桌面就不算）；
 * - 工具窗口 / 不激活窗口（WS_EX_TOOLWINDOW / WS_EX_NOACTIVATE）；
 * - 有 owner 的窗口、不可见或最小化的窗口；
 * - Chromium 浏览器窗口（不处理浏览器 F11 全屏）。
 *
 * 游戏等全屏应用通常是：
 * 顶层、无 owner、可见、未最小化、非工具窗口，且矩形覆盖显示器。
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

/** PowerShell 探针输出的前台根窗口信息。 */
export interface ForegroundWindowInfo extends Rect {
  className: string
  /** GWL_EXSTYLE */
  exStyle: number
  /** GWL_STYLE. Used with `zoomed` to reject ordinary maximized windows. */
  style: number
  /** IsZoomed(HWND). A framed maximized app is not treated as fullscreen. */
  zoomed: boolean
  /** GW_OWNER，0 表示没有 owner。 */
  owner: number
  visible: boolean
  iconic: boolean
}

const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000

/** 桌面、任务栏这些 shell 窗口永远不算"需要隐藏小岛的全屏应用"。 */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
// Chrome, Edge, Brave and other Chromium browsers use this native class family.
function isChromiumWindowClass(className: string): boolean {
  return className.startsWith('Chrome_WidgetWin_')
}

export function coversDisplay(rect: Rect, bounds: DisplayBounds): boolean {
  // Borderless fullscreen bounds can differ slightly from monitor bounds
  // because of invisible DWM resize borders and per-monitor DPI rounding.
  const tolerance = 24
  return rect.left <= bounds.x + tolerance && rect.top <= bounds.y + tolerance && rect.right >= bounds.x + bounds.width - tolerance && rect.bottom >= bounds.y + bounds.height - tolerance
}

export function shouldHideForFullscreen(info: ForegroundWindowInfo | null | undefined, bounds: DisplayBounds): boolean {
  if (!info || typeof info !== 'object') return false
  if (typeof info.className !== 'string') return false
  if (isChromiumWindowClass(info.className)) return false
  if (info.visible !== true || info.iconic === true) return false
  if (!Number.isFinite(info.owner) || info.owner !== 0) return false
  if (!Number.isFinite(info.exStyle)) return false
  if ((info.exStyle & WS_EX_TOOLWINDOW) !== 0) return false
  if ((info.exStyle & WS_EX_NOACTIVATE) !== 0) return false
  // A normal maximized window can cover the monitor when the taskbar is set
  // to auto-hide. Borderless fullscreen games usually remove the caption and
  // resize frame; don't reject those just because the OS reports zoomed.
  if (info.zoomed === true && Number.isFinite(info.style) &&
      ((info.style & WS_CAPTION) === WS_CAPTION || (info.style & WS_THICKFRAME) !== 0)) return false
  if (SHELL_CLASSES.has(info.className)) return false
  if (![info.left, info.top, info.right, info.bottom].every(value => Number.isFinite(value))) return false
  return coversDisplay(info, bounds)
}
