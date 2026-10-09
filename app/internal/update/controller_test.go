package update

import (
	"context"
	"crypto/sha256"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

// fakeUpdater 更新器桩：可控制检查结果与下载行为。
type fakeUpdater struct {
	mu sync.Mutex

	state   updater.State
	release *updater.Release
	// checkErr 检查失败时的错误
	checkErr error
	// blockDownload 为 true 时下载一直阻塞到 context 结束
	blockDownload bool
	// downloadErr 非阻塞下载时的返回值
	downloadErr error

	checkCalls    int
	downloadCalls int
	restartCalls  int
}

func (f *fakeUpdater) State() updater.State {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakeUpdater) Check(context.Context) (*updater.Release, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checkCalls++
	if f.checkErr != nil {
		return nil, f.checkErr
	}
	return f.release, nil
}

func (f *fakeUpdater) DownloadAndInstall(ctx context.Context) error {
	f.mu.Lock()
	f.downloadCalls++
	f.state = updater.StateDownloading
	block := f.blockDownload
	err := f.downloadErr
	f.mu.Unlock()

	if block {
		<-ctx.Done()
		f.mu.Lock()
		f.state = updater.StateError
		f.mu.Unlock()
		return ctx.Err()
	}
	return err
}

func (f *fakeUpdater) Restart(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restartCalls++
	return nil
}

func (f *fakeUpdater) calls() (check, download, restart int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checkCalls, f.downloadCalls, f.restartCalls
}

// validRelease 满足发布契约（带 SHA-256 校验和）的版本。
func validRelease() *updater.Release {
	return &updater.Release{
		Version: "0.2.0",
		Verification: &updater.Verification{
			DigestAlgo: "sha256",
			Digest:     make([]byte, sha256.Size),
		},
		Artifact: updater.Artifact{Filename: "toolbox-windows-amd64.exe", Size: 1024},
	}
}

// waitForState 等到快照进入指定状态（下载是异步启动的）。
func waitForState(t *testing.T, c *Controller, want State) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.Snapshot().State == string(want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待状态 %s 超时，当前 %s", want, c.Snapshot().State)
}

// 未接线（开发模式 / 初始化失败）时不报 panic，动作返回可读错误。
func TestUnavailableController(t *testing.T) {
	ctrl := New("0.1.0")
	ctrl.Unavailable(ErrDevMode)

	snap := ctrl.Snapshot()
	if snap.State != string(StateUnconfigured) {
		t.Fatalf("状态 = %s，期望 unconfigured", snap.State)
	}
	if snap.CurrentVersion != "0.1.0" {
		t.Errorf("当前版本 = %s，期望 0.1.0", snap.CurrentVersion)
	}
	if snap.CanCheck || snap.CanDownload || snap.CanRestart {
		t.Errorf("不可用状态下不应该允许任何动作: %+v", snap)
	}
	if err := ctrl.Check(); err == nil || !strings.Contains(err.Error(), "开发模式") {
		t.Errorf("Check 应返回不可用原因，实际 %v", err)
	}
}

// 检查成功 → available，且快照带上新版本信息。
func TestCheckFindsUpdate(t *testing.T) {
	fake := &fakeUpdater{release: validRelease()}
	ctrl := New("0.1.0")
	ctrl.Attach(fake)

	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}
	snap := ctrl.Snapshot()
	if snap.State != string(StateAvailable) || !snap.Available {
		t.Fatalf("状态 = %s / available = %v", snap.State, snap.Available)
	}
	if snap.LatestVersion != "0.2.0" || snap.AssetName != "toolbox-windows-amd64.exe" {
		t.Errorf("快照信息不完整: %+v", snap)
	}
	if !snap.CanCheck || !snap.CanDownload || snap.CanCancel {
		t.Errorf("动作开关不对: %+v", snap)
	}
}

// 已是最新版本。
func TestCheckUpToDate(t *testing.T) {
	ctrl := New("0.2.0")
	ctrl.Attach(&fakeUpdater{})

	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}
	snap := ctrl.Snapshot()
	if snap.State != string(StateUpToDate) || snap.Available {
		t.Fatalf("状态 = %s / available = %v", snap.State, snap.Available)
	}
	if snap.CanDownload {
		t.Error("没有新版本时不应允许下载")
	}
}

// 发布契约：缺少校验和的版本必须拒绝。
func TestCheckRejectsMissingChecksum(t *testing.T) {
	release := validRelease()
	release.Verification = nil
	ctrl := New("0.1.0")
	ctrl.Attach(&fakeUpdater{release: release})

	err := ctrl.Check()
	if err == nil || !strings.Contains(err.Error(), "校验和") {
		t.Fatalf("应因缺少校验和被拒绝，实际 %v", err)
	}
	snap := ctrl.Snapshot()
	if snap.State != string(StateError) || snap.Available || snap.CanDownload {
		t.Errorf("拒绝后不应留下可下载的版本: %+v", snap)
	}
}

// 检查失败时给出可读文案。
func TestCheckFailure(t *testing.T) {
	ctrl := New("0.1.0")
	ctrl.Attach(&fakeUpdater{checkErr: context.DeadlineExceeded})

	if err := ctrl.Check(); err == nil {
		t.Fatal("期望检查失败")
	}
	snap := ctrl.Snapshot()
	if snap.State != string(StateError) || !strings.Contains(snap.Error, "超时") {
		t.Errorf("错误文案不对: %+v", snap)
	}
}

// 下载中再次检查：不打断当前流程，也不改写状态。
func TestCheckDuringDownloadIsIgnored(t *testing.T) {
	fake := &fakeUpdater{release: validRelease(), blockDownload: true}
	ctrl := New("0.1.0")
	ctrl.Attach(fake)
	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}

	done := make(chan struct{})
	go func() {
		_ = ctrl.Download()
		close(done)
	}()
	waitForState(t, ctrl, StateDownloading)

	if err := ctrl.Check(); err != nil {
		t.Fatalf("下载中的 Check 应静默返回，实际 %v", err)
	}
	if state := ctrl.Snapshot().State; state != string(StateDownloading) {
		t.Fatalf("状态被改写为 %s", state)
	}
	if check, _, _ := fake.calls(); check != 1 {
		t.Errorf("下载中不应再次调用检查，实际 %d 次", check)
	}

	if err := ctrl.Cancel(); err != nil {
		t.Fatalf("Cancel 失败: %v", err)
	}
	<-done
}

// 下载中再次下载：直接返回，不重复发起。
func TestDownloadDuringDownloadIsNoop(t *testing.T) {
	fake := &fakeUpdater{release: validRelease(), blockDownload: true}
	ctrl := New("0.1.0")
	ctrl.Attach(fake)
	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}

	done := make(chan struct{})
	go func() {
		_ = ctrl.Download()
		close(done)
	}()
	waitForState(t, ctrl, StateDownloading)

	if err := ctrl.Download(); err != nil {
		t.Fatalf("下载中的 Download 应静默返回，实际 %v", err)
	}
	if _, download, _ := fake.calls(); download != 1 {
		t.Errorf("不应重复发起下载，实际 %d 次", download)
	}

	_ = ctrl.Cancel()
	<-done
}

// 取消下载不是错误：回到可下载状态并保留已发现的版本。
func TestCancelReturnsToAvailable(t *testing.T) {
	fake := &fakeUpdater{release: validRelease(), blockDownload: true}
	ctrl := New("0.1.0")
	ctrl.Attach(fake)
	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- ctrl.Download() }()
	waitForState(t, ctrl, StateDownloading)

	if !ctrl.Snapshot().CanCancel {
		t.Error("下载中应允许取消")
	}
	if err := ctrl.Cancel(); err != nil {
		t.Fatalf("Cancel 失败: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("取消不应返回错误，实际 %v", err)
	}

	snap := ctrl.Snapshot()
	if snap.State != string(StateAvailable) {
		t.Fatalf("取消后状态 = %s，期望 available", snap.State)
	}
	if snap.Message != "已取消下载" || snap.Error != "" {
		t.Errorf("取消后不应记为错误: %+v", snap)
	}
	if !snap.CanDownload {
		t.Error("取消后应可以重新下载")
	}
}

// 下载失败 → error，且允许重试。
func TestDownloadFailureAllowsRetry(t *testing.T) {
	fake := &fakeUpdater{release: validRelease(), downloadErr: context.DeadlineExceeded}
	ctrl := New("0.1.0")
	ctrl.Attach(fake)
	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}

	if err := ctrl.Download(); err == nil {
		t.Fatal("期望下载失败")
	}
	snap := ctrl.Snapshot()
	if snap.State != string(StateError) || !strings.Contains(snap.Error, "超时") {
		t.Errorf("错误文案不对: %+v", snap)
	}
	if !snap.CanDownload {
		t.Error("失败后应允许重试下载")
	}
	if snap.CanRestart {
		t.Error("失败时不应允许重启")
	}
}

// 重启只在「已就绪」时允许。
func TestRestartRequiresReady(t *testing.T) {
	fake := &fakeUpdater{release: validRelease()}
	ctrl := New("0.1.0")
	ctrl.Attach(fake)

	if err := ctrl.Restart(); err == nil {
		t.Fatal("未就绪时不应允许重启")
	}

	if err := ctrl.Check(); err != nil {
		t.Fatalf("Check 失败: %v", err)
	}
	if err := ctrl.Download(); err != nil {
		t.Fatalf("Download 失败: %v", err)
	}
	snap := ctrl.Snapshot()
	if snap.State != string(StateReady) || !snap.CanRestart || snap.Progress != 100 {
		t.Fatalf("安装完成后的快照不对: %+v", snap)
	}
	if err := ctrl.Restart(); err != nil {
		t.Fatalf("Restart 失败: %v", err)
	}
	if _, _, restart := fake.calls(); restart != 1 {
		t.Errorf("重启调用次数 = %d", restart)
	}
}

// 下载进度装饰器：把进度写进快照，同时保留框架自己的回调。
func TestTrackProgress(t *testing.T) {
	ctrl := New("0.1.0")
	provider := &fakeProvider{}
	tracked := ctrl.TrackProgress(provider)

	frameworkProgress := make([]int64, 0, 1)
	err := tracked.Download(
		context.Background(),
		validRelease(),
		io.Discard,
		func(written, total int64) { frameworkProgress = append(frameworkProgress, written) },
	)
	if err != nil {
		t.Fatalf("下载失败: %v", err)
	}
	if len(frameworkProgress) != 1 {
		t.Errorf("框架的进度回调被吞掉了: %v", frameworkProgress)
	}
	if got := ctrl.Snapshot().Progress; got != 50 {
		t.Errorf("进度 = %d，期望 50", got)
	}
}

// fakeProvider 只会汇报一次 50% 进度的 Provider。
type fakeProvider struct{}

func (p *fakeProvider) Name() string { return "fake" }

func (p *fakeProvider) Check(context.Context, updater.CheckRequest) (*updater.Release, error) {
	return nil, nil
}

func (p *fakeProvider) Download(
	_ context.Context,
	_ *updater.Release,
	dst io.Writer,
	onProgress func(written, total int64),
) error {
	if _, err := dst.Write(make([]byte, 8)); err != nil {
		return err
	}
	onProgress(512, 1024)
	return nil
}
