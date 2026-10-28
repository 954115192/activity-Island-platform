/**
 * mini 条的装箱：段宽之和超过可用宽度时，按优先级（= 排好的顺序）丢弃尾部 ambient 段，
 * 折叠成一个 `+N` 徽标。
 *
 * 这是纯函数，方便单测：输入是**已按优先级排好序**的段，输出是保留的段、丢弃数量与内容宽度。
 */

export interface MiniSegment {
  pluginId: string
  width: number
}

export interface MiniBarFit {
  kept: MiniSegment[]
  dropped: number
  /** 去掉左右 padding 后的内容宽度（含 `+N` 徽标占位）。 */
  contentWidth: number
}

/**
 * @param segments    已排序的段（优先级高的在前）
 * @param padding     左右内边距（每边）
 * @param minWidth    岛的兜底最小宽度
 * @param maxWidth    岛能占用的最大宽度（窗口/屏幕限制）
 * @param chipWidth   `+N` 徽标占用的宽度（只有真的丢弃了段才计入）
 */
export function fitMiniBar(segments: MiniSegment[], padding: number, minWidth: number, maxWidth: number, chipWidth: number): MiniBarFit {
  const sum = (list: MiniSegment[]): number => list.reduce((total, segment) => total + segment.width, 0)
  const fits = (list: MiniSegment[]): boolean => {
    const dropped = segments.length - list.length
    const content = sum(list) + (dropped > 0 ? chipWidth : 0)
    return Math.max(minWidth, content + padding * 2) <= maxWidth
  }
  const kept: MiniSegment[] = []
  for (const segment of segments) {
    kept.push(segment)
    if (!fits(kept)) { kept.pop(); break }
  }
  // 至少保留一段：单段本身就超宽时也只能显示它（由宿主裁剪）。
  if (kept.length === 0 && segments.length > 0) kept.push(segments[0])
  const dropped = segments.length - kept.length
  return { kept, dropped, contentWidth: sum(kept) + (dropped > 0 ? chipWidth : 0) }
}
