import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeNotices, dismiss, notify } from '@/utils/notify'

/** 把队列清空，避免用例之间互相影响 */
function clearAll() {
  for (const notice of [...activeNotices.value]) {
    dismiss(notice.id)
  }
}

describe('提示队列（替代 ElMessage）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearAll()
  })

  afterEach(() => {
    clearAll()
    vi.useRealTimers()
  })

  it('四个入口都在，并且带上对应语气', () => {
    notify.success('保存成功')
    notify.error('读取失败')
    notify.warning('未选择连接')
    notify.info('查询已取消')

    expect(activeNotices.value.map(n => [n.tone, n.message])).toEqual([
      ['success', '保存成功'],
      ['error', '读取失败'],
      ['warning', '未选择连接'],
      ['info', '查询已取消'],
    ])
  })

  it('到时间自动消失（与旧 ElMessage 的 3 秒一致）', () => {
    notify.success('一闪而过')
    expect(activeNotices.value).toHaveLength(1)

    vi.advanceTimersByTime(3000)
    expect(activeNotices.value).toHaveLength(0)
  })

  it('可以手动关掉某一条，且只关掉那一条', () => {
    notify.success('第一条')
    notify.error('第二条')
    const first = activeNotices.value[0]
    dismiss(first.id)

    expect(activeNotices.value.map(n => n.message)).toEqual(['第二条'])
  })

  it('超出上限时丢掉最旧的，不会刷满屏幕', () => {
    for (let i = 1; i <= 6; i++) {
      notify.info(`第 ${i} 条`)
    }
    const messages = activeNotices.value.map(n => n.message)
    expect(messages).toHaveLength(4)
    expect(messages[0]).toBe('第 3 条')
    expect(messages[3]).toBe('第 6 条')
  })

  it('每次提示的 id 都不同（宿主组件靠它做 key，重复 id 会渲染错位）', () => {
    notify.info('同样的文案')
    notify.info('同样的文案')
    const [first, second] = activeNotices.value
    expect(first.id).not.toBe(second.id)
  })
})
