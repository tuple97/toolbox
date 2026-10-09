/**
 * 应用内更新 API。
 *
 * 状态以 `UpdateSnapshot` 为准（后端权威）；`wails:updater:*` 事件只当
 * 「状态可能变了」的通知，收到后回后端重新拉快照，前端不自己推断状态。
 */
import {
  CancelUpdate,
  CheckUpdate,
  DownloadUpdate,
  RestartToApplyUpdate,
  UpdateSnapshot as ReadUpdateSnapshot,
} from './bindings'
import { EventsOn } from './runtime'
import type { UpdateSnapshot, UpdateState } from '@/types'

/** 全部合法阶段（后端理论上只会给这几个值） */
const UPDATE_STATES: UpdateState[] = [
  'unconfigured',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'verifying',
  'installing',
  'ready',
  'error',
]

/** 会影响更新状态的框架事件 */
const UPDATE_STATE_EVENTS = [
  'wails:updater:check-started',
  'wails:updater:update-available',
  'wails:updater:no-update',
  'wails:updater:download-started',
  'wails:updater:download-complete',
  'wails:updater:verifying',
  'wails:updater:installing',
  'wails:updater:update-ready',
  'wails:updater:error',
]

/** 未知阶段一律回退 idle，避免界面拿到不认识的值 */
function toUpdateState(raw: unknown): UpdateState {
  const value = String(raw ?? '')
  return (UPDATE_STATES as string[]).includes(value) ? value as UpdateState : 'idle'
}

/** 当前更新状态快照（后端权威状态） */
export async function fetchUpdateSnapshot(): Promise<UpdateSnapshot> {
  const snap = await ReadUpdateSnapshot()
  return {
    state: toUpdateState(snap?.state),
    currentVersion: String(snap?.currentVersion ?? ''),
    latestVersion: String(snap?.latestVersion ?? ''),
    notes: String(snap?.notes ?? ''),
    publishedAt: String(snap?.publishedAt ?? ''),
    assetName: String(snap?.assetName ?? ''),
    assetSize: Number(snap?.assetSize ?? 0),
    available: snap?.available === true,
    progress: Number(snap?.progress ?? 0),
    written: Number(snap?.written ?? 0),
    total: Number(snap?.total ?? 0),
    message: String(snap?.message ?? ''),
    error: String(snap?.error ?? ''),
    canCheck: snap?.canCheck === true,
    canDownload: snap?.canDownload === true,
    canCancel: snap?.canCancel === true,
    canRestart: snap?.canRestart === true,
  }
}

/**
 * 检查新版本。
 * 后端已有流程在跑时直接返回（不打断），所以这里可能什么都没发生。
 */
export function checkUpdate(): Promise<void> {
  return CheckUpdate()
}

/** 下载并安装已发现的新版本 */
export function downloadUpdate(): Promise<void> {
  return DownloadUpdate()
}

/** 取消正在进行的下载（回到「有新版本可下载」状态） */
export function cancelUpdate(): Promise<void> {
  return CancelUpdate()
}

/** 重启应用以应用已下载的更新 */
export function restartToApplyUpdate(): Promise<void> {
  return RestartToApplyUpdate()
}

/** 仅作通知：回调里应该去重新拉一次快照 */
export function onUpdateStateEvent(callback: () => void): () => void {
  const offs = UPDATE_STATE_EVENTS.map(name => EventsOn(name, () => callback()))
  return () => {
    offs.forEach(off => off())
  }
}

/** 下载进度（框架事件；权威进度同样在快照里） */
export interface UpdateProgress {
  /** 已下载字节数 */
  written: number
  /** 总字节数（未知为 0） */
  total: number
  /** 百分比；总长未知时为 null */
  percent: number | null
}

/** 订阅下载进度 */
export function onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void {
  return EventsOn('wails:updater:download-progress', (data) => {
    const payload = data as { written?: number, total?: number } | undefined
    const written = Number(payload?.written ?? 0)
    const total = Number(payload?.total ?? 0)
    callback({
      written,
      total,
      percent: total > 0 ? Math.min(100, Math.round((written / total) * 100)) : null,
    })
  })
}
