import { ipcRenderer, webUtils } from 'electron'

/** 每个可能覆盖岛面的视图都安装同一个拖放入口；主进程仅接受真实用户拖入的文件。 */
export function installTransferDrop(): void {
  let entered = false
  let heartbeat = 0
  window.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    entered = true
    ipcRenderer.send('transfers:drag', true)
  }, true)
  window.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (Date.now() - heartbeat > 500) { heartbeat = Date.now(); ipcRenderer.send('transfers:drag', true) }
  }, true)
  window.addEventListener('dragleave', event => {
    if (event.relatedTarget || !entered) return
    entered = false
    ipcRenderer.send('transfers:drag', false)
  }, true)
  window.addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) return
    event.preventDefault()
    event.stopImmediatePropagation()
    entered = false
    const paths = Array.from(event.dataTransfer.files).map(file => webUtils.getPathForFile(file)).filter(Boolean)
    ipcRenderer.send('transfers:drop', paths)
  }, true)
}
