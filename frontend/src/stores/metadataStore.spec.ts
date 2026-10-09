/**
 * 元数据缓存的用例。
 *
 * T2b：外键这一路 —— 外键只用于把关联条件补全得更准，**拉取失败绝不能影响补全可用性**：
 * 这里固定住「失败降级为空 + 记原因」「缓存与 force 重试」「连接失效时一并清掉」这几条契约。
 *
 * 失败退避：连接不可用（密码解不开 / 库连不上）时，补全会**每次按键**调 `ensureXxx()`；
 * 若失败不记任何时间戳，每个字符都会重发一次请求。这里固定住「窗口内只打一次后端」
 * 「窗口过后会重试」「成功与刷新会清掉退避」这几条契约。
 *
 * store 依赖 wails 绑定，因此 mock 掉 `@/api/executor`。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { META_RETRY_BACKOFF, META_TTL, useMetadataStore } from '@/stores/metadataStore'
import type { DatabaseInfo, ExecutorColumn, TableForeignKey } from '@/types'

const mocks = vi.hoisted(() => ({
  fetchDatabases: vi.fn(async (): Promise<DatabaseInfo[]> => []),
  fetchTables: vi.fn(async (): Promise<string[]> => []),
  fetchTableColumns: vi.fn(async (): Promise<ExecutorColumn[]> => []),
  fetchForeignKeys: vi.fn(async (): Promise<TableForeignKey[]> => []),
}))

vi.mock('@/api/executor', () => ({
  fetchDatabases: mocks.fetchDatabases,
  fetchTables: mocks.fetchTables,
  fetchTableColumns: mocks.fetchTableColumns,
  fetchForeignKeys: mocks.fetchForeignKeys,
}))

/** 一条典型外键：orders.user_id → users.id */
const FK = { column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }

/** 连接不可用时后端的典型报错 */
const DECRYPT_ERROR = '解密数据库密码失败: 解密失败（密钥可能已变更）'

/** 让后台拉取的微任务链跑完（成功 / 失败路径都只有微任务，没有定时器） */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
  }
}

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
    // 失败也按「这张表没有外键」处理，补全链路不会反复打数据库
    expect(store.ensureForeignKeys(1, 'testdb', 'orders')).toEqual([])
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(1)
  })

  it('force 可以绕过失败后的退避重试', async () => {
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

describe('元数据缓存：失败退避', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.fetchDatabases.mockReset().mockRejectedValue(new Error(DECRYPT_ERROR))
    mocks.fetchTables.mockReset().mockRejectedValue(new Error(DECRYPT_ERROR))
    mocks.fetchTableColumns.mockReset().mockRejectedValue(new Error(DECRYPT_ERROR))
    mocks.fetchForeignKeys.mockReset().mockRejectedValue(new Error(DECRYPT_ERROR))
  })

  it('库列表拉取失败后，退避窗口内反复 ensure 都只打一次后端', async () => {
    const store = useMetadataStore()

    store.ensureDatabaseInfos(1)
    await flush()
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(1)
    expect(store.lastError).toContain(DECRYPT_ERROR)

    // 模拟连续输入：补全每敲一下都会 ensure 一次
    for (let i = 0; i < 5; i++) {
      store.ensureDatabaseInfos(1)
      store.ensureDatabases(1)
    }
    await flush()
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(1)
  })

  it('表 / 字段 / 外键失败后同样进入退避，不会每次按键重试', async () => {
    const store = useMetadataStore()

    store.ensureTables(1, 'testdb')
    store.ensureColumns(1, 'testdb', 'orders')
    store.ensureForeignKeys(1, 'testdb', 'orders')
    await flush()
    expect(mocks.fetchTables).toHaveBeenCalledTimes(1)
    expect(mocks.fetchTableColumns).toHaveBeenCalledTimes(1)
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(1)

    store.ensureTables(1, 'testdb')
    store.ensureColumns(1, 'testdb', 'orders')
    store.ensureForeignKeys(1, 'testdb', 'orders')
    await flush()
    expect(mocks.fetchTables).toHaveBeenCalledTimes(1)
    expect(mocks.fetchTableColumns).toHaveBeenCalledTimes(1)
    expect(mocks.fetchForeignKeys).toHaveBeenCalledTimes(1)
  })

  it('退避窗口过后会自动重试', async () => {
    vi.useFakeTimers()
    try {
      const store = useMetadataStore()

      store.ensureDatabases(1)
      await flush()
      expect(mocks.fetchDatabases).toHaveBeenCalledTimes(1)

      // 窗口内：不再重试
      store.ensureDatabases(1)
      await flush()
      expect(mocks.fetchDatabases).toHaveBeenCalledTimes(1)

      // 窗口过后：允许重试
      await vi.advanceTimersByTimeAsync(META_RETRY_BACKOFF + 1)
      store.ensureDatabases(1)
      await flush()
      expect(mocks.fetchDatabases).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('手动 force 重试成功后清掉退避，回到正常缓存', async () => {
    const store = useMetadataStore()

    store.ensureDatabases(1)
    await flush()
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(1)

    // 用户修好连接后手动重试（元数据弹窗 / 刷新都走 force）
    mocks.fetchDatabases.mockResolvedValue([{ name: 'testdb', isSystem: false }])
    await store.loadDatabases(1, true)
    expect(store.ensureDatabases(1)).toEqual(['testdb'])
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(2)

    // 缓存已新鲜，继续输入不会再打后端
    await flush()
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(2)
  })

  it('invalidateConnection 会清掉退避，允许立刻重试', async () => {
    const store = useMetadataStore()

    store.ensureDatabases(1)
    await flush()
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(1)

    store.invalidateConnection(1)
    store.ensureDatabases(1)
    await flush()
    expect(mocks.fetchDatabases).toHaveBeenCalledTimes(2)
  })
})
