package plugin

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// 数据库访问权限取值。
const (
	// DBPermRead 允许读取工具箱数据库（只读查询）
	DBPermRead = "read"
	// DBPermWrite 允许写入工具箱数据库
	DBPermWrite = "write"
)

// Permissions 插件申请的权限集合。
//
// 权限是安全边界的全部依据：宿主 API 在执行动作前一律先查这里，
// 未授予的能力直接拒绝，不做降级放行。
type Permissions struct {
	// Network HTTP 请求域名白名单；支持通配前缀（*.example.com）
	Network []string `json:"network,omitempty"`
	// Storage 是否允许使用插件私有键值存储
	Storage bool `json:"storage,omitempty"`
	// DB 数据库访问权限：read / write
	DB []string `json:"db,omitempty"`
	// Events 是否允许收发应用事件总线
	Events bool `json:"events,omitempty"`
	// Clipboard 是否允许读写剪贴板
	Clipboard bool `json:"clipboard,omitempty"`
	// Notify 是否允许弹出系统/应用通知
	Notify bool `json:"notify,omitempty"`
	// FS 文件系统白名单（预留，当前未开放）
	FS []string `json:"fs,omitempty"`
}

// IsZero 报告是否未申请任何权限。
func (p Permissions) IsZero() bool {
	return len(p.Network) == 0 && !p.Storage && len(p.DB) == 0 &&
		!p.Events && !p.Clipboard && !p.Notify && len(p.FS) == 0
}

// Validate 校验权限声明合法性。
func (p Permissions) Validate() error {
	for _, host := range p.Network {
		if err := validateHostPattern(host); err != nil {
			return err
		}
	}
	seen := make(map[string]struct{}, len(p.DB))
	for _, cap := range p.DB {
		normalized := strings.ToLower(strings.TrimSpace(cap))
		switch normalized {
		case DBPermRead, DBPermWrite:
		default:
			return fmt.Errorf("数据库权限取值非法（仅支持 read / write）: %q", cap)
		}
		if _, dup := seen[normalized]; dup {
			return fmt.Errorf("数据库权限重复声明: %q", cap)
		}
		seen[normalized] = struct{}{}
	}
	return nil
}

// AllowsDB 报告是否授予了指定的数据库权限。
func (p Permissions) AllowsDB(capability string) bool {
	// write 隐含 read
	if capability == DBPermRead && p.AllowsDB(DBPermWrite) {
		return true
	}
	for _, cap := range p.DB {
		if strings.EqualFold(strings.TrimSpace(cap), capability) {
			return true
		}
	}
	return false
}

// AllowsURL 报告目标地址是否落在网络白名单内。
//
// 规则：仅允许 http/https；主机名与白名单条目精确相等，
// 或匹配 *.example.com 形式的子域通配。
func (p Permissions) AllowsURL(raw string) bool {
	if len(p.Network) == 0 {
		return false
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	for _, pattern := range p.Network {
		if hostMatches(strings.ToLower(pattern), host) {
			return true
		}
	}
	return false
}

// hostMatches 判断主机是否匹配白名单条目。
func hostMatches(pattern, host string) bool {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return false
	}
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		// 通配必须匹配至少一级子域：a.example.com 命中，example.com 不命中
		return strings.HasSuffix(host, suffix) && len(host) > len(suffix)
	}
	return pattern == host
}

// validateHostPattern 校验白名单条目：只允许主机名，不带协议与路径。
func validateHostPattern(raw string) error {
	entry := strings.TrimSpace(raw)
	if entry == "" {
		return fmt.Errorf("网络白名单存在空条目")
	}
	if strings.ContainsAny(entry, "/\\") {
		return fmt.Errorf("网络白名单只允许主机名，不能包含路径: %q", raw)
	}
	if strings.Contains(entry, "://") {
		return fmt.Errorf("网络白名单只允许主机名，不能包含协议: %q", raw)
	}
	if strings.ContainsAny(entry, " :") {
		return fmt.Errorf("网络白名单不能包含端口或空格: %q", raw)
	}
	if strings.HasPrefix(entry, "*.") {
		if len(entry) <= 2 {
			return fmt.Errorf("网络白名单通配条目非法: %q", raw)
		}
		return nil
	}
	if strings.Contains(entry, "*") {
		return fmt.Errorf("网络白名单只支持 *. 前缀通配: %q", raw)
	}
	return nil
}

// PermissionSummary 用于向用户展示的权限描述列表（安装确认弹窗使用）。
func (p Permissions) PermissionSummary() []string {
	var items []string
	if len(p.Network) > 0 {
		items = append(items, fmt.Sprintf("访问网络：%s", strings.Join(p.Network, "、")))
	}
	if p.Storage {
		items = append(items, "读写插件私有数据")
	}
	if len(p.DB) > 0 {
		caps := make([]string, 0, len(p.DB))
		for _, cap := range p.DB {
			switch strings.ToLower(strings.TrimSpace(cap)) {
			case DBPermRead:
				caps = append(caps, "读取")
			case DBPermWrite:
				caps = append(caps, "写入")
			default:
				caps = append(caps, cap)
			}
		}
		items = append(items, fmt.Sprintf("访问工具箱数据库：%s", strings.Join(caps, "、")))
	}
	if p.Events {
		items = append(items, "收发应用事件")
	}
	if p.Clipboard {
		items = append(items, "读写剪贴板")
	}
	if p.Notify {
		items = append(items, "发送通知")
	}
	if len(p.FS) > 0 {
		items = append(items, fmt.Sprintf("访问文件：%s", strings.Join(p.FS, "、")))
	}
	sort.Strings(items)
	return items
}

// PermissionDiff 计算从 old 到 next 新增的权限（升级时用于要求重新确认）。
//
// 返回空切片表示权限未扩张，可以静默升级。
func PermissionDiff(old, next Permissions) []string {
	var added []string

	networkBefore := make(map[string]struct{}, len(old.Network))
	for _, h := range old.Network {
		networkBefore[strings.ToLower(strings.TrimSpace(h))] = struct{}{}
	}
	for _, h := range next.Network {
		if _, ok := networkBefore[strings.ToLower(strings.TrimSpace(h))]; !ok {
			added = append(added, fmt.Sprintf("新增网络访问：%s", h))
		}
	}

	if next.Storage && !old.Storage {
		added = append(added, "新增：读写插件私有数据")
	}
	if len(next.DB) > 0 {
		for _, cap := range next.DB {
			if !old.AllowsDB(cap) {
				added = append(added, fmt.Sprintf("新增数据库权限：%s", cap))
			}
		}
	}
	if next.Events && !old.Events {
		added = append(added, "新增：收发应用事件")
	}
	if next.Clipboard && !old.Clipboard {
		added = append(added, "新增：读写剪贴板")
	}
	if next.Notify && !old.Notify {
		added = append(added, "新增：发送通知")
	}
	for _, dir := range next.FS {
		if !containsFold(old.FS, dir) {
			added = append(added, fmt.Sprintf("新增文件访问：%s", dir))
		}
	}

	sort.Strings(added)
	return added
}

func containsFold(list []string, target string) bool {
	for _, item := range list {
		if strings.EqualFold(strings.TrimSpace(item), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}
