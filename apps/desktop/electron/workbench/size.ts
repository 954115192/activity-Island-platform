import { clampNumber } from '../shared/numbers'

/** Tracks requested dimensions separately from the clamped visible size. */
export function createWorkbenchSize() {
  const WORKBENCH_SIZE_DEFAULT = { width: 1040, height: 700 }
  const WORKBENCH_SIZE_RANGE = { minWidth: 720, maxWidth: 1280, minHeight: 480, maxHeight: 860 }
  /** 小于这个像素差就当"自适应回环"丢掉（见 workbench:resize 的注释）。 */
  let workbenchSizeRequest: { width: number; height: number } = { ...WORKBENCH_SIZE_DEFAULT }

  function current(): { width: number; height: number } {
    return {
      width: clampNumber(workbenchSizeRequest.width, WORKBENCH_SIZE_RANGE.minWidth, WORKBENCH_SIZE_RANGE.maxWidth, WORKBENCH_SIZE_DEFAULT.width),
      height: clampNumber(workbenchSizeRequest.height, WORKBENCH_SIZE_RANGE.minHeight, WORKBENCH_SIZE_RANGE.maxHeight, WORKBENCH_SIZE_DEFAULT.height),
    }
  }

  /** 记录工作台请求的尺寸，返回钳制后真正生效的值（页面据此知道有没有被截）。 */
  function apply(size: { width?: unknown; height?: unknown }): { width: number; height: number; clamped: boolean } {
    const requestedWidth = Number(size?.width)
    const requestedHeight = Number(size?.height)
    if (Number.isFinite(requestedWidth)) workbenchSizeRequest.width = requestedWidth
    if (Number.isFinite(requestedHeight)) workbenchSizeRequest.height = requestedHeight
    const applied = current()
    const clamped = applied.width !== Math.round(workbenchSizeRequest.width) || applied.height !== Math.round(workbenchSizeRequest.height)
    workbenchSizeRequest = { ...applied }
    return { ...applied, clamped }
  }

  return { current, apply }
}
