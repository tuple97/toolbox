package plugin

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// 数据库访问权限取值。
const (
	// DBPermRead 读取工具箱数据库
	DBPermRead = "read"
	// DBPermWrite 写入工具箱数据库
	DBPermWrite = "write"
)

// Permissions 插件申请的权限集合。
type Permissions struct {
	// Network HTTP 请求域名白名单；支持通配前缀（*.example.com）
	Network []string `json:"network,omitempty"`
	// Storage 是否允许使用插件私有键值存储
	Storage bool `json:"storage,omitempty"`
	// DB 数据库访问权限：read / write
	DB []string `json:"db,omitempty"`
	// Events 是否允许收发应用事件总线
	Events bool `json:"events,omitempty"`
	// Server 是否允许插件启动本地 HTTP 服务（只绑回环地址）
	Server ServerPermission `json:"server,omitempty"`
	// Files 允许读取的本地目录白名单（只读文本）。
	Files []string `json:"files,omitempty"`
	// FileWrite 是否允许写入用户在保存对话框里选定的文件。
	FileWrite bool `json:"fileWrite,omitempty"`
}

// ServerPermission 本地服务能力。
type ServerPermission struct {
	// Enabled 是否允许启动本地服务
	Enabled bool `json:"enabled,omitempty"`
	// Ports 允许监听的端口白名单；留空表示 1024-65535 内任意端口
	Ports []int `json:"ports,omitempty"`
}

// AllowsPort 报告某个端口是否在授权范围内；port 为 0 表示由系统分配。
func (p ServerPermission) AllowsPort(port int) bool {
	if !p.Enabled {
		return false
	}
	if port == 0 {
		return true
	}
	if len(p.Ports) == 0 {
		return port >= 1024 && port <= 65535
	}
	for _, allowed := range p.Ports {
		if allowed == port {
			return true
		}
	}
	return false
}

// IsZero 报告是否未申请任何权限。
func (p Permissions) IsZero() bool {
	return len(p.Network) == 0 && !p.Storage && len(p.DB) == 0 && !p.Events &&
		!p.Server.Enabled && !p.FileWrite && len(p.Files) == 0
}

// Validate 校验权限声明合法性。
func (p Permissions) Validate() error {
	seenHost := make(map[string]struct{}, len(p.Network))
	for _, host := range p.Network {
		if err := validateHostPattern(host); err != nil {
			return err
		}
		key := strings.ToLower(strings.TrimSpace(host))
		if _, dup := seenHost[key]; dup {
			return fmt.Errorf("网络白名单条目重复: %q", host)
		}
		seenHost[key] = struct{}{}
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

	seenPort := make(map[int]struct{}, len(p.Server.Ports))
	for _, port := range p.Server.Ports {
		if port < 1 || port > 65535 {
			return fmt.Errorf("本地服务端口非法（1-65535）: %d", port)
		}
		if _, dup := seenPort[port]; dup {
			return fmt.Errorf("本地服务端口重复声明: %d", port)
		}
		seenPort[port] = struct{}{}
	}
	if len(p.Server.Ports) > 0 && !p.Server.Enabled {
		return fmt.Errorf("声明了本地服务端口，但没有开启 server 权限")
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
		// 通配需匹配至少一级子域
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
	items := make([]string, 0, 4)
	if len(p.Network) > 0 {
		items = append(items, fmt.Sprintf("访问网络：%s", strings.Join(sortedStringsFold(p.Network), "、")))
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
	if p.Server.Enabled {
		if len(p.Server.Ports) > 0 {
			ports := make([]string, 0, len(p.Server.Ports))
			for _, port := range p.Server.Ports {
				ports = append(ports, fmt.Sprintf("%d", port))
			}
			items = append(items, fmt.Sprintf("监听本地端口：%s", strings.Join(ports, "、")))
		} else {
			items = append(items, "监听本地端口（仅回环地址）")
		}
	}
	if len(p.Files) > 0 {
		items = append(items, fmt.Sprintf("读取本地文件：%s", strings.Join(p.Files, "、")))
	}
	if p.FileWrite {
		items = append(items, "写入本地文件（由用户在保存对话框中选择位置）")
	}
	sort.Strings(items)
	return items
}

// PermissionDiff 计算从 old 到 next 新增的权限（升级时用于重新确认）。
func PermissionDiff(old, next Permissions) []string {
	added := make([]string, 0, 4)

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
	for _, cap := range next.DB {
		if !old.AllowsDB(cap) {
			added = append(added, fmt.Sprintf("新增数据库权限：%s", cap))
		}
	}
	if next.Events && !old.Events {
		added = append(added, "新增：收发应用事件")
	}
	if next.FileWrite && !old.FileWrite {
		added = append(added, "新增：写入用户选择的本地文件")
	}
	// 白名单只增不减才算扩张
	filesBefore := make(map[string]struct{}, len(old.Files))
	for _, dir := range old.Files {
		filesBefore[expandPath(dir)] = struct{}{}
	}
	for _, dir := range next.Files {
		if _, ok := filesBefore[expandPath(dir)]; !ok {
			added = append(added, fmt.Sprintf("新增本地文件目录：%s", dir))
		}
	}

	sort.Strings(added)
	return added
}

// PermissionsEqual 报告两份权限声明是否完全一致（忽略大小写与空白差异）。
func PermissionsEqual(a, b Permissions) bool {
	return len(PermissionDiff(a, b)) == 0 && len(PermissionDiff(b, a)) == 0 &&
		a.Storage == b.Storage && a.Events == b.Events && a.FileWrite == b.FileWrite
}

func sortedStringsFold(list []string) []string {
	out := append([]string{}, list...)
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	return out
}
