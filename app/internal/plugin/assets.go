package plugin

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// maxAssetTextBytes 单次文本资源读取上限。
const maxAssetTextBytes = 16 << 20

// assetPrefix 插件静态资源的 URL 前缀。
//
// 前端据此动态 import 插件的 ESM 产物：
//
//	import('/plugins/<id>/<version>/frontend/index.js')
//
// 路径以插件标识与版本号显式分段，天然带缓存隔离，
// 升级后 URL 变化，浏览器不会复用旧产物。
const assetPrefix = "/plugins/"

// Handler 返回插件静态资源处理器。
//
// fallback 用于承接非 /plugins/ 前缀的请求（即应用自身的打包产物）。
func (m *Manager) Handler(fallback http.Handler) http.Handler {
	return &assetHandler{manager: m, fallback: fallback}
}

// assetHandler 把 /plugins/<id>/<version>/<path> 映射到插件版本目录。
type assetHandler struct {
	manager  *Manager
	fallback http.Handler
}

// ServeHTTP 实现 http.Handler。
func (h *assetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, assetPrefix) {
		if h.fallback != nil {
			h.fallback.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}

	id, version, rel, ok := parseAssetPath(r.URL.Path)
	if !ok {
		http.Error(w, "插件资源路径非法", http.StatusBadRequest)
		return
	}

	store := h.manager.Store()
	full, err := store.AssetPath(id, version, rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	info, statErr := os.Stat(full)
	if statErr != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	if ctype := contentTypeOf(rel); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	// 插件资源随版本号变化，可长期缓存
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

	http.ServeFile(w, r, full)
}

// parseAssetPath 拆分 /plugins/<id>/<version>/<rel...>。
func parseAssetPath(urlPath string) (id, version, rel string, ok bool) {
	trimmed := strings.TrimPrefix(urlPath, assetPrefix)
	// 先做一次清洗，拒绝任何形式的穿越尝试
	cleaned := path.Clean("/" + trimmed)
	cleaned = strings.TrimPrefix(cleaned, "/")
	if cleaned == "" {
		return "", "", "", false
	}

	parts := strings.SplitN(cleaned, "/", 3)
	if len(parts) < 3 {
		return "", "", "", false
	}
	id, version, rel = parts[0], parts[1], parts[2]
	if id == "" || version == "" || rel == "" {
		return "", "", "", false
	}
	return id, version, rel, true
}

// contentTypeOf 按扩展名给出 Content-Type。
func contentTypeOf(rel string) string {
	ext := strings.ToLower(filepath.Ext(rel))
	switch ext {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	case ".svg":
		return "image/svg+xml"
	default:
		if ctype := mime.TypeByExtension(ext); ctype != "" {
			return ctype
		}
		return "application/octet-stream"
	}
}

// ReadAssetText 读取插件版本目录内的文本资源。
//
// 存在的意义是开发模式：dev 时窗口由 Vite dev server 提供，
// /plugins/ 静态地址会被 Vite 接管（404 或返回 index.html），
// 前端因此改从这条 IPC 读源码再用 Blob URL 加载。
// 生产模式仍走静态地址，不经过这里。
func (m *Manager) ReadAssetText(id, version, relPath string) (string, error) {
	clean := strings.TrimPrefix(path.Clean("/"+strings.TrimSpace(relPath)), "/")
	if clean == "" || clean == "." {
		return "", fmt.Errorf("资源路径为空")
	}
	if id == "" || version == "" {
		return "", fmt.Errorf("插件标识与版本不能为空")
	}

	m.mu.RLock()
	_, installed := m.records[id]
	m.mu.RUnlock()
	if !installed {
		return "", fmt.Errorf("%w: %s", ErrNotInstalled, id)
	}

	data, err := m.store.ReadAsset(id, version, clean)
	if err != nil {
		return "", err
	}
	if len(data) > maxAssetTextBytes {
		return "", fmt.Errorf("插件资源过大（> %d 字节）: %s", maxAssetTextBytes, clean)
	}
	return string(data), nil
}
