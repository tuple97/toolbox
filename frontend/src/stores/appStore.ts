/** 应用启动状态 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchAppStartupState, retryInit } from '@/api/system'
import type { AppStartupState } from '@/types'

export const useAppStore = defineStore('app', () => {
  const startup = ref<AppStartupState>({ state: 'initializing', error: '' })

  /** 后端初始化失败（本地数据功能不可用） */
  const degraded = computed(() => startup.value.state === 'degraded')

  /** 读取启动状态 */
  async function load(): Promise<void> {
    startup.value = await fetchAppStartupState()
  }

  /** 重试初始化，返回是否已恢复 */
  async function retry(): Promise<boolean> {
    startup.value = await retryInit()
    return !degraded.value
  }

  return {
    startup,
    degraded,
    load,
    retry,
  }
})
