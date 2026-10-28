/**
 * 工作台能力：manifest 声明 → IPC 边界执行。
 *
 * 为什么要有"声明"这一层：工作台是**可分发**的，而它的能力面是"完全档"
 * （能访问网络、能执行本机命令）。也就是说 **装一个工作台 = 装一个任意程序**。
 * 所以必须让用户在启用之前就能看到"它要做什么"，而且那句话不能是装饰 ——
 * 这里把声明做成**可执行的校验**：没声明就调不通，声明与实际能做永远一致。
 *
 * 注意这不是沙箱：声明通过之后，工作台拿到的就是真实能力。
 * 它的作用是"知情同意"，不是"事后阻止已经同意的事"。
 */

export const WORKBENCH_CAPABILITIES = ['system', 'open', 'http', 'run', 'storage', 'shortcuts', 'resize'] as const
export type WorkbenchCapability = (typeof WORKBENCH_CAPABILITIES)[number]

/** 给用户看的人话说明：管理页在**启用之前**展示，用户据此判断要不要装。 */
export const CAPABILITY_LABELS: Record<WorkbenchCapability, string> = {
  system: '读取 CPU、内存、网络等系统信息',
  open: '打开程序、文件、文件夹、网址',
  http: '访问网络（含本机 127.0.0.1 上的服务）',
  run: '执行本机命令与脚本',
  storage: '保存这个工作台自己的数据',
  shortcuts: '读写「快捷启动」列表（跨工作台共享）',
  resize: '改变工作台尺寸（宿主会钳制）',
}

/**
 * 管理页展示顺序：**先列会碰机器和网络的能力**，让用户最该注意的几行排在最前面。
 * 这只是展示顺序，不影响校验 —— 校验对所有能力一视同仁。
 */
export const CAPABILITY_REVIEW_ORDER: WorkbenchCapability[] = ['run', 'http', 'open', 'system', 'shortcuts', 'storage', 'resize']

/** 按用户能看懂的粒度分组，供管理页展示。 */
export const CAPABILITY_DESCRIPTIONS: Array<{ capability: WorkbenchCapability; label: string }> =
  WORKBENCH_CAPABILITIES.map(capability => ({ capability, label: CAPABILITY_LABELS[capability] }))

export function isWorkbenchCapability(value: unknown): value is WorkbenchCapability {
  return typeof value === 'string' && (WORKBENCH_CAPABILITIES as readonly string[]).includes(value)
}

/**
 * 从 manifest 里解析能力声明。
 * 未知项**丢弃而不是报错**：这样宿主升级后，旧工作台里未来的能力名不会让整个包失效。
 */
export function normalizeCapabilities(input: unknown): WorkbenchCapability[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<WorkbenchCapability>()
  for (const item of input) if (isWorkbenchCapability(item)) seen.add(item)
  return WORKBENCH_CAPABILITIES.filter(capability => seen.has(capability))
}

/** 内置工作台随宿主分发，视为声明全部能力。 */
export function allCapabilities(): Set<WorkbenchCapability> { return new Set(WORKBENCH_CAPABILITIES) }

/**
 * 校验一次调用。
 * 返回 `null` 表示放行；否则返回给调用方的错误串（工作台据此能明确知道为什么失败，
 * 而不是拿到一个静默失败）。
 */
export function checkCapability(declared: ReadonlySet<string>, required: WorkbenchCapability): string | null {
  if (declared.has(required)) return null
  return `capability-not-declared:${required}`
}

/** 用户能读懂的一句总述，管理页顶部用。 */
export const WORKBENCH_TRUST_NOTICE = '工作台能访问网络并执行本机程序与脚本，启用等于信任它。'
