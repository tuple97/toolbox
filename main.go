package main

import (
	"embed"
	"fmt"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/app"
)

//go:embed all:frontend/dist
var assets embed.FS

const (
	appName   = "开发工具箱"
	appWidth  = 1424
	appHeight = 800
	// repository 更新来源（GitHub Releases）
	repository = "tuple97/toolbox"
	// checksumAsset 校验清单资产名：与 exe 一起上传，下载后核对 SHA-256
	checksumAsset = "checksums.txt"
)

func main() {
	// `--version` 是产品接口：发布流水线用它校验注入到 exe 里的版本号
	if printVersion() {
		return
	}

	// 创建业务实例
	service := app.NewApp()

	// 创建 Wails v3 应用
	wailsApp := application.New(application.Options{
		Name:        appName,
		Description: "桌面效率工具箱",
		Services: []application.Service{
			application.NewService(service),
		},
		Assets: application.AssetOptions{
			// 内置产物 + 插件静态资源（/plugins/<id>/<version>/...）二合一：
			// 插件前端 ESM 由前端动态 import 这里的地址加载
			Handler: app.NewPluginAssetHandler(service, application.BundledAssetFileServer(assets)),
		},
		// 退出前通知前端保存
		ShouldQuit: func() bool {
			service.NotifyBeforeQuit()
			return true
		},
	})

	// 注入应用实例
	service.Attach(wailsApp)

	// 装配应用内更新（来源配置在这里给出，接线细节见 app.SetupUpdate）
	app.SetupUpdate(wailsApp, service, app.UpdateOptions{
		Repository:    repository,
		ChecksumAsset: checksumAsset,
	})

	// 创建主窗口
	mainWindow := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     appName,
		Width:     appWidth,
		Height:    appHeight,
		MinWidth:  1024,
		MinHeight: 700,
		// 无边框窗口，标题栏由前端接管
		Frameless: true,
		// 与暗色主题背景色一致
		BackgroundColour: application.RGBA{Red: 15, Green: 23, Blue: 42, Alpha: 255},
	})

	// 注入主窗口
	service.AttachWindow(mainWindow)

	if err := wailsApp.Run(); err != nil {
		log.Fatal(err)
	}
}

// printVersion 处理 `--version`：输出版本号后返回 true（由调用方直接结束）。
//
// 打包版是 GUI 子系统（没有控制台），但 stdout 被重定向时（发布流水线里）
// 依旧能读到输出，因此 CI 可以拿它做「exe 内的版本号 == git tag」的硬校验。
func printVersion() bool {
	for _, arg := range os.Args[1:] {
		if arg == "--version" || arg == "-version" {
			fmt.Println(app.NormalizedVersion())
			return true
		}
	}
	return false
}
