interface TransitionEffects {
  canScheduleCollapse(): boolean
  canCollapse(): boolean
  collapse(): void
  hideWorkbench(): void
}

/** Owns transition generations and the two deferred transition timers. */
export function createIslandTransitions(effects: TransitionEffects) {
  let serial = 0
  let disposed = false
  let collapseTimer: ReturnType<typeof setTimeout> | null = null
  let workbenchHide: { timer: ReturnType<typeof setTimeout>; belowWidth: number } | null = null

  function cancelCollapse(): void {
    if (collapseTimer) clearTimeout(collapseTimer)
    collapseTimer = null
  }

  function cancelWorkbenchHide(): void {
    if (workbenchHide) clearTimeout(workbenchHide.timer)
    workbenchHide = null
  }

  function scheduleCollapse(): void {
    cancelCollapse()
    if (disposed || !effects.canScheduleCollapse()) return
    collapseTimer = setTimeout(() => {
      collapseTimer = null
      if (!disposed && effects.canCollapse()) effects.collapse()
    }, 3000)
  }

  function deferWorkbenchHide(): void {
    cancelWorkbenchHide()
    if (disposed) return
    const timer = setTimeout(() => {
      workbenchHide = null
      if (!disposed) effects.hideWorkbench()
    }, 900)
    workbenchHide = { timer, belowWidth: Number.POSITIVE_INFINITY }
  }

  return {
    get serial() { return serial },
    begin() { return ++serial },
    cancelCollapse, scheduleCollapse, cancelWorkbenchHide, deferWorkbenchHide,
    armWorkbenchHide(startWidth: number, targetWidth: number) {
      if (workbenchHide) workbenchHide.belowWidth = startWidth + (targetWidth - startWidth) * 0.7
    },
    sample(width: number, settled: boolean) {
      if (disposed || !workbenchHide || (width > workbenchHide.belowWidth && !settled)) return
      cancelWorkbenchHide()
      effects.hideWorkbench()
    },
    dispose() {
      if (disposed) return
      disposed = true
      ++serial
      cancelCollapse()
      cancelWorkbenchHide()
    },
  }
}
