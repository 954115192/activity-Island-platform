import { app } from 'electron'

/**
 * 开机启动写的是 Windows 登录项（HKCU\...\Run），不写任何自启动服务。
 * - 安装版：注册当前 exe；
 * - 便携版：注册便携 exe，而不是运行时解包到 Temp 的副本；
 * - 源码运行：注册 electron.exe + 应用目录，方便本机验证（发布版不会走到这里）。
 */
export function applyLaunchAtLogin(enabled: boolean): { ok: boolean; enabled: boolean; error?: string } {
  const options: { path?: string; args?: string[] } = {}
  try {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    if (portable) { options.path = portable; options.args = [] }
    else if (!app.isPackaged) { options.path = process.execPath; options.args = [app.getAppPath()] }
    app.setLoginItemSettings({ ...options, openAtLogin: enabled })
    return { ok: true, enabled: app.getLoginItemSettings(options).openAtLogin }
  } catch (error) {
    return { ok: false, enabled: app.getLoginItemSettings(options).openAtLogin, error: String((error as Error)?.message ?? error) }
  }
}
