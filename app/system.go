package app

import (
	"runtime"
	"strings"
)

// Version 当前应用版本号；发布构建用
// `-ldflags "-X toolbox/app.Version=1.2.3"` 覆盖
var Version = "0.1.0"

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
