/**
 * 更新流程编排：启动检查 → 询问 → 下载 → 提示重启。
 *
 * 状态与并发保护都在 updateStore / 后端控制器里，这里只负责
 * 「按设置决定要不要查」和弹窗编排；设置页的按钮走同一套 store 动作。
 */
import { useConfigStore } from '@/stores/configStore'
import { useUpdateStore } from '@/stores/updateStore'
import { askConfirm } from '@/utils/confirm'
import { notify } from '@/utils/notify'

/** 启动时按设置自动检查：有新版本就问一次；检查失败静默，不打扰使用 */
export async function autoCheckUpdateOnStartup(): Promise<void> {
  const store = useUpdateStore()

  if (useConfigStore().values.app_auto_update !== 'true') {
    return
  }
  // 更新能力不可用（开发模式 / 初始化失败）或已有流程在跑：静默跳过
  if (!store.snapshot.canCheck) {
    return
  }

  await store.check()
  if (!store.snapshot.available) {
    return
  }

  const confirmed = await askConfirm({
    title: '发现新版本',
    message: `v${store.snapshot.latestVersion} 已发布，是否现在更新？`,
    confirmText: '立即更新',
  })
  if (confirmed) {
    await installUpdate()
  }
}

/** 下载并安装更新，完成后询问是否重启（启动流程与设置页共用） */
export async function installUpdate(): Promise<void> {
  const store = useUpdateStore()
  notify.info('正在下载更新…')

  await store.download()

  if (store.state === 'error') {
    notify.error(store.error || '下载更新失败')
    return
  }
  // 用户主动取消：状态里已有说明，不必再弹错误
  if (store.state !== 'ready') {
    return
  }

  notify.success('更新已下载完成')
  const confirmed = await askConfirm({
    title: '更新已就绪',
    message: '重启应用即可完成更新，现在重启？',
    confirmText: '立即重启',
  })
  if (confirmed) {
    await store.restart()
  }
}
