package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// 索引与安装包的网络与解包边界。
const (
	// maxIndexBytes 索引文件最大字节数（4 MiB）
	maxIndexBytes = 4 << 20
	// maxPackageBytes 安装包最大字节数（64 MiB）
	maxPackageBytes = 64 << 20
	// maxExtractedBytes 解压后总大小上限（128 MiB），防 zip bomb
	maxExtractedBytes = 128 << 20
	// maxPackageFiles 安装包内文件数量上限
	maxPackageFiles = 512
	// marketTimeout 单次市场请求超时。
	//
	// 索引托管在 GitHub raw 上，部分网络环境下连接会一直挂起而不是
	// 快速失败；超时定得太长，插件管理页就会长时间停在「读取索引中」。
	// 宁可快速失败并给出重试入口。
	marketTimeout = 12 * time.Second
	// marketDialTimeout 建连超时
	marketDialTimeout = 5 * time.Second
)

// Market 官方插件市场客户端：拉取索引、下载并校验安装包。
type Market struct {
	provider RegistryProvider
	client   *http.Client
}

// NewMarket 创建市场客户端。
func NewMarket(provider RegistryProvider) *Market {
	return &Market{
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

// Provider 返回索引来源配置。
func (m *Market) Provider() RegistryProvider { return m.provider }

// SetProvider 更新索引来源（用户可在设置中更换镜像）。
func (m *Market) SetProvider(p RegistryProvider) { m.provider = p }

// FetchIndex 拉取并校验官方索引。
//
// 返回值 verified 表示签名是否校验通过；在公钥未配置时恒为 false。
// 公钥已配置但签名校验失败时返回错误（拒绝使用被篡改的索引）。
func (m *Market) FetchIndex(ctx context.Context) (*RegistryIndex, bool, error) {
	if strings.TrimSpace(m.provider.IndexURL) == "" {
		return nil, false, fmt.Errorf("未配置插件索引地址")
	}

	raw, err := m.fetchBytes(ctx, m.provider.IndexURL, maxIndexBytes)
	if err != nil {
		// 带上索引地址：404 最常见的成因是「仓库还没建 / 分支还没推送」，
		// 用户看到具体地址才能自行判断该去哪里修
		return nil, false, fmt.Errorf("读取插件索引失败（%s）：%w", m.provider.IndexURL, err)
	}

	verified := false
	if SignatureEnabled() {
		sig, sigErr := m.fetchSignature(ctx)
		if sigErr != nil {
			return nil, false, fmt.Errorf("获取索引签名失败: %w", sigErr)
		}
		if err := VerifySignature(raw, sig, RegistryPublicKey); err != nil {
			return nil, false, fmt.Errorf("索引签名校验失败: %w", err)
		}
		verified = true
	}

	var index RegistryIndex
	if err := json.Unmarshal(raw, &index); err != nil {
		return nil, verified, fmt.Errorf("解析插件索引失败: %w", err)
	}
	if index.SchemaVersion != 0 && index.SchemaVersion != 1 {
		return nil, verified, fmt.Errorf("不支持的索引格式版本: %d", index.SchemaVersion)
	}

	// 逐条校验，避免坏数据流入后续流程
	seen := make(map[string]struct{}, len(index.Plugins))
	for i := range index.Plugins {
		entry := &index.Plugins[i]
		if err := entry.Manifest().Validate(); err != nil {
			return nil, verified, fmt.Errorf("索引条目 %q 非法: %w", entry.ID, err)
		}
		key := entry.ID + "@" + entry.Version
		if _, dup := seen[key]; dup {
			return nil, verified, fmt.Errorf("索引中存在重复条目: %s", key)
		}
		seen[key] = struct{}{}
	}

	return &index, verified, nil
}

// fetchSignature 获取索引的分离式签名。
func (m *Market) fetchSignature(ctx context.Context) (string, error) {
	url := strings.TrimSpace(m.provider.SignatureURL)
	if url == "" {
		url = m.provider.IndexURL + ".sig"
	}
	raw, err := m.fetchBytes(ctx, url, 4096)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

// DownloadPackage 下载安装包并校验摘要。
func (m *Market) DownloadPackage(ctx context.Context, url, expectedChecksum string) ([]byte, error) {
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("安装包地址为空")
	}
	raw, err := m.fetchBytes(ctx, url, maxPackageBytes)
	if err != nil {
		return nil, err
	}
	if NormalizeChecksum(expectedChecksum) != "" {
		if err := VerifyChecksum(raw, expectedChecksum); err != nil {
			return nil, err
		}
	}
	return raw, nil
}

// fetchBytes 下载受限长度的内容。
func (m *Market) fetchBytes(ctx context.Context, url string, limit int64) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, marketTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}
	req.Header.Set("User-Agent", "toolbox-plugin-manager")

	resp, err := m.client.Do(req)
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

// ExtractPackage 把安装包（zip）解压到目标目录。
//
// 安全约束：拒绝绝对路径与 ../ 穿越；只接受常规文件；
// 限制文件数量与解压总大小；要求包内含 manifest.json。
func ExtractPackage(data []byte, dest string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("安装包不是合法的 zip: %w", err)
	}
	if len(reader.File) > maxPackageFiles {
		return fmt.Errorf("安装包内文件过多（> %d）", maxPackageFiles)
	}

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return fmt.Errorf("创建解压目录失败: %w", err)
	}

	var total int64
	hasManifest := false

	for _, f := range reader.File {
		// 统一使用正斜杠处理，再逐段过滤，杜绝路径穿越
		clean := path.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		if clean == "." {
			continue
		}
		if strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "/../") {
			return fmt.Errorf("安装包含非法路径: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if !f.Mode().IsRegular() {
			continue
		}

		target := filepath.Join(dest, filepath.FromSlash(clean))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("创建目录失败: %w", err)
		}

		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("读取安装包条目失败(%s): %w", clean, err)
		}

		limit := int64(f.UncompressedSize64)
		if limit <= 0 || limit > maxExtractedBytes {
			limit = maxExtractedBytes
		}
		written, copyErr := copyLimited(target, rc, limit)
		closeErr := rc.Close()
		if copyErr != nil {
			return fmt.Errorf("写入文件失败(%s): %w", clean, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("关闭条目失败(%s): %w", clean, closeErr)
		}

		total += written
		if total > maxExtractedBytes {
			return fmt.Errorf("解压后内容超出上限（> %d 字节）", maxExtractedBytes)
		}
		if clean == ManifestFileName {
			hasManifest = true
		}
	}

	if !hasManifest {
		return fmt.Errorf("安装包内缺少 %s", ManifestFileName)
	}
	return nil
}

// copyLimited 复制内容并返回写入字节数，超出 limit 时报错。
func copyLimited(target string, src io.Reader, limit int64) (int64, error) {
	out, err := os.Create(target)
	if err != nil {
		return 0, err
	}
	defer func() { _ = out.Close() }()

	written, err := io.Copy(out, io.LimitReader(src, limit+1))
	if err != nil {
		return written, err
	}
	if written > limit {
		return written, fmt.Errorf("条目内容超出上限（> %d 字节）", limit)
	}
	return written, nil
}

// DefaultRegistryIndexURL 官方索引的默认地址。
const DefaultRegistryIndexURL = "https://raw.githubusercontent.com/tuple97/toolbox-plugins/main/registry.json"

// DefaultRegistryProvider 返回默认索引来源。
func DefaultRegistryProvider() RegistryProvider {
	return RegistryProvider{IndexURL: DefaultRegistryIndexURL}
}
