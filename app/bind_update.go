package app

import (
	"toolbox/app/internal/update"
)

/*
更新相关的绑定：一律薄转发。

真正的并发保护、生命周期（取消 / 重启）、发布策略（校验和强制、开发模式）
与状态快照都在 app/internal/update.Controller 里；Wails 的 updater 只负责
执行更新动作，不作为应用层状态机。
*/

// CheckUpdate 检查新版本。
//
// 已有检查或下载在跑时直接返回（不打断当前流程）：前端继续读 UpdateSnapshot 即可。
func (a *App) CheckUpdate() error {
	return a.updateCtrl.Check()
}

// DownloadUpdate 下载并安装已发现的新版本；取消走 CancelUpdate。
func (a *App) DownloadUpdate() error {
	return a.updateCtrl.Download()
}

// CancelUpdate 取消正在进行的下载（回到「有新版本可下载」状态）。
func (a *App) CancelUpdate() error {
	return a.updateCtrl.Cancel()
}

// RestartToApplyUpdate 重启应用以应用已下载的更新（仅「已就绪」时可用）。
func (a *App) RestartToApplyUpdate() error {
	return a.updateCtrl.Restart()
}

// UpdateSnapshot 当前更新状态的完整快照：前端唯一的状态源。
//
// 更新能力不可用时也返回快照（state 为 unconfigured，message 说明原因），
// 前端不需要为「不可用」单独准备一套展示逻辑。
func (a *App) UpdateSnapshot() update.Snapshot {
	return a.updateCtrl.Snapshot()
}
