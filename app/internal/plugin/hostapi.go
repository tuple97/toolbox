package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// 宿主 API 的资源上限；插件是不可信代码，外部交互必须有硬边界。
const (
	// maxHTTPResponseBytes HTTP 响应体最大读取字节数（8 MiB）
	maxHTTPResponseBytes = 8 << 20
	// httpTimeout 单次 HTTP 请求超时
	httpTimeout = 30 * time.Second
	// maxHTTPHeaders 允许的请求头数量上限
	maxHTTPHeaders = 32
)

// allowedHTTPMethods 插件可用的 HTTP 方法白名单。
var allowedHTTPMethods = map[string]struct{}{
	http.MethodGet:    {},
	http.MethodPost:   {},
	http.MethodPut:    {},
	http.MethodPatch:  {},
	http.MethodDelete: {},
	http.MethodHead:   {},
}

// HostEnv 宿主环境回调，由 Manager 实现。
// 抽成接口是为了打断 Manager → Runtime → HostBridge 的环状依赖。
type HostEnv interface {
	// AppVersion 当前应用版本
	AppVersion() string
	// StorageGet 读取插件私有配置
	StorageGet(pluginID, key string) (string, bool, error)
	// StorageSet 写入插件私有配置
	StorageSet(pluginID, key, value string) error
	// StorageDelete 删除插件私有配置
	StorageDelete(pluginID, key string) error
	// StorageList 列出插件私有配置
	StorageList(pluginID string) (map[string]string, error)
	// EmitEvent 把插件事件发往应用事件总线
	EmitEvent(pluginID, name string, payload any) error
	// CallPlugin 调用另一个插件的 handler（插件间通信）
	CallPlugin(pluginID, handler string, args json.RawMessage) (json.RawMessage, error)
	// EnabledPlugins 已启用插件概览
	EnabledPlugins() []PluginSummary
}

// HTTPRequest 插件发起的 HTTP 请求描述。
type HTTPRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// HTTPResponse HTTP 响应结果。
type HTTPResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	// Truncated 响应体是否因超出上限被截断
	Truncated bool `json:"truncated"`
}

// HostBridge 单个插件的宿主能力入口，每个方法都先过权限校验。
type HostBridge struct {
	env     HostEnv
	id      string
	version string
	perms   Permissions
	client  *http.Client
}

// NewHostBridge 创建宿主能力桥。
func NewHostBridge(env HostEnv, id, version string, perms Permissions) *HostBridge {
	return &HostBridge{
		env:     env,
		id:      id,
		version: version,
		perms:   perms,
		client: &http.Client{
			Timeout: httpTimeout,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				MaxIdleConns:          8,
				IdleConnTimeout:       60 * time.Second,
				TLSHandshakeTimeout:   15 * time.Second,
				ResponseHeaderTimeout: httpTimeout,
				ForceAttemptHTTP2:     true,
			},
			// 手动处理重定向：每一跳都要过白名单，否则可被绕过
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return fmt.Errorf("重定向次数过多")
				}
				if !perms.AllowsURL(req.URL.String()) {
					return fmt.Errorf("%w: 重定向目标不在网络白名单内: %s", ErrPermissionDenied, req.URL.Host)
				}
				return nil
			},
		},
	}
}

// PluginID 返回所属插件标识。
func (h *HostBridge) PluginID() string { return h.id }

// PluginVersion 返回插件版本。
func (h *HostBridge) PluginVersion() string { return h.version }

// Permissions 返回插件权限快照。
func (h *HostBridge) Permissions() Permissions { return h.perms }

// Log 记录一条插件日志。
func (h *HostBridge) Log(level, message string) {
	fields := []any{"plugin", h.id, "version", h.version}
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "error":
		slog.Error("[plugin] "+message, fields...)
	case "warn", "warning":
		slog.Warn("[plugin] "+message, fields...)
	default:
		slog.Info("[plugin] "+message, fields...)
	}
}

// AppVersion 返回宿主应用版本，供插件做兼容判断。
func (h *HostBridge) AppVersion() string { return h.env.AppVersion() }

// GetSetting 读取插件私有配置；不存在时返回 ("", false, nil)。
func (h *HostBridge) GetSetting(key string) (string, bool, error) {
	if !h.perms.Storage {
		return "", false, fmt.Errorf("%w: 读写插件数据", ErrPermissionDenied)
	}
	return h.env.StorageGet(h.id, key)
}

// SetSetting 写入插件私有配置。
func (h *HostBridge) SetSetting(key, value string) error {
	if !h.perms.Storage {
		return fmt.Errorf("%w: 读写插件数据", ErrPermissionDenied)
	}
	return h.env.StorageSet(h.id, key, value)
}

// DeleteSetting 删除插件私有配置。
func (h *HostBridge) DeleteSetting(key string) error {
	if !h.perms.Storage {
		return fmt.Errorf("%w: 读写插件数据", ErrPermissionDenied)
	}
	return h.env.StorageDelete(h.id, key)
}

// AllSettings 读取插件全部私有配置。
func (h *HostBridge) AllSettings() (map[string]string, error) {
	if !h.perms.Storage {
		return nil, fmt.Errorf("%w: 读写插件数据", ErrPermissionDenied)
	}
	return h.env.StorageList(h.id)
}

// HTTPFetch 发起一次受白名单约束的 HTTP 请求。
func (h *HostBridge) HTTPFetch(req HTTPRequest) (*HTTPResponse, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	if _, ok := allowedHTTPMethods[method]; !ok {
		return nil, fmt.Errorf("不允许的 HTTP 方法: %q", req.Method)
	}
	if !h.perms.AllowsURL(req.URL) {
		return nil, fmt.Errorf("%w: 网络访问 %s（未在清单的 permissions.network 中声明）", ErrPermissionDenied, req.URL)
	}
	if len(req.Headers) > maxHTTPHeaders {
		return nil, fmt.Errorf("请求头数量过多（> %d）", maxHTTPHeaders)
	}

	var bodyReader io.Reader
	if req.Body != "" {
		bodyReader = strings.NewReader(req.Body)
	}

	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, method, req.URL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := h.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("请求失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	limited := io.LimitReader(resp.Body, maxHTTPResponseBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}

	truncated := false
	if len(raw) > maxHTTPResponseBytes {
		raw = raw[:maxHTTPResponseBytes]
		truncated = true
	}

	headers := make(map[string]string, len(resp.Header))
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}

	return &HTTPResponse{
		Status:    resp.StatusCode,
		Headers:   headers,
		Body:      string(raw),
		Truncated: truncated,
	}, nil
}

// EmitEvent 发送插件事件到应用事件总线。
//
// 事件名统一加 "plugin:" 前缀，避免与内置事件冲突。
func (h *HostBridge) EmitEvent(name string, payload any) error {
	if !h.perms.Events {
		return fmt.Errorf("%w: 收发应用事件", ErrPermissionDenied)
	}
	return h.env.EmitEvent(h.id, name, payload)
}

// CallPlugin 调用另一个插件的 handler。
func (h *HostBridge) CallPlugin(pluginID, handler string, args json.RawMessage) (json.RawMessage, error) {
	if pluginID == "" || handler == "" {
		return nil, fmt.Errorf("调用插件需要提供插件标识与 handler 名")
	}
	return h.env.CallPlugin(pluginID, handler, args)
}

// Plugins 返回已启用插件概览。
func (h *HostBridge) Plugins() []PluginSummary { return h.env.EnabledPlugins() }
