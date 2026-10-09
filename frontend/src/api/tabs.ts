import { ListTabs, SaveTabs } from './bindings'
import type { WorkbenchTab } from '@/types'

/** uid 计数器（会话内自增，不落库） */
let uidSeed = 0

/** 生成 Tab 的会话内稳定标识 */
export function nextTabUid(): string {
  uidSeed += 1
  return `tab-${uidSeed}`
}

/** 读取全部工作台 Tab */
export async function fetchTabs(): Promise<WorkbenchTab[]> {
  const list = await ListTabs()
  return list.map(item => ({
    uid: nextTabUid(),
    id: item.id,
    name: item.name,
    sortOrder: item.sortOrder,
    isActive: item.isActive,
    isLocked: item.isLocked,
    toolType: item.toolType,
    payload: item.payload,
    schemaVersion: item.schemaVersion,
  }))
}

/** 全量保存 Tab 列表，返回写库后的结果 */
export async function persistTabs(tabs: WorkbenchTab[]): Promise<WorkbenchTab[]> {
  // 不把 uid 发给后端
  const saved = await SaveTabs(tabs.map(tab => ({
    id: tab.id,
    name: tab.name,
    sortOrder: tab.sortOrder,
    isActive: tab.isActive,
    isLocked: tab.isLocked,
    toolType: tab.toolType,
    payload: tab.payload,
    schemaVersion: tab.schemaVersion,
  })))

  // 沿用调用方的 uid，避免组件 key 变化导致销毁重建
  return saved.map((item, index) => ({
    uid: tabs[index]?.uid ?? nextTabUid(),
    id: item.id,
    name: item.name,
    sortOrder: item.sortOrder,
    isActive: item.isActive,
    isLocked: item.isLocked,
    toolType: item.toolType,
    payload: item.payload,
    schemaVersion: item.schemaVersion,
  }))
}
