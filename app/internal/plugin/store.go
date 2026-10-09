package plugin

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"toolbox/app/internal/semver"
)

// 安装记录文件名（位于 <root>/<id>/ 下，跨版本共享）。
const installRecordName = ".install.json"

// 插件来源类型。
const (
	// SourceRegistry 来自官方插件市场索引
	SourceRegistry = "registry"
	// SourceURL 来自任意下载地址
	SourceURL = "url"
	// SourceFile 来自本地安装包
	SourceFile = "file"
	// SourceLocalDir 来自本地目录（开发者模式）
	SourceLocalDir = "local"
)

// InstallRecord 一个插件的安装与信任元数据。
type InstallRecord struct {
	// ID 插件标识
	ID string `json:"id"`
	// Version 当前启用的版本
	Version string `json:"version"`
	// Source 来源类型
	Source string `json:"source"`
	// SourceRef 来源引用（URL / 路径 / 市场 id）
	SourceRef string `json:"sourceRef,omitempty"`
	// Checksum 安装包内容摘要（sha256:...）
	Checksum string `json:"checksum,omitempty"`
	// Publisher 安装时记录的发布者
	Publisher string `json:"publisher,omitempty"`
	// Trusted 是否已获得用户信任
	Trusted bool `json:"trusted"`
	// TrustedAt 信任时间（RFC3339）
	TrustedAt string `json:"trustedAt,omitempty"`
	// Enabled 是否启用
	Enabled bool `json:"enabled"`
	// Official 是否来自官方索引且被标记为官方审核
	Official bool `json:"official,omitempty"`
	// Permissions 安装时的权限快照（用于升级时比对是否扩张）
	Permissions Permissions `json:"permissions,omitempty"`
	// InstalledAt 安装时间（RFC3339）
	InstalledAt string `json:"installedAt"`
	// UpdatedAt 最近一次升级时间（RFC3339）
	UpdatedAt string `json:"updatedAt,omitempty"`
	// PreviousVersion 上一个版本（用于回滚）
	PreviousVersion string `json:"previousVersion,omitempty"`
}

// Store 管理磁盘上的插件仓库。
type Store struct {
	root string
}

// NewStore 创建插件仓库；root 为 <数据目录>/plugins。
func NewStore(dataDir string) *Store {
	return &Store{root: filepath.Join(dataDir, "plugins")}
}

// Root 返回插件根目录。
func (s *Store) Root() string { return s.root }

// EnsureRoot 确保根目录存在。
func (s *Store) EnsureRoot() error {
	return os.MkdirAll(s.root, 0o755)
}

// PluginDir 返回某个插件的目录。
func (s *Store) PluginDir(id string) string {
	return filepath.Join(s.root, id)
}

// VersionDir 返回某个插件某个版本的目录。
func (s *Store) VersionDir(id, version string) string {
	return filepath.Join(s.root, id, version)
}

// RecordPath 返回安装记录文件路径。
func (s *Store) RecordPath(id string) string {
	return filepath.Join(s.root, id, installRecordName)
}

// ListIDs 列出全部已安装插件标识。
func (s *Store) ListIDs() ([]string, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取插件目录失败: %w", err)
	}
	ids := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		ids = append(ids, e.Name())
	}
	sort.Strings(ids)
	return ids, nil
}

// ListVersions 列出某个插件目录下已存在的版本（按版本升序）。
func (s *Store) ListVersions(id string) ([]string, error) {
	dir := s.PluginDir(id)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取插件版本目录失败: %w", err)
	}
	versions := make([]semver.Version, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		v, parseErr := semver.Parse(e.Name())
		if parseErr != nil {
			continue
		}
		versions = append(versions, v)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].LessThan(versions[j]) })
	out := make([]string, 0, len(versions))
	for _, v := range versions {
		out = append(out, v.String())
	}
	return out, nil
}

// ReadRecord 读取安装记录；不存在时返回 os.ErrNotExist。
func (s *Store) ReadRecord(id string) (*InstallRecord, error) {
	raw, err := os.ReadFile(s.RecordPath(id))
	if err != nil {
		return nil, err
	}
	var rec InstallRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, fmt.Errorf("解析插件安装记录失败(%s): %w", id, err)
	}
	return &rec, nil
}

// WriteRecord 原子写入安装记录。
func (s *Store) WriteRecord(rec *InstallRecord) error {
	if rec == nil || rec.ID == "" {
		return fmt.Errorf("安装记录缺少插件 id")
	}
	if rec.InstalledAt == "" {
		rec.InstalledAt = nowRFC3339()
	}
	if err := os.MkdirAll(s.PluginDir(rec.ID), 0o755); err != nil {
		return fmt.Errorf("创建插件目录失败: %w", err)
	}
	raw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化安装记录失败: %w", err)
	}
	return writeFileAtomic(s.RecordPath(rec.ID), raw, 0o644)
}

// LoadManifest 读取某个版本的清单。
func (s *Store) LoadManifest(id, version string) (*Manifest, error) {
	return LoadManifest(s.VersionDir(id, version))
}

// RemovePlugin 删除整个插件（全部版本与记录）。
func (s *Store) RemovePlugin(id string) error {
	if err := validatePluginID(id); err != nil {
		return err
	}
	dir := s.PluginDir(id)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("删除插件目录失败: %w", err)
	}
	return nil
}

// RemoveVersion 删除某个版本目录。
func (s *Store) RemoveVersion(id, version string) error {
	if err := validatePluginID(id); err != nil {
		return err
	}
	if _, err := semver.Parse(version); err != nil {
		return fmt.Errorf("版本号非法: %q", version)
	}
	if err := os.RemoveAll(s.VersionDir(id, version)); err != nil {
		return fmt.Errorf("删除插件版本失败: %w", err)
	}
	return nil
}

// AssetPath 解析插件资源路径，并确保未越出插件版本目录。
func (s *Store) AssetPath(id, version, rel string) (string, error) {
	if err := validatePluginID(id); err != nil {
		return "", err
	}
	if _, err := semver.Parse(version); err != nil {
		return "", fmt.Errorf("版本号非法: %q", version)
	}
	if err := validateRelPath(rel); err != nil {
		return "", err
	}
	base := s.VersionDir(id, version)
	full := filepath.Join(base, filepath.FromSlash(rel))
	// 二次确认：Join 之后仍必须位于 base 之下
	relCheck, err := filepath.Rel(base, full)
	if err != nil {
		return "", fmt.Errorf("解析插件资源路径失败: %w", err)
	}
	if strings.HasPrefix(relCheck, "..") {
		return "", fmt.Errorf("插件资源路径越界: %q", rel)
	}
	return full, nil
}

// ReadAsset 读取插件资源文件内容。
func (s *Store) ReadAsset(id, version, rel string) ([]byte, error) {
	path, err := s.AssetPath(id, version, rel)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取插件资源失败(%s): %w", rel, err)
	}
	return raw, nil
}

// AssetExists 报告插件资源是否存在。
func (s *Store) AssetExists(id, version, rel string) bool {
	path, err := s.AssetPath(id, version, rel)
	if err != nil {
		return false
	}
	info, statErr := os.Stat(path)
	return statErr == nil && !info.IsDir()
}

// CleanupOldVersions 只保留 keep 个最新版本目录，返回被删除的版本。
func (s *Store) CleanupOldVersions(id string, keep int) ([]string, error) {
	versions, err := s.ListVersions(id)
	if err != nil {
		return nil, err
	}
	if len(versions) <= keep {
		return nil, nil
	}
	var removed []string
	for _, v := range versions[:len(versions)-keep] {
		if err := s.RemoveVersion(id, v); err != nil {
			return removed, err
		}
		removed = append(removed, v)
	}
	return removed, nil
}

// validatePluginID 校验插件标识，防止路径穿越。
func validatePluginID(id string) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("插件 id 非法: %q", id)
	}
	return nil
}

// nowRFC3339 当前时间的 RFC3339 表示。
func nowRFC3339() string { return time.Now().Format(time.RFC3339) }

// writeFileAtomic 先写临时文件再重命名，避免写入中途失败留下半截文件。
func writeFileAtomic(path string, data []byte, perm fs.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		// 失败路径下清理临时文件；成功路径下已被重命名，此处为空操作
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("同步临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return fmt.Errorf("设置文件权限失败: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("替换文件失败: %w", err)
	}
	return nil
}
