package app

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// 本文件封装窗口控制能力，供前端自定义工具栏调用

// currentWindow 返回当前窗口
func (a *App) currentWindow() application.Window {
	if a.wailsApp == nil {
		return nil
	}
	return a.wailsApp.Window.Current()
}

// WindowMinimise 最小化窗口
func (a *App) WindowMinimise() {
	if window := a.currentWindow(); window != nil {
		window.Minimise()
	}
}

// WindowToggleMaximise 切换最大化与还原
func (a *App) WindowToggleMaximise() {
	if window := a.currentWindow(); window != nil {
		window.ToggleMaximise()
	}
}

// WindowIsMaximised 窗口是否最大化
func (a *App) WindowIsMaximised() bool {
	if window := a.currentWindow(); window != nil {
		return window.IsMaximised()
	}
	return false
}

// WindowClose 关闭窗口并退出应用。
func (a *App) WindowClose() {
	if a.wailsApp == nil {
		return
	}
	a.wailsApp.Quit()
}
