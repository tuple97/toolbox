import {
  DeleteDictionary,
  ListDictionaries,
  ListDictionaryItems,
  LoadDictionaryCache,
  SaveDictionary,
  SaveDictionaryItems,
} from './bindings'
import type { Dictionary, DictionaryItem } from '@/types'

function toDictionary(raw: { id: number, name: string, description: string }): Dictionary {
  return { id: raw.id, name: raw.name, description: raw.description }
}

function toDictionaryItem(raw: {
  id: number
  dictionaryId: number
  value: string
  meaning: string
  description: string
  sortOrder: number
}): DictionaryItem {
  return {
    id: raw.id,
    dictionaryId: raw.dictionaryId,
    value: raw.value,
    meaning: raw.meaning,
    description: raw.description,
    sortOrder: raw.sortOrder,
  }
}

export async function fetchDictionaries(): Promise<Dictionary[]> {
  const list = await ListDictionaries()
  return list.map(toDictionary)
}

export function persistDictionary(dict: Dictionary): Promise<number> {
  return SaveDictionary(dict)
}

export function removeDictionary(id: number): Promise<void> {
  return DeleteDictionary(id)
}

export async function fetchDictionaryItems(dictionaryId: number): Promise<DictionaryItem[]> {
  const list = await ListDictionaryItems(dictionaryId)
  return list.map(toDictionaryItem)
}

export function persistDictionaryItems(
  dictionaryId: number,
  items: DictionaryItem[],
): Promise<void> {
  return SaveDictionaryItems(dictionaryId, items)
}

/** 一次性加载全部词典与词典项，返回 { 词典ID: 词典项数组 } */
export async function loadDictionaryCache(): Promise<Record<number, DictionaryItem[]>> {
  const cache = await LoadDictionaryCache()
  const result: Record<number, DictionaryItem[]> = {}
  for (const [dictId, list] of Object.entries(cache ?? {})) {
    result[Number(dictId)] = (list ?? []).map(toDictionaryItem)
  }
  return result
}
