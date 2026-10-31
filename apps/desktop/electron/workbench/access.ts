import { allCapabilities, normalizeCapabilities, checkCapability, type WorkbenchCapability } from './capabilities'
import { BUILTIN_WORKBENCH_ID, type WorkbenchDescriptor } from './workbench-manager'

/** Active identity and the declared capabilities granted to the current page. */
export function createWorkbenchAccess(isSender: (sender: Electron.WebContents) => boolean) {
  let id = BUILTIN_WORKBENCH_ID
  let declared: ReadonlySet<string> = allCapabilities()
  return {
    get id() { return id },
    snapshot() { return { id, capabilities: [...declared] } },
    set(nextId: string, capabilities: unknown): void {
      id = nextId
      declared = id === BUILTIN_WORKBENCH_ID ? allCapabilities() : new Set(normalizeCapabilities(capabilities))
    },
    apply(descriptor: WorkbenchDescriptor): void {
      id = descriptor.manifest.id
      declared = descriptor.builtin ? allCapabilities() : new Set(descriptor.capabilities)
    },
    guard(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, capability: WorkbenchCapability | null): string | null {
      if (!isSender(event.sender)) return 'not-a-workbench'
      return capability ? checkCapability(declared, capability) : null
    },
  }
}
