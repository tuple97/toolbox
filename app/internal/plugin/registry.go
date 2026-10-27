package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"toolbox/app/internal/semver"
)

// 索引与安装包的网络与大小边界。
const (
	// RegistrySchemaVersion 宿主支持的索引格式版本。
	//
	// 索引结构变化时递增；宿主只接受自己认识的版本，不做无限兼容。
	RegistrySchemaVersion = 2

	// maxIndexBytes 索引文件最大字节数（4 MiB）
	maxIndexBytes = 4 << 20
	// marketTimeout 单次市场请求超时。
	//
	// 索引托管在 GitHub raw 上，部分网络环境下连接会一直挂起而不是
	// 快速失败；超时定得太长，插件管理页就会长时间停在「读取索引中」。
	// 宁可快速失败并给出重试入口。
	marketTimeout = 12 * time.Second
	// marketDialTimeout 建连超时
	marketDialTimeout = 5 * time.Second
)

// RegistryEntry 官方索引中的一条插件记录。
//
// 它包含安装所需的全部信息：包地址、摘要、依赖声明与扩展点。
// 宿主不依赖插件源码仓库的目录结构。
type RegistryEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Homepage    string `json:"homepage,omitempty"`
	License     string `json:"license,omitempty"`
	Author      string `json:"author,omitempty"`

	// SourceDir 插件源码目录名（相对仓库 plugins/）。
	// 用于生成正确的源码链接 —— 插件 id 与目录名并不总是相同。
	SourceDir string `json:"sourceDir,omitempty"`
	// Repo 源码仓库地址
	Repo string `json:"repo,omitempty"`
	// Download 安装包下载地址（必须是不可变地址：带发布 tag，而不是 latest）
	Download string `json:"download"`
	// Checksum 安装包摘要，形如 sha256:xxxx
	Checksum string `json:"checksum"`
	// Official 是否由官方索引标记为官方审核。
	//
	// 注意：只有在索引签名校验通过时，宿主才会把它当作可信来源。
	Official bool `json:"official,omitempty"`

	Engines      Engines           `json:"engines,omitempty"`
	Dependencies map[string]string `json:"dependencies,omitempty"`
	Permissions  Permissions       `json:"permissions,omitempty"`
	Runtime      RuntimeSpec       `json:"runtime,omitempty"`
	Contributes  Contributions     `json:"contributes,omitempty"`
}

// Manifest 把索引条目转换为清单对象。
//
// 校验在解析索引时统一做一次；转换出的清单用于依赖求解、展示与本地记录。
func (e RegistryEntry) Manifest() *Manifest {
	return &Manifest{
		ManifestVersion: ManifestVersion,
		ID:              e.ID,
		Name:            e.Name,
		Version:         e.Version,
		Publisher:       e.Publisher,
		Description:     e.Description,
		Icon:            e.Icon,
		Homepage:        e.Homepage,
		License:         e.License,
		Author:          e.Author,
		Engines:         e.Engines,
		Dependencies:    e.Dependencies,
		Permissions:     e.Permissions,
		Runtime:         e.Runtime,
		Contributes:     e.Contributes,
	}
}

// Validate 校验索引条目的完整性。
func (e RegistryEntry) Validate() error {
	if err := e.Manifest().Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(e.Download) == "" {
		return fmt.Errorf("索引条目缺少 download")
	}
	parsed, err := url.Parse(strings.TrimSpace(e.Download))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("索引条目的 download 不是合法地址: %q", e.Download)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return fmt.Errorf("索引条目的 download 协议不受支持: %q", e.Download)
	}
	if NormalizeChecksum(e.Checksum) == "" {
		return fmt.Errorf("索引条目缺少 checksum")
	}
	if len(NormalizeChecksum(e.Checksum)) != len("sha256:")+64 {
		return fmt.Errorf("索引条目的 checksum 不是合法 sha256: %q", e.Checksum)
	}
	return nil
}

// RegistryIndex 官方索引文件结构。
type RegistryIndex struct {
	// SchemaVersion 索引格式版本
	SchemaVersion int `json:"schemaVersion"`
	// UpdatedAt 索引更新时间（RFC3339）
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Plugins 插件条目
	Plugins []RegistryEntry `json:"plugins"`
}

// Find 在索引中查找指定插件与版本；version 为空时返回该插件最高版本。
func (idx *RegistryIndex) Find(id, version string) *RegistryEntry {
	if idx == nil {
		return nil
	}
	if version != "" {
		for i := range idx.Plugins {
			entry := &idx.Plugins[i]
			if entry.ID == id && entry.Version == version {
				return entry
			}
		}
		return nil
	}
	return idx.Latest(id)
}

// Latest 返回索引中某插件的最高版本。
func (idx *RegistryIndex) Latest(id string) *RegistryEntry {
	if idx == nil {
		return nil
	}
	var best *RegistryEntry
	var bestVersion semver.Version
	for i := range idx.Plugins {
		entry := &idx.Plugins[i]
		if entry.ID != id {
			continue
		}
		v, err := semver.Parse(entry.Version)
		if err != nil {
			continue
		}
		if best == nil || v.Compare(bestVersion) > 0 {
			best = entry
			bestVersion = v
		}
	}
	return best
}

// Versions 返回索引中某插件的全部版本（降序）。
func (idx *RegistryIndex) Versions(id string) []*RegistryEntry {
	out := make([]*RegistryEntry, 0, 4)
	if idx == nil {
		return out
	}
	for i := range idx.Plugins {
		entry := &idx.Plugins[i]
		if entry.ID == id {
			out = append(out, entry)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		left, leftErr := semver.Parse(out[i].Version)
		right, rightErr := semver.Parse(out[j].Version)
		if leftErr != nil || rightErr != nil {
			return out[i].Version > out[j].Version
		}
		return left.Compare(right) > 0
	})
	return out
}

// RegistryProvider 官方索引与安装包的来源配置。
type RegistryProvider struct {
	// IndexURL registry.json 地址
	IndexURL string
	// SignatureURL 分离式签名地址（留空表示使用 IndexURL + ".sig"）
	SignatureURL string
}

// DefaultRegistryIndexURL 官方索引的默认地址。
const DefaultRegistryIndexURL = "https://raw.githubusercontent.com/tuple97/toolbox-plugins/main/registry.json"

// OfficialSourceName 内置官方源的默认展示名。
const OfficialSourceName = "官方源"

// DefaultRegistryProvider 返回默认索引来源。
func DefaultRegistryProvider() RegistryProvider {
	return RegistryProvider{IndexURL: DefaultRegistryIndexURL}
}

// RegistryClient 索引与安装包的 HTTP 客户端。
type RegistryClient struct {
	provider RegistryProvider
	client   *http.Client
}

// NewRegistryClient 创建市场客户端。
func NewRegistryClient(provider RegistryProvider) *RegistryClient {
	return &RegistryClient{
		provider: provider,
		client: &http.Client{
			Timeout: marketTimeout,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				DialContext:           (&net.Dialer{Timeout: marketDialTimeout, KeepAlive: 30 * time.Second}).DialContext,
				TLSHandshakeTimeout:   marketDialTimeout,
				ResponseHeaderTimeout: marketTimeout,
				IdleConnTimeout:       60 * time.Second,
				ForceAttemptHTTP2:     true,
			},
		},
	}
}

// Provider 返回宿主内置的官方索引来源配置。
//
// 用户自添加的插件源不在这里 —— 它们由管理器维护成一份列表（见 RegistrySource），
// 这里的 provider 始终代表「内置官方源」，是验签强度的基准。
func (c *RegistryClient) Provider() RegistryProvider { return c.provider }

// FetchIndexAt 拉取并校验「指定地址」的索引。
//
// 返回值 verified 表示签名是否校验通过。
// strict 决定验签强度，两者的差别只在「签名缺失」时怎么处理：
//   - strict=true（内置官方源）：配了公钥就必须验签通过。官方索引突然没签名，
//     多半是被劫持或发布流水线出问题，宁可失败也不能降级；
//   - strict=false（用户自设来源）：签名可选。取不到签名按未验签处理
//     （verified=false，索引里的 official 标记不再被信任，安装时按第三方
//     来源要求用户显式确认信任）。
//
// 无论哪种强度，**签名取到了却验不过都会直接拒绝** —— 那说明内容被篡改
// 或地址被劫持，不能降级成「未验签」继续使用。
func (c *RegistryClient) FetchIndexAt(ctx context.Context, indexURL, signatureURL string, strict bool) (*RegistryIndex, bool, error) {
	target := strings.TrimSpace(indexURL)
	if target == "" {
		return nil, false, fmt.Errorf("%w: 插件源地址为空", ErrSourceUnavailable)
	}

	raw, err := c.fetchBytes(ctx, target, maxIndexBytes)
	if err != nil {
		// 带上索引地址：404 最常见的成因是「仓库还没建 / 分支还没推送」，
		// 用户看到具体地址才能自行判断该去哪里修
		return nil, false, fmt.Errorf("%w: 读取插件源索引失败（%s）：%v",
			ErrSourceUnavailable, target, err)
	}

	verified := false
	if SignatureEnabled() {
		sig, sigErr := c.fetchSignatureAt(ctx, target, signatureURL)
		switch {
		case sigErr != nil && strict:
			return nil, false, fmt.Errorf("%w: 获取索引签名失败: %v", ErrSourceUnavailable, sigErr)
		case sigErr == nil:
			if err := VerifySignature(raw, sig, RegistryPublicKey); err != nil {
				return nil, false, fmt.Errorf("索引签名校验失败（已拒绝使用该索引）: %w", err)
			}
			verified = true
		}
	}

	index, err := parseIndex(raw)
	if err != nil {
		return nil, verified, err
	}
	return index, verified, nil
}

// parseIndex 解析并逐条校验索引内容。
//
// 校验规则与来源、验签结果无关：任何来源的索引都要过同样的格式与条目检查，
// 坏数据不流入后续流程。
func parseIndex(raw []byte) (*RegistryIndex, error) {
	var index RegistryIndex
	if err := json.Unmarshal(raw, &index); err != nil {
		return nil, fmt.Errorf("解析插件索引失败: %w", err)
	}
	if index.SchemaVersion != RegistrySchemaVersion {
		return nil, fmt.Errorf("不支持的索引格式版本: %d（当前支持 %d）",
			index.SchemaVersion, RegistrySchemaVersion)
	}

	// 逐条校验，避免坏数据流入后续流程
	seen := make(map[string]struct{}, len(index.Plugins))
	for i := range index.Plugins {
		entry := &index.Plugins[i]
		if err := entry.Validate(); err != nil {
			return nil, fmt.Errorf("索引条目 %q 非法: %w", entry.ID, err)
		}
		key := entry.ID + "@" + entry.Version
		if _, dup := seen[key]; dup {
			return nil, fmt.Errorf("索引中存在重复条目: %s", key)
		}
		seen[key] = struct{}{}
	}
	return &index, nil
}

// fetchSignatureAt 获取指定索引地址的分离式签名。
//
// signatureURL 为空时按约定取 <indexURL>.sig。
func (c *RegistryClient) fetchSignatureAt(ctx context.Context, indexURL, signatureURL string) (string, error) {
	target := strings.TrimSpace(signatureURL)
	if target == "" {
		target = indexURL + ".sig"
	}
	raw, err := c.fetchBytes(ctx, target, 4096)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

// DownloadPackage 下载安装包并校验摘要。
func (c *RegistryClient) DownloadPackage(ctx context.Context, rawURL, expectedChecksum string) ([]byte, error) {
	if strings.TrimSpace(rawURL) == "" {
		return nil, fmt.Errorf("%w: 安装包地址为空", ErrSourceUnavailable)
	}
	raw, err := c.fetchBytes(ctx, rawURL, maxPackageBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: 下载插件包失败: %v", ErrSourceUnavailable, err)
	}
	if NormalizeChecksum(expectedChecksum) != "" {
		if err := VerifyChecksum(raw, expectedChecksum); err != nil {
			return nil, err
		}
	}
	return raw, nil
}

// fetchBytes 下载受限长度的内容。
func (c *RegistryClient) fetchBytes(ctx context.Context, target string, limit int64) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, marketTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}
	req.Header.Set("User-Agent", "toolbox-plugin-manager")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("请求失败: HTTP %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("响应内容超出上限（> %d 字节）", limit)
	}
	return raw, nil
}
