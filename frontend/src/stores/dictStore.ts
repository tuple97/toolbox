import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  fetchDictionaryItems,
  fetchDictionaries,
  loadDictionaryCache,
} from '@/api/dictionaries'
import type { Dictionary, DictionaryItem } from '@/types'

export const useDictStore = defineStore('dictionaries', () => {
  /** 全部词典 */
  const dictionaries = ref<Dictionary[]>([])
  /** 词典 ID → 词典项列表 */
  const items = ref<Record<number, DictionaryItem[]>>({})
  const loaded = ref(false)
  const error = ref('')

  /**
   * 词典 ID → (原始值 → 词典项) 的映射。
   * 翻译时按单元格高频查询，预建索引避免每次遍历数组。
   */
  const valueIndex = computed(() => {
    const index: Record<number, Map<string, DictionaryItem>> = {}
    for (const [dictId, list] of Object.entries(items.value)) {
      const map = new Map<string, DictionaryItem>()
      for (const item of list) {
        map.set(item.value, item)
      }
      index[Number(dictId)] = map
    }
    return index
  })

  /** 加载全部词典与词典项（一次性拉取，本地翻译） */
  async function loadAll(): Promise<void> {
    try {
      const [list, cache] = await Promise.all([
        fetchDictionaries(),
        loadDictionaryCache(),
      ])
      dictionaries.value = list
      items.value = cache ?? {}
      loaded.value = true
      error.value = ''
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      loaded.value = true
    }
  }

  /** 刷新指定词典的项 */
  async function refreshItems(dictionaryId: number): Promise<void> {
    try {
      const list = await fetchDictionaryItems(dictionaryId)
      items.value = { ...items.value, [dictionaryId]: list }
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /**
   * 查询词典项。
   * 返回 undefined 表示未命中，调用方可据此决定展示原始值。
   */
  function lookup(dictionaryId: number, value: unknown): DictionaryItem | undefined {
    if (!dictionaryId) {
      return undefined
    }
    const text = value === null || value === undefined ? '' : String(value)
    return valueIndex.value[dictionaryId]?.get(text)
  }

  return {
    dictionaries,
    items,
    loaded,
    error,
    loadAll,
    refreshItems,
    lookup,
  }
})
