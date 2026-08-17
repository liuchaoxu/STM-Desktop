import { ref } from 'vue'

export type TabId = 'tunnels' | 'config' | 'logs'

export const activeTab = ref<TabId>('tunnels')
export const logTarget = ref('all')

export function useUi(): {
  activeTab: typeof activeTab
  logTarget: typeof logTarget
  show: (tab: TabId) => void
} {
  function show(tab: TabId): void {
    activeTab.value = tab
  }
  return { activeTab, logTarget, show }
}
