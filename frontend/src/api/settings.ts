import { GetAllSettings, SaveSetting } from './bindings'
import type { Setting } from '@/types'

export async function fetchSettings(): Promise<Setting[]> {
  const list = await GetAllSettings()
  return list.map(item => ({
    key: item.key,
    type: item.type,
    value: item.value,
  }))
}

export function persistSetting(key: string, value: string): Promise<void> {
  return SaveSetting(key, value)
}
