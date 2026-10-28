export type IslandMode = 'idle' | 'compact' | 'expanded' | 'detail' | 'custom'
export type PluginMode = 'small' | 'medium' | 'large'

export interface PluginSize {
  width?: number
  height?: number
  preferredWidth?: number
  preferredHeight?: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
}

export interface PluginSmallSize extends PluginSize { enabled?: boolean }

export interface PluginSettingField {
  key: string
  label: string
  type?: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'color' | 'textarea'
  description?: string
  placeholder?: string
  default?: unknown
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
}

/** 插件在 plugin.json 里声明的设置项；宿主渲染表单，插件用 island.settings 读写。 */
export interface PluginSettingsSpec { fields: PluginSettingField[] }

/** 工具页里的数据视图；宿主只渲染，不执行插件代码。 */
export interface PluginToolMetric {
  label: string
  value: string
  tone?: 'default' | 'warn'
}

export type PluginToolView =
  | { type: 'stats'; items: PluginToolMetric[]; spark?: number[] }
  | { type: 'list'; items: Array<{ name: string; meta?: string; tone?: 'default' | 'bad' }> }
  | { type: 'focus'; value: string; note?: string; rounds?: number; done?: number }
  | { type: 'media'; track: string; source?: string; progress?: number }
  | { type: 'text'; text: string }

/** 工具按钮。点击后宿主把 toolId/actionId 发给插件，由插件执行并更新视图。 */
export interface PluginToolAction {
  id: string
  label: string
  /** 控制台内置图标名：refresh / bell / trash / copy / download / play / skip / panel。 */
  icon?: string
  description?: string
  primary?: boolean
  tone?: 'default' | 'danger'
}

/**
 * 控制台「工具」页的一张卡：数据视图 + 按钮。
 * 静态 view 只是首帧兜底；插件用 island.tools.set(toolId, { view }) 推送实时数据。
 */
export interface PluginTool {
  id: string
  title: string
  description?: string
  icon?: string
  view?: PluginToolView
  actions?: PluginToolAction[]
  /** 卡片右下角显示「打开完整面板」；需要插件提供自定义面板（settings 为字符串）。 */
  panel?: boolean
  /** 例如后台脚本退出时保留上次数据并提示原因。 */
  notice?: string
  /** 宿主填写的最近更新时间（毫秒时间戳）。 */
  updatedAt?: number
}

/**
 * 插件设置：两种形态。
 * - `{ fields }`：宿主在控制台渲染的静态参数表单；
 * - 字符串：插件自定义设置页（相对 entry 的 html 路径，如 "dist/settings.html"），
 *   控制台「插件」页出「面板」按钮，宿主用 WebContentsView 承载，页面拿到完整插件 SDK
 *   （storage / events / log），适合做动态管理界面 —— 参数表单只适合静态字段。
 */
export type PluginSettings = PluginSettingsSpec | string

/** 说明页里的按钮：只允许宿主已经有的管理动作，不执行插件提供的代码。 */
export type PluginGuideActionKind = 'settings' | 'logs' | 'reload'

export interface PluginGuideAction {
  kind: PluginGuideActionKind
  label: string
}

export interface PluginGuideCode {
  /** 语言标记，仅用于展示（目前不做语法高亮）。 */
  language?: string
  value: string
}

export interface PluginGuideStep {
  title: string
  text?: string
  /** 命令/片段；宿主渲染成等宽代码块并提供复制。 */
  code?: PluginGuideCode | string
  actions?: PluginGuideAction[]
}

export interface PluginGuideIssue {
  problem: string
  text?: string
  actions?: PluginGuideAction[]
}

export interface PluginGuideLink {
  label: string
  /** 宿主只放行 https: 与 ms-settings:。 */
  url: string
}

/**
 * 面向用户的使用说明。宿主在控制台渲染（点击插件名打开），不占用岛上空间 ——
 * 常驻/按需插件在没数据时不可见，说明放在岛上用户根本到不了。
 * 写法约束：纯文本 + 结构，不支持 HTML/自由 Markdown；`{{key}}` 会替换成该插件当前的参数值。
 */
export interface PluginGuide {
  summary?: string
  /** 使用前提（权限、依赖），逐条展示。 */
  requires?: string[]
  /** 装完还需要配置的插件标 true，用于后续的「待配置」提示。 */
  setupRequired?: boolean
  steps?: PluginGuideStep[]
  troubleshooting?: PluginGuideIssue[]
  links?: PluginGuideLink[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  entry: string
  /** 控制台列表里的一句话说明。 */
  description?: string
  /** 单个字符或 Emoji，控制台用作占位图标；不要放 HTML/SVG。 */
  icon?: string
  runtime?: 'web-app'
  /** mini 段排序权重，越大越靠左（默认 50）。用户拖拽顺序优先于它。 */
  priority?: number
  small?: PluginSmallSize
  medium?: PluginSize
  large?: PluginSize
  settings?: PluginSettings
  /** 控制台「工具」页：插件提供的数据视图与按钮。 */
  tools?: PluginTool[]
  /** 面向用户的使用说明；控制台点插件名打开。 */
  guide?: PluginGuide
  background?: { entry: string }
  resident?: boolean
}

export interface PluginDescriptor {
  manifest: PluginManifest
  rootDir: string
  entryPath: string
}

export interface PluginEventMessage {
  type: 'plugin:event'
  name: string
  payload: unknown
}
