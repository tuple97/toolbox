// Package update 把 Wails 的更新器包装成应用自己的更新服务。
//
// 职责边界：Wails updater 只负责「真正的更新动作」（查 Release、下载、校验、
// 替换可执行文件、重启），Controller 负责把它变成应用可控的服务：
// 并发保护、生命周期（取消 / 重启）、发布策略（校验和强制、开发模式）与状态快照。
// 应用层状态机在 Controller 里，不在 Wails updater 里。
package update

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

// checkTimeout 版本检查超时。
//
// HTTP 客户端刻意不设整体超时（见 HTTPClient），所以这一步必须自己兜住：
// 网络不通时不能让界面一直转。
const checkTimeout = 20 * time.Second

// WailsUpdater 我们依赖的更新器能力。
//
// 抽成接口是为了能脱离 Wails 运行时做单元测试；*updater.Updater 天然满足。
type WailsUpdater interface {
	State() updater.State
	Check(ctx context.Context) (*updater.Release, error)
	DownloadAndInstall(ctx context.Context) error
	Restart(ctx context.Context) error
}

// Controller 更新流程控制器：同一时刻只允许一个更新动作在跑。
type Controller struct {
	mu sync.Mutex

	// appVersion 当前版本（构建时注入），即使更新能力不可用也要能报给前端
	appVersion string
	// u 已接线的 Wails 更新器；nil 表示更新能力不可用
	u WailsUpdater
	// reason 更新能力不可用的原因
	reason string

	state   State
	latest  *updater.Release
	errMsg  string
	message string

	written  int64
	total    int64
	progress int

	// cancelDownload 当前下载的取消函数；非 nil 表示有下载在跑
	cancelDownload context.CancelFunc
}

// New 创建控制器。appVersion 是当前版本（构建时注入的那个）。
func New(appVersion string) *Controller {
	return &Controller{
		appVersion: appVersion,
		state:      StateUnconfigured,
		reason:     "更新功能尚未初始化",
		progress:   0,
	}
}

// Attach 绑定已初始化的 Wails 更新器（应用启动前调用）。
func (c *Controller) Attach(u WailsUpdater) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.u = u
	c.reason = ""
	c.state = StateIdle
	c.errMsg = ""
	c.message = ""
}

// Unavailable 标记更新能力不可用（开发模式 / 初始化失败）。
//
// 只记录原因，不影响应用其它功能：数据库损坏时用户依旧能靠更新自救。
func (c *Controller) Unavailable(reason error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.u = nil
	c.state = StateUnconfigured
	c.latest = nil
	c.cancelDownload = nil
	c.resetProgressLocked()
	if reason != nil {
		c.reason = reason.Error()
	}
}

// Check 检查新版本。
//
// 已有检查或下载在跑时**直接返回**（不报错、不打断）：前端继续看快照即可，
// 不允许两个更新流程同时存在。
func (c *Controller) Check() error {
	c.mu.Lock()
	if c.u == nil {
		err := c.unavailableErrorLocked()
		c.mu.Unlock()
		return err
	}
	if inFlight(c.state) {
		c.mu.Unlock()
		return nil
	}
	c.state = StateChecking
	c.errMsg = ""
	c.message = ""
	c.resetProgressLocked()
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	defer cancel()

	rel, err := c.u.Check(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()

	if err != nil {
		msg := checkErrorMessage(err)
		c.state = StateError
		c.errMsg = msg
		return errors.New(msg)
	}
	if rel == nil {
		c.state = StateUpToDate
		c.latest = nil
		return nil
	}
	// 发布契约：没有校验和的发布包一律拒绝
	if err := requireChecksum(rel); err != nil {
		c.state = StateError
		c.errMsg = err.Error()
		c.latest = nil
		return err
	}
	c.latest = rel
	c.state = StateAvailable
	return nil
}

// Download 下载并安装已发现的新版本。
//
// 已有下载在跑时直接返回；没有可下载的版本（或还在检查）时报错。
func (c *Controller) Download() error {
	c.mu.Lock()
	if c.u == nil {
		err := c.unavailableErrorLocked()
		c.mu.Unlock()
		return err
	}
	switch c.state {
	case StateDownloading, StateVerifying, StateInstalling:
		c.mu.Unlock()
		return nil
	}
	if c.state == StateChecking {
		c.mu.Unlock()
		return errors.New("正在检查更新，请稍后")
	}
	if c.latest == nil {
		c.mu.Unlock()
		return errors.New("没有可下载的更新，请先检查更新")
	}

	ctx, cancel := context.WithCancel(context.Background())
	c.cancelDownload = cancel
	c.state = StateDownloading
	c.errMsg = ""
	c.message = ""
	c.resetProgressLocked()
	c.mu.Unlock()

	defer cancel()

	err := c.u.DownloadAndInstall(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancelDownload = nil

	switch {
	case err == nil:
		c.state = StateReady
		c.progress = 100
		return nil
	case errors.Is(err, context.Canceled):
		// 用户主动取消不是失败：回到「可下载」，保留已找到的版本
		c.state = StateAvailable
		c.message = "已取消下载"
		c.errMsg = ""
		c.resetProgressLocked()
		return nil
	default:
		msg := downloadErrorMessage(err)
		c.state = StateError
		c.errMsg = msg
		return errors.New(msg)
	}
}

// Cancel 取消正在进行的下载。
//
// 只取消当前下载的 context：网络请求会立刻中断，控制器回到「可下载」状态，
// 不把用户的主动取消当成错误。
func (c *Controller) Cancel() error {
	c.mu.Lock()
	cancel := c.cancelDownload
	c.mu.Unlock()
	if cancel == nil {
		return errors.New("当前没有正在进行的下载")
	}
	cancel()
	return nil
}

// Restart 重启应用以应用已安装的更新。只有「已就绪」状态允许重启。
func (c *Controller) Restart() error {
	c.mu.Lock()
	u := c.u
	state := c.state
	c.mu.Unlock()

	if u == nil {
		return errors.New("更新功能不可用")
	}
	if state != StateReady {
		return errors.New("更新尚未就绪")
	}
	// 成功时进程会跟着退出，返回值多半到不了前端
	return u.Restart(context.Background())
}

// TrackProgress 包装 Provider，把下载进度同步进快照。
//
// 框架的进度事件只发给前端，后端要拿到进度只能从 Provider 这一层拦。
func (c *Controller) TrackProgress(provider updater.Provider) updater.Provider {
	return &trackedProvider{Provider: provider, ctrl: c}
}

// trackedProvider 在原 Provider 上叠加进度上报。
type trackedProvider struct {
	updater.Provider
	ctrl *Controller
}

// Download 转发下载并把进度写进控制器（同时保留框架自己的进度回调）。
func (p *trackedProvider) Download(
	ctx context.Context,
	release *updater.Release,
	dst io.Writer,
	onProgress func(written, total int64),
) error {
	return p.Provider.Download(ctx, release, dst, func(written, total int64) {
		p.ctrl.setProgress(written, total)
		if onProgress != nil {
			onProgress(written, total)
		}
	})
}

// setProgress 记录下载进度（total 未知时 progress 为 -1）。
func (c *Controller) setProgress(written, total int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.written = written
	if total > 0 {
		c.total = total
	}
	switch {
	case c.total <= 0:
		c.progress = -1
	case written >= c.total:
		c.progress = 100
	default:
		c.progress = int(written * 100 / c.total)
	}
}

// resetProgressLocked 清空进度。调用方必须持有 c.mu。
func (c *Controller) resetProgressLocked() {
	c.written = 0
	c.total = 0
	c.progress = 0
}

// unavailableErrorLocked 更新能力不可用时的错误，带上原因。调用方必须持有 c.mu。
func (c *Controller) unavailableErrorLocked() error {
	if c.reason == "" {
		return errors.New("更新功能不可用")
	}
	return errors.New(c.reason)
}

// checkErrorMessage 把检查失败翻译成给用户看的文案。
func checkErrorMessage(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "检查更新超时，请检查网络后重试"
	}
	return "检查更新失败: " + err.Error()
}

// downloadErrorMessage 把下载失败翻译成给用户看的文案。
func downloadErrorMessage(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "下载已取消"
	case errors.Is(err, context.DeadlineExceeded):
		return "下载超时，请检查网络后重试"
	case errors.Is(err, updater.ErrDownloadInProgress):
		return "已有下载任务在进行"
	case errors.Is(err, updater.ErrNoPendingRelease):
		return "没有可下载的更新，请先检查更新"
	}
	return "下载更新失败: " + err.Error()
}
