/**
 * 更新流程状态。
 *
 * 后端快照（`UpdateSnapshot`）是唯一权威状态：`wails:updater:*` 事件只当
 * 「状态可能变了」的通知，收到后统一回后端拉一次快照整体替换本地状态。
 * 这样即使更新在设置页打开之前就开始了，界面也能立刻对齐真实状态；
 * 启动自动检查与手动检查也天然共用同一套状态与串行保护（后端只允许一个流程在跑）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  cancelUpdate,
  checkUpdate,
  downloadUpdate,
  fetchUpdateSnapshot,
  onUpdateProgress,
  onUpdateStateEvent,
  restartToApplyUpdate,
} from '@/api/update'
import type { UpdateSnapshot, UpdateState } from '@/types'

/** 还没拿到后端数据时的占位快照，避免模板里到处判空 */
const EMPTY_SNAPSHOT: UpdateSnapshot = {
  state: 'idle',
  currentVersion: '',
  latestVersion: '',
  notes: '',
  publishedAt: '',
  assetName: '',
  assetSize: 0,
  available: false,
  progress: 0,
  written: 0,
  total: 0,
  message: '',
  error: '',
  canCheck: false,
  canDownload: false,
  canCancel: false,
  canRestart: false,
}

/** 处于「有流程在跑」的阶段 */
const BUSY_STATES: UpdateState[] = ['checking', 'downloading', 'verifying', 'installing']

export const useUpdateStore = defineStore('update', () => {
  /** 后端权威快照 */
  const snapshot = ref<UpdateSnapshot>({ ...EMPTY_SNAPSHOT })
  /** 进度事件比快照刷新更频繁：下载中的进度条直接吃事件值 */
  const eventProgress = ref<number | null>(null)
  /** 动作抛出的错误（正常情况下后端已写进快照，这里只是兜底） */
  const actionError = ref('')

  /** 当前阶段 */
  const state = computed<UpdateState>(() => snapshot.value.state)
  /** 是否有流程在跑 */
  const busy = computed(() => BUSY_STATES.includes(state.value))
  /** 下载进度百分比（-1 表示总长未知） */
  const progress = computed(() => {
    if (state.value !== 'downloading') {
      return snapshot.value.progress
    }
    return eventProgress.value ?? snapshot.value.progress
  })
  /** 可展示的错误文案 */
  const error = computed(() => snapshot.value.error || actionError.value)

  /** 刷新序号：只接受最后一次请求的结果，避免旧响应覆盖新状态 */
  let refreshSeq = 0

  /** 拉一次权威快照 */
  async function refresh(): Promise<void> {
    const seq = ++refreshSeq
    try {
      const next = await fetchUpdateSnapshot()
      if (seq !== refreshSeq) {
        return
      }
      snapshot.value = next
      if (next.state !== 'downloading') {
        eventProgress.value = null
      }
    }
    catch {
      // 拉不到就保持现状：绑定异常不该把界面清空
    }
  }

  let inited = false

  /** 订阅状态变化并拉一次初始快照（重复调用只生效一次） */
  function init(): void {
    if (inited) {
      return
    }
    inited = true
    onUpdateStateEvent(() => {
      void refresh()
    })
    onUpdateProgress((payload) => {
      if (snapshot.value.state !== 'downloading') {
        return
      }
      eventProgress.value = payload.percent
    })
    void refresh()
  }

  /** 统一动作入口：执行 → 拉权威快照（前端不自己维护过渡态） */
  async function run(action: () => Promise<unknown>): Promise<void> {
    actionError.value = ''
    try {
      await action()
    }
    catch (e) {
      actionError.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      await refresh()
    }
  }

  /** 检查新版本（已有流程在跑时后端会直接返回） */
  function check(): Promise<void> {
    return run(checkUpdate)
  }

  /** 下载并安装已发现的新版本 */
  function download(): Promise<void> {
    return run(downloadUpdate)
  }

  /** 取消正在进行的下载 */
  function cancel(): Promise<void> {
    return run(cancelUpdate)
  }

  /** 重启应用以应用已下载的更新 */
  function restart(): Promise<void> {
    return run(restartToApplyUpdate)
  }

  return {
    snapshot,
    state,
    busy,
    progress,
    error,
    init,
    refresh,
    check,
    download,
    cancel,
    restart,
  }
})
