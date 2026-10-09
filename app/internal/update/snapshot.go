package update

import (
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

// State 更新流程所处阶段。
//
// 取值与 Wails updater 的状态机对齐，前端只认这一套：
// 前端不再自己推断状态，而是镜像 Snapshot。
type State string

const (
	// StateUnconfigured 更新能力不可用（开发模式 / 初始化失败）
	StateUnconfigured State = "unconfigured"
	// StateIdle 空闲，可以检查
	StateIdle State = "idle"
	// StateChecking 正在检查
	StateChecking State = "checking"
	// StateUpToDate 已是最新版本
	StateUpToDate State = "up-to-date"
	// StateAvailable 有新版本可下载
	StateAvailable State = "available"
	// StateDownloading 正在下载
	StateDownloading State = "downloading"
	// StateVerifying 正在校验下载结果
	StateVerifying State = "verifying"
	// StateInstalling 正在安装
	StateInstalling State = "installing"
	// StateReady 已安装，重启后生效
	StateReady State = "ready"
	// StateError 上一次操作失败
	StateError State = "error"
)

// Snapshot 更新状态的完整快照：前端唯一的状态源。
type Snapshot struct {
	// State 当前阶段，见上面的 State 常量
	State string `json:"state"`
	// CurrentVersion 当前运行的版本
	CurrentVersion string `json:"currentVersion"`
	// LatestVersion 已发现的新版本（无则空）
	LatestVersion string `json:"latestVersion"`
	// Notes 发版说明（GitHub Release 正文）
	Notes string `json:"notes"`
	// PublishedAt 发布时间（RFC3339，未知时为空）
	PublishedAt string `json:"publishedAt"`
	// AssetName 更新包文件名
	AssetName string `json:"assetName"`
	// AssetSize 更新包字节数
	AssetSize int64 `json:"assetSize"`
	// Available 是否已发现可安装的新版本
	Available bool `json:"available"`
	// Progress 下载进度百分比；-1 表示总长未知
	Progress int `json:"progress"`
	// Written 已下载字节数
	Written int64 `json:"written"`
	// Total 更新包总字节数（未知为 0）
	Total int64 `json:"total"`
	// Message 状态说明（不可用原因 / 已取消等）
	Message string `json:"message"`
	// Error 最近一次失败原因（无失败为空）
	Error string `json:"error"`
	// CanCheck 现在可以发起检查
	CanCheck bool `json:"canCheck"`
	// CanDownload 现在可以（或重试）下载
	CanDownload bool `json:"canDownload"`
	// CanCancel 现在可以取消下载
	CanCancel bool `json:"canCancel"`
	// CanRestart 现在可以重启生效
	CanRestart bool `json:"canRestart"`
}

// Snapshot 当前完整状态。前端只读它，不再自己推断状态。
func (c *Controller) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()

	state := c.effectiveStateLocked()

	snap := Snapshot{
		State:          string(state),
		CurrentVersion: c.appVersion,
		Progress:       c.progress,
		Written:        c.written,
		Total:          c.total,
		Message:        c.message,
		Error:          c.errMsg,
		Available:      c.latest != nil,
	}
	if state == StateUnconfigured {
		snap.Message = c.reason
		snap.Error = ""
	}
	if c.latest != nil {
		snap.LatestVersion = c.latest.Version
		snap.Notes = c.latest.Notes
		snap.AssetName = c.latest.Artifact.Filename
		snap.AssetSize = c.latest.Artifact.Size
		if !c.latest.PublishedAt.IsZero() {
			snap.PublishedAt = c.latest.PublishedAt.Format(time.RFC3339)
		}
	}

	configured := c.u != nil
	snap.CanCheck = configured && !inFlight(state)
	// 失败后允许重试：只要还有已发现的版本，且没有别的流程在跑
	snap.CanDownload = configured && c.latest != nil &&
		(state == StateAvailable || state == StateError)
	snap.CanCancel = state == StateDownloading
	snap.CanRestart = configured && state == StateReady
	return snap
}

// effectiveStateLocked 返回对外的阶段。
//
// 校验与安装由框架在一次 DownloadAndInstall 调用内部完成、且瞬时即逝，
// 这里实时镜像框架阶段，免得界面把这段过程一直显示成「下载 100%」。
// 调用方必须持有 c.mu。
func (c *Controller) effectiveStateLocked() State {
	if c.state != StateDownloading || c.u == nil {
		return c.state
	}
	switch c.u.State() {
	case updater.StateVerifying:
		return StateVerifying
	case updater.StateInstalling:
		return StateInstalling
	case updater.StateReady:
		return StateReady
	default:
		return c.state
	}
}

// inFlight 该阶段是否已有更新流程在跑（此时不允许再发起检查）。
func inFlight(state State) bool {
	switch state {
	case StateChecking, StateDownloading, StateVerifying, StateInstalling:
		return true
	default:
		return false
	}
}
