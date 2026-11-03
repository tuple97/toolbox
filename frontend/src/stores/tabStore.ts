import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchTabs, nextTabUid, persistTabs } from '@/api/tabs'
import { toolOf } from '@/utils/tools'
import type { ToolType, WorkbenchTab } from '@/types'

/** 防抖保存间隔：state 变化后等待 1s 再落盘 */
const SAVE_DEBOUNCE_MS = 1000

/** 新建 Tab 的默认名称前缀 */
const DEFAULT_TAB_NAME = '新建标签'

/** 没有标签可展示时的落脚点：指向插件管理单例 */
const DEFAULT_SINGLETON: ToolType = 'plugins'

export const useTabStore = defineStore('tabs', () => {
  /** 标签列表，顺序即展示顺序；只装多例工具，单例工具走 `activeSingleton` */
  const tabs = ref<WorkbenchTab[]>([])
  /** 当前激活的 Tab ID */
  const activeId = ref<number | null>(null)
  /** 当前展示的单例视图，与 `activeId` 互斥 */
  const activeSingleton = ref<ToolType | null>(DEFAULT_SINGLETON)
  /** 是否已完成首次加载 */
  const loaded = ref(false)
  /** 保存状态，供界面提示 */
  const saving = ref(false)
  const lastSavedAt = ref<number | null>(null)
  const saveError = ref('')

  /** 自增主键：本地新建时分配临时 ID，避免与后端 AUTOINCREMENT 冲突 */
  let nextLocalId = -1

  /** 当前激活的 Tab */
  const activeTab = computed(
    () => tabs.value.find(tab => tab.id === activeId.value) ?? null,
  )

  /** 未锁定的 Tab 才可关闭 */
  const closableTabs = computed(() => tabs.value.filter(tab => !tab.isLocked))

  let saveTimer: number | null = null
  /** 保存请求是否在等待执行（用于保存期间再次变更的补偿） */
  let pendingAfterSave = false

  // ------------------------------------------------------------ 持久化

  /** 规范化待保存数据（顺序即 sortOrder） */
  function snapshot(): WorkbenchTab[] {
    return tabs.value.map((tab, index) => ({
      ...tab,
      sortOrder: index,
      isActive: tab.id === activeId.value,
    }))
  }

  /** 立即保存，并把后端重新分配的 ID 同步回本地 */
  async function saveNow(): Promise<void> {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    saving.value = true
    saveError.value = ''
    try {
      // 记录保存前的激活位置，便于按索引映射回新 ID
      const activeIndex = tabs.value.findIndex(tab => tab.id === activeId.value)

      const saved = await persistTabs(snapshot())

      // 判断后端是否重新分配了 ID（仅本地新建的标签会出现这种情况）
      const idsChanged = saved.some((tab, index) => tab.id !== tabs.value[index]?.id)
      if (idsChanged) {
        tabs.value = saved
        activeId.value = saved[activeIndex]?.id ?? saved[0]?.id ?? null
      }

      lastSavedAt.value = Date.now()
    }
    catch (e) {
      saveError.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      saving.value = false
      // 保存期间若有新的变更，再排一次保存，确保不丢数据
      if (pendingAfterSave) {
        pendingAfterSave = false
        scheduleSave()
      }
    }
  }

  /** 防抖保存：任意 state 变化后延迟落盘 */
  function scheduleSave() {
    // 若正在保存，标记需要追加一次保存，避免期间的改动被遗漏
    if (saving.value) {
      pendingAfterSave = true
      return
    }
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      void saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  // ------------------------------------------------------------ 加载

  /** 从后端加载 Tab 列表 */
  async function load(): Promise<void> {
    try {
      const list = await fetchTabs()
      // 过滤掉单例工具标签与空白标签，未知类型保留
      const multiOnly = list.filter((tab) => {
        if (tab.toolType === 'placeholder') {
          return false
        }
        const definition = toolOf(tab.toolType)
        return definition ? definition.multi : true
      })
      tabs.value = [...multiOnly].sort((a, b) => a.sortOrder - b.sortOrder)

      const active = tabs.value.find(tab => tab.isActive)
      activeId.value = active?.id ?? tabs.value[0]?.id ?? null
      // 没有标签可展示时落到插件管理单例视图
      activeSingleton.value = activeId.value === null ? DEFAULT_SINGLETON : null
      loaded.value = true

      if (multiOnly.length !== list.length) {
        scheduleSave()
      }
    }
    catch (e) {
      saveError.value = e instanceof Error ? e.message : String(e)
      loaded.value = true
    }
  }

  // ------------------------------------------------------------ 增删改

  /** 新建一个 Tab 并激活 */
  function addTab(toolType: ToolType = 'placeholder', name?: string): WorkbenchTab {
    const tab: WorkbenchTab = {
      uid: nextTabUid(),
      id: nextLocalId--,
      name: name ?? `${DEFAULT_TAB_NAME} ${tabs.value.length + 1}`,
      sortOrder: tabs.value.length,
      isActive: false,
      isLocked: false,
      toolType,
      payload: '{}',
      schemaVersion: 1,
    }
    tabs.value.push(tab)
    activeId.value = tab.id
    scheduleSave()
    return tab
  }

  /** 关闭 Tab；锁定状态下禁止关闭 */
  function closeTab(id: number, options: { force?: boolean } = {}): boolean {
    const index = tabs.value.findIndex(tab => tab.id === id)
    if (index < 0) {
      return false
    }
    if (tabs.value[index].isLocked && !options.force) {
      return false
    }

    tabs.value.splice(index, 1)

    // 激活态处理：关闭的是当前 Tab 时，顺延到相邻项
    if (activeId.value === id) {
      const next = tabs.value[index] ?? tabs.value[index - 1] ?? null
      if (next) {
        activeId.value = next.id
      }
      else {
        // 最后一条标签也关掉了：回到默认单例视图，不留空白内容区
        activeId.value = null
        activeSingleton.value = DEFAULT_SINGLETON
      }
    }
    scheduleSave()
    return true
  }

  /** 关闭除指定 Tab 外的其他 Tab（锁定项与自身保留） */
  function closeOthers(id: number): void {
    tabs.value = tabs.value.filter(tab => tab.id === id || tab.isLocked)
    activeId.value = id
    activeSingleton.value = null
    scheduleSave()
  }

  /** 关闭全部未锁定 Tab */
  function closeAll(): void {
    tabs.value = tabs.value.filter(tab => tab.isLocked)
    activeId.value = tabs.value[0]?.id ?? null
    // 全关之后没有标签可展示，落到默认单例视图
    activeSingleton.value = activeId.value === null ? DEFAULT_SINGLETON : null
    scheduleSave()
  }

  /** 重命名 Tab */
  function renameTab(id: number, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }
    const tab = tabs.value.find(item => item.id === id)
    if (!tab) {
      return
    }
    tab.name = trimmed
    scheduleSave()
  }

  /** 切换锁定状态 */
  function toggleLock(id: number): void {
    const tab = tabs.value.find(item => item.id === id)
    if (!tab) {
      return
    }
    tab.isLocked = !tab.isLocked
    scheduleSave()
  }

  /** 切换激活 Tab（激活标签即退出单例视图） */
  function setActive(id: number): void {
    if (activeId.value === id && activeSingleton.value === null) {
      return
    }
    activeId.value = id
    activeSingleton.value = null
    scheduleSave()
  }

  /** 拖拽排序后更新顺序 */
  function reorder(newOrder: WorkbenchTab[]): void {
    tabs.value = newOrder
    scheduleSave()
  }

  /** 打开工具：单例工具切到单例视图，多例工具新建标签 */
  function openTool(type: ToolType, options: { newInstance?: boolean } = {}): WorkbenchTab | null {
    const definition = toolOf(type)

    if (!(definition?.multi ?? false)) {
      showSingleton(type)
      return null
    }

    // 多例：名称带序号，便于区分；同时退出单例视图
    activeSingleton.value = null
    const label = definition?.label ?? '新建标签'
    const sameKind = tabs.value.filter(tab => tab.toolType === type).length
    return addTab(type, `${label} ${sameKind + 1}`)
  }

  /** 切到某个单例视图（内容区展示它，同时退出标签视图） */
  function showSingleton(type: ToolType): void {
    const changed = activeSingleton.value !== type || activeId.value !== null
    activeSingleton.value = type
    activeId.value = null
    if (changed) {
      scheduleSave()
    }
  }

  /** 为 Tab 绑定工具；工具一旦选定即永久绑定 */
  function bindTool(id: number, toolType: ToolType): boolean {
    const tab = tabs.value.find(item => item.id === id)
    if (!tab || tab.toolType !== 'placeholder') {
      return false
    }
    tab.toolType = toolType
    scheduleSave()
    return true
  }

  /** 更新 Tab 的 payload；内容未变化时不赋值也不排保存 */
  function updatePayload(id: number, payload: unknown): void {
    const tab = tabs.value.find(item => item.id === id)
    if (!tab) {
      return
    }

    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (tab.payload === serialized) {
      return
    }

    tab.payload = serialized
    scheduleSave()
  }

  return {
    // state
    tabs,
    activeId,
    activeSingleton,
    loaded,
    saving,
    lastSavedAt,
    saveError,
    // getters
    activeTab,
    closableTabs,
    // actions
    load,
    saveNow,
    scheduleSave,
    showSingleton,
    addTab,
    openTool,
    closeTab,
    closeOthers,
    closeAll,
    renameTab,
    toggleLock,
    setActive,
    reorder,
    bindTool,
    updatePayload,
  }
})
