package app

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// Version 当前应用版本号；发布构建用
// `-ldflags "-X toolbox/app.Version=1.2.3"` 覆盖
var Version = "0.1.1"

// NormalizedVersion 去掉版本号可能带的 "v" 前缀（updater 按 semver 比较，标签习惯写 v1.2.3）
func NormalizedVersion() string {
	return strings.TrimPrefix(Version, "v")
}

// AppInfo 应用与运行环境信息
type AppInfo struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	GoVersion string `json:"goVersion"`
	Platform  string `json:"platform"`
	Arch      string `json:"arch"`
}

// GetAppInfo 返回应用与运行环境信息。
func (a *App) GetAppInfo() AppInfo {
	return AppInfo{
		Name:      "Toolbox",
		Version:   Version,
		GoVersion: runtime.Version(),
		Platform:  runtime.GOOS,
		Arch:      runtime.GOARCH,
	}
}

// OpenExternalURL 用系统默认浏览器打开一个链接。
//
// 只放行 http/https：这个入口会直接把字符串交给系统处理，
// 不做协议白名单的话前端一旦拼错参数就会变成「打开任意程序」。
func (a *App) OpenExternalURL(url string) error {
	target := strings.TrimSpace(url)
	if !strings.HasPrefix(target, "https://") && !strings.HasPrefix(target, "http://") {
		return fmt.Errorf("只支持打开 http/https 链接: %q", url)
	}
	if a.wailsApp != nil {
		return a.wailsApp.Browser.OpenURL(target)
	}
	return openWithDefaultApp(target)
}

// openWithDefaultApp 用系统默认方式打开路径或链接。
//
// 目录要交给文件管理器：Wails 的 Browser.OpenFile 走的是
// `rundll32 url.dll,FileProtocolHandler`，对本地目录并不可靠。
func openWithDefaultApp(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// explorer 对目录与文件都能处理；它成功时也可能返回 1，
		// 因此只启动进程、不等退出码
		cmd = exec.Command("explorer", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开失败: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
