/**
 * 元数据缓存里「外键」这一路的用例（T2b）。
 *
 * 外键只用于把关联条件补全得更准，**拉取失败绝不能影响补全可用性**：
 * 这里固定住「失败降级为空 + 记原因」「缓存与 force 重试」「连接失效时一并清掉」
 * 这几条契约。store 依赖 wails 绑定，因此 mock 掉 `@/api/executor`。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { META_TTL, useMetadataStore } from '@/stores/metadataStore'

const mocks = vi.hoisted(() => ({
  fetchForeignKeys: vi.fn(),
}))

vi.mock('@/api/executor', () => ({
  fetchDatabases: vi.fn(async () => []),
  fetchTables: vi.fn(async () => []),
  fetchTableColumns: vi.fn(async () => []),
  fetchForeignKeys: mocks.fetchForeignKeys,
}))

/** 一条典型外键：orders.user_id → users.id */
const FK = { column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }

describe('元数据缓存：外键', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.fetchForeignKeys.mockReset()
  })

  it('拉取成功后同步返回缓存，且不再重复请求', async () => {
    mocks.fetchForeignKeys.mockResolvedValue([FK])
    const store = useMetadataStore()

    await store.loadForeignKeys(1, 'testdb', 'orders')
    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([FK])
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(1)

    // 再拉一次走缓存（TTL 内）
    await store.loadForeignKeys(1, 'testdb', 'orders')
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(1)
  })

  it('ensureForeignKeys 先返回空并触发后台加载，稍后就能拿到数据', async () => {
    mocks.fetchForeignKeys.mockResolvedValue([FK])
    const store = useMetadataStore()

    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([])
    await vi.waitFor(() => {
      expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([FK])
    })
  })

  it('拉取失败降级为空数组，不抛出，并记下原因', async () => {
    mocks.fetchForeignKeys.mockRejectedValue(new Error('无 information_schema 权限'))
    const store = useMetadataStore()

    await expect(store.loadForeignKeys(1, 'testdb', 'orders')).resolves.toEqual([])
    expect(store.lastError).toContain('无 information_schema 权限')
    // 失败也会按「这张表没有外键」缓存，补全链路不会反复打数据库
    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([])
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(1)
  })

  it('force 可以绕过失败后的空缓存重试', async () => {
    mocks.fetchForeignKeys.mockRejectedValueOnce(new Error('网络抖动'))
    const store = useMetadataStore()

    await store.loadForeignKeys(1, 'testdb', 'orders')
    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([])

    mocks.fetchForeignKeys.mockResolvedValue([FK])
    await store.loadForeignKeys(1, 'testdb', 'orders', true)
    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([FK])
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(2)
  })

  it('连接失效时外键缓存一并清掉', async () => {
    mocks.fetchForeignKeys.mockResolvedValue([FK])
    const store = useMetadataStore()
    await store.loadForeignKeys(1, 'testdb', 'orders')

    store.invalidateConnection(1)
    expect(store.foreignKeys).toEqual({})

    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([])
    await vi.waitFor(() => {
      expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(2)
    })
  })

  it('缓存过期后会重新拉取', async () => {
    vi.useFakeTimers()
    try {
      mocks.fetchForeignKeys.mockResolvedValue([FK])
      const store = useMetadataStore()
      await store.loadForeignKeys(1, 'testdb', 'orders')

      vi.advanceTimersByTime(META_TTL + 1)
      await store.loadForeignKeys(1, 'testdb', 'orders')
      expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
