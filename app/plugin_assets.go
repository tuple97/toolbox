package app

import (
	"net/http"
	"sync"
)

// 插件静态资源的资产处理器装配。
//
// application.New 需要 Handler，而插件管理器要到 ServiceStartup 才初始化，
// 所以这里用惰性代理：管理器未就绪时一律回退到内置产物。
//
// 用包级函数而不是 App 的方法：Wails 会绑定 App 的所有导出方法给前端，
// 而这个 handler 只服务于 Go 侧的 HTTP 装配。
//
// NewPluginAssetHandler 返回同时服务内置产物与插件静态资源的处理器；
// fallback 通常是 application.BundledAssetFileServer(assets)。
func NewPluginAssetHandler(a *App, fallback http.Handler) http.Handler {
	return &pluginAssetMux{app: a, fallback: fallback}
}

// pluginAssetMux 惰性装配插件资源处理器。
type pluginAssetMux struct {
	app      *App
	fallback http.Handler

	mu    sync.Mutex
	inner http.Handler
}

// ServeHTTP 实现 http.Handler。
func (m *pluginAssetMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	if m.inner == nil && m.app != nil && m.app.plugins != nil {
		m.inner = m.app.plugins.Handler(m.fallback)
	}
	inner := m.inner
	m.mu.Unlock()

	if inner != nil {
		inner.ServeHTTP(w, r)
		return
	}
	if m.fallback != nil {
		m.fallback.ServeHTTP(w, r)
		return
	}
	http.NotFound(w, r)
}
