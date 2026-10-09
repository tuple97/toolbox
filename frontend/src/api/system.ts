/** 应用与运行环境信息 API */
import { GetAppInfo, GetAppStartupState, RetryInit } from './bindings'
import type { AppStartupState } from '@/types'

export interface AppInfo {
  name: string
  version: string
  goVersion: string
  platform: string
  arch: string
}

/** 读取应用信息，失败时返回空对象 */
export async function fetchAppInfo(): Promise<Partial<AppInfo>> {
  try {
    const info = await GetAppInfo()
    return {
      name: String(info?.name ?? ''),
      version: String(info?.version ?? ''),
      goVersion: String(info?.goVersion ?? ''),
      platform: String(info?.platform ?? ''),
      arch: String(info?.arch ?? ''),
    }
  }
  catch {
    return {}
  }
}

/** 把绑定返回的启动状态收敛成前端类型（未知值按就绪处理） */
function toAppStartupState(raw: { state?: unknown, error?: unknown } | undefined): AppStartupState {
  const value = String(raw?.state ?? '')
  return {
    state: value === 'degraded' || value === 'initializing' ? value : 'ready',
    error: String(raw?.error ?? ''),
  }
}

/**
 * 读取应用启动状态。
 *
 * 调用失败时按「就绪」处理：更新/初始化都没问题却弹一条故障提示，
 * 比漏报更打扰用户。
 */
export async function fetchAppStartupState(): Promise<AppStartupState> {
  try {
    return toAppStartupState(await GetAppStartupState())
  }
  catch {
    return { state: 'ready', error: '' }
  }
}

/** 重试初始化（数据库损坏、目录权限异常时的自救入口） */
export async function retryInit(): Promise<AppStartupState> {
  return toAppStartupState(await RetryInit())
}
