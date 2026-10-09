import { beforeEach, describe, expect, it } from 'vitest'
import { askConfirm, pendingConfirm, settleConfirm } from '@/utils/confirm'

describe('确认框（替代 ElMessageBox.confirm）', () => {
  beforeEach(() => {
    // 结算掉上一个用例可能留下的请求
    settleConfirm(false)
  })

  it('确定 → true，取消 → false', async () => {
    const confirmed = askConfirm({ message: '确定删除吗？' })
    settleConfirm(true)
    await expect(confirmed).resolves.toBe(true)

    const cancelled = askConfirm({ message: '确定删除吗？' })
    settleConfirm(false)
    await expect(cancelled).resolves.toBe(false)
  })

  it('默认标题 / 按钮文案 / 语气，调用方只写正文就够', () => {
    void askConfirm({ message: '继续吗？' })
    expect(pendingConfirm.value).toMatchObject({
      title: '请确认',
      message: '继续吗？',
      confirmText: '确定',
      cancelText: '取消',
      tone: 'warning',
    })
  })

  it('可以自定义标题、按钮与危险语气', () => {
    void askConfirm({
      message: '生产库写操作不可撤销',
      title: '写操作确认',
      confirmText: '确认执行',
      cancelText: '再想想',
      tone: 'danger',
    })
    expect(pendingConfirm.value).toMatchObject({
      title: '写操作确认',
      confirmText: '确认执行',
      cancelText: '再想想',
      tone: 'danger',
    })
  })

  it('结算后清空待确认状态，重复结算不会再触发回调', async () => {
    const confirmed = askConfirm({ message: '第一次' })
    settleConfirm(true)
    await expect(confirmed).resolves.toBe(true)
    expect(pendingConfirm.value).toBeNull()

    // 第二次结算没有请求可结算：不能报错，也不能把「已结算」的结果改掉
    expect(() => settleConfirm(false)).not.toThrow()
  })

  it('新请求顶掉旧请求：旧的按「取消」结算，不会永久悬着', async () => {
    const first = askConfirm({ message: '第一次' })
    const second = askConfirm({ message: '第二次' })

    await expect(first).resolves.toBe(false)
    expect(pendingConfirm.value?.message).toBe('第二次')

    settleConfirm(true)
    await expect(second).resolves.toBe(true)
  })
})
