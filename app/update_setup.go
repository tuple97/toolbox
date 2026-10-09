package app

import (
	"fmt"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"

	"toolbox/app/internal/update"
)

// UpdateOptions 应用内更新的装配参数（更新来源由装配层提供）。
type UpdateOptions struct {
	// Repository 更新来源：owner/repo
	Repository string
	// ChecksumAsset 校验清单资产名（例如 checksums.txt）
	ChecksumAsset string
}

// SetupUpdate 装配应用内更新能力。
//
// 为什么放在这里而不是 main.go：Controller 位于 app/internal/update，
// 按 Go 的 internal 规则只能由 app 子树导入，main 无法直接接线；
// 因此这里只保留「把来源、HTTP 客户端、签名公钥接到 Wails 更新器上」这一层，
// 真正的来源配置（仓库、清单名）仍由 main 通过 UpdateOptions 提供。
//
// 任何一步失败都只让更新能力不可用，不影响启动：更新刻意独立于数据库与业务服务，
// 数据目录损坏时用户反而更需要这条自救通道。
func SetupUpdate(wailsApp *application.App, a *App, options UpdateOptions) {
	ctrl := a.updateCtrl
	if ctrl == nil {
		return
	}

	// 开发模式通知：跑的是 Vite 开发服务器，版本号是 dev 兜底值，
	// 不能把已发布的正式版提示成「新版本」
	if update.DevMode() {
		ctrl.Unavailable(update.ErrDevMode)
		return
	}

	provider, err := github.New(github.Config{
		Repository: options.Repository,
		// 发版时随包发布校验清单，下载后核对 SHA-256；缺失则拒绝安装
		ChecksumAsset: options.ChecksumAsset,
		// 不设整体超时：连接建立阶段有超时，下载时长由 context（用户取消）控制
		HTTPClient: update.HTTPClient(),
	})
	if err != nil {
		log.Printf("更新来源不可用: %v", err)
		ctrl.Unavailable(fmt.Errorf("更新来源不可用: %w", err))
		return
	}

	if err := wailsApp.Updater.Init(updater.Config{
		CurrentVersion: NormalizedVersion(),
		// 后端要能读到下载进度（框架的进度事件只发前端），所以包装一层 Provider
		Providers: []updater.Provider{ctrl.TrackProgress(provider)},
		// 更新界面由设置页承担，不用框架自带窗口
		Window: updater.WindowNone,
		// 发布签名（Ed25519）接入点：当前为 nil，只做 SHA-256 校验
		PublicKey: update.PublicKey,
	}); err != nil {
		log.Printf("更新功能初始化失败: %v", err)
		ctrl.Unavailable(fmt.Errorf("更新功能初始化失败: %w", err))
		return
	}

	ctrl.Attach(wailsApp.Updater)
}
