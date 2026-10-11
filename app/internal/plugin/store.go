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

// 插件数据目录布局：
//
//	<DataDir>/
//	├── plugins/<插件id>/record.json          安装记录（唯一权威）
//	├── plugins/<插件id>/<版本>/              正式插件文件
//	├── plugin-cache/<sha256>.zip             下载/导入包缓存
//	├── plugin-staging/<事务id>/              事务暂存区（提交前不进入正式目录）
//	└── plugin-transactions/<事务id>.json     事务日志（崩溃恢复依据）
//
// 关键约定：同一个「某版本是否已安装」的事实只存在于两处 ——
// record.json 的 Version 字段与磁盘上的版本目录，二者由事务一起提交。
const (
	installRecordName = "record.json"
	// legacyRecordName 旧版安装记录文件名，仅用于一次性迁移。
	legacyRecordName = ".install.json"

	pluginsDirName  = "plugins"
	cacheDirName    = "plugin-cache"
	stagingDirName  = "plugin-staging"
	transactionsDir = "plugin-transactions"
)

// TrustLevel 插件的信任来源等级。
type TrustLevel string

const (
	// TrustNone 尚未获得信任
	TrustNone TrustLevel = "none"
	// TrustOfficial 官方索引条目且索引签名校验通过
	TrustOfficial TrustLevel = "official"
	// TrustUser 用户显式确认信任的第三方来源
	TrustUser TrustLevel = "user"
)

// InstallRecord 一个插件的安装与信任元数据（持久化到 record.json）。
type InstallRecord struct {
	// ID 插件标识
	ID string `json:"id"`
	// Version 当前启用的版本
	Version string `json:"version"`
	// Source 来源类型（registry / url / file / local）
	Source string `json:"source"`
	// SourceRef 来源引用（URL / 路径 / 市场 id）
	SourceRef string `json:"sourceRef,omitempty"`
	// Checksum 安装包内容摘要（sha256:...）
	Checksum string `json:"checksum,omitempty"`
	// Trust 信任等级
	Trust TrustLevel `json:"trust"`
	// TrustedAt 信任时间（RFC3339）
	TrustedAt string `json:"trustedAt,omitempty"`
	// Official 是否来自官方索引且被标记为官方审核
	Official bool `json:"official,omitempty"`
	// Enabled 用户是否希望启用（注意：不等于实际运行状态）
	Enabled bool `json:"enabled"`
	// Permissions 安装时的权限快照（用于升级时比对是否扩张）
	Permissions Permissions `json:"permissions,omitempty"`
	// InstalledAt 安装时间（RFC3339）
	InstalledAt string `json:"installedAt"`
	// UpdatedAt 最近一次安装/重装/升级时间（RFC3339）
	UpdatedAt string `json:"updatedAt,omitempty"`
	// PreviousVersion 上一个版本（用于回滚）
	PreviousVersion string `json:"previousVersion,omitempty"`
}

// IsTrusted 报告插件是否已获得信任。
func (r *InstallRecord) IsTrusted() bool {
	return r != nil && (r.Trust == TrustOfficial || r.Trust == TrustUser)
}

// Store 管理磁盘上的插件仓库。
type Store struct {
	dataDir    string
	root       string
	cacheDir   string
	stagingDir string
	txDir      string
}

// NewStore 创建插件仓库。
func NewStore(dataDir string) *Store {
	return &Store{
		dataDir:    dataDir,
		root:       filepath.Join(dataDir, pluginsDirName),
		cacheDir:   filepath.Join(dataDir, cacheDirName),
		stagingDir: filepath.Join(dataDir, stagingDirName),
		txDir:      filepath.Join(dataDir, transactionsDir),
	}
}

// DataDir 返回应用数据目录。
func (s *Store) DataDir() string { return s.dataDir }

// Root 返回插件根目录。
func (s *Store) Root() string { return s.root }

// CacheDir 返回安装包缓存目录。
func (s *Store) CacheDir() string { return s.cacheDir }

// TxDir 返回事务日志目录。
func (s *Store) TxDir() string { return s.txDir }

// EnsureLayout 确保全部目录存在。
func (s *Store) EnsureLayout() error {
	for _, dir := range []string{s.root, s.cacheDir, s.stagingDir, s.txDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("创建目录失败(%s): %w", dir, err)
		}
	}
	return nil
}

// EnsureRoot 确保插件根目录存在（兼容旧调用点）。
func (s *Store) EnsureRoot() error { return s.EnsureLayout() }

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

// legacyRecordPath 旧版安装记录路径。
func (s *Store) legacyRecordPath(id string) string {
	return filepath.Join(s.root, id, legacyRecordName)
}

// StagingRoot 返回某个事务的暂存根目录。
func (s *Store) StagingRoot(txID string) string {
	return filepath.Join(s.stagingDir, txID)
}

// StagingVersionDir 返回某个事务中某插件版本的暂存目录。
func (s *Store) StagingVersionDir(txID, id, version string) string {
	return filepath.Join(s.stagingDir, txID, id, version)
}

// JournalPath 返回某个事务的日志路径。
func (s *Store) JournalPath(txID string) string {
	return filepath.Join(s.txDir, txID+".json")
}

// ListIDs 列出全部已安装插件标识（含仅有安装记录但版本目录缺失的情况）。
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
		if validatePluginID(e.Name()) != nil {
			continue
		}
		ids = append(ids, e.Name())
	}
	sort.Strings(ids)
	return ids, nil
}

// ListVersions 列出某个插件目录下已存在的版本（按版本升序）。
func (s *Store) ListVersions(id string) ([]string, error) {
	entries, err := os.ReadDir(s.PluginDir(id))
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

// HasVersion 报告某个版本目录是否存在。
func (s *Store) HasVersion(id, version string) bool {
	info, err := os.Stat(s.VersionDir(id, version))
	return err == nil && info.IsDir()
}

// ReadRecord 读取安装记录。
//
// 优先读新格式 record.json；不存在时回退到旧格式 .install.json 并就地迁移 ——
// 迁移是幂等的：转换成功后立刻写出 record.json，旧文件保留不再使用。
func (s *Store) ReadRecord(id string) (*InstallRecord, error) {
	raw, err := os.ReadFile(s.RecordPath(id))
	if err == nil {
		var rec InstallRecord
		if decodeErr := json.Unmarshal(raw, &rec); decodeErr != nil {
			return nil, fmt.Errorf("解析插件安装记录失败(%s): %w", id, decodeErr)
		}
		if rec.ID == "" {
			rec.ID = id
		}
		return &rec, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}

	legacy, legacyErr := s.readLegacyRecord(id)
	if legacyErr != nil {
		return nil, err // 新记录不存在且旧记录也不可用：报原始错误
	}
	if writeErr := s.WriteRecord(legacy); writeErr != nil {
		return legacy, nil // 迁移写盘失败不影响本次读取
	}
	return legacy, nil
}

// legacyInstallRecord 旧版安装记录结构（仅迁移使用）。
type legacyInstallRecord struct {
	ID              string      `json:"id"`
	Version         string      `json:"version"`
	Source          string      `json:"source"`
	SourceRef       string      `json:"sourceRef,omitempty"`
	Checksum        string      `json:"checksum,omitempty"`
	Publisher       string      `json:"publisher,omitempty"`
	Trusted         bool        `json:"trusted"`
	TrustedAt       string      `json:"trustedAt,omitempty"`
	Enabled         bool        `json:"enabled"`
	Official        bool        `json:"official,omitempty"`
	Permissions     Permissions `json:"permissions,omitempty"`
	InstalledAt     string      `json:"installedAt"`
	UpdatedAt       string      `json:"updatedAt,omitempty"`
	PreviousVersion string      `json:"previousVersion,omitempty"`
}

func (s *Store) readLegacyRecord(id string) (*InstallRecord, error) {
	raw, err := os.ReadFile(s.legacyRecordPath(id))
	if err != nil {
		return nil, err
	}
	var old legacyInstallRecord
	if err := json.Unmarshal(raw, &old); err != nil {
		return nil, fmt.Errorf("解析旧版插件安装记录失败(%s): %w", id, err)
	}
	trust := TrustNone
	if old.Trusted {
		trust = TrustUser
		if old.Official {
			trust = TrustOfficial
		}
	}
	rec := &InstallRecord{
		ID:              id,
		Version:         old.Version,
		Source:          old.Source,
		SourceRef:       old.SourceRef,
		Checksum:        old.Checksum,
		Trust:           trust,
		TrustedAt:       old.TrustedAt,
		Official:        old.Official,
		Enabled:         old.Enabled,
		Permissions:     old.Permissions,
		InstalledAt:     old.InstalledAt,
		UpdatedAt:       old.UpdatedAt,
		PreviousVersion: old.PreviousVersion,
	}
	if rec.InstalledAt == "" {
		rec.InstalledAt = nowRFC3339()
	}
	return rec, nil
}

// WriteRecord 原子写入安装记录。
func (s *Store) WriteRecord(rec *InstallRecord) error {
	if rec == nil || rec.ID == "" {
		return fmt.Errorf("安装记录缺少插件 id")
	}
	if err := validatePluginID(rec.ID); err != nil {
		return err
	}
	if rec.Trust == "" {
		rec.Trust = TrustNone
	}
	if rec.InstalledAt == "" {
		rec.InstalledAt = nowRFC3339()
	}
	return s.writeRecordJSON(rec)
}

func (s *Store) writeRecordJSON(rec *InstallRecord) error {
	if err := os.MkdirAll(s.PluginDir(rec.ID), 0o755); err != nil {
		return fmt.Errorf("创建插件目录失败: %w", err)
	}
	raw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化安装记录失败: %w", err)
	}
	return writeFileAtomic(s.RecordPath(rec.ID), raw, 0o644)
}

// RemoveRecord 删除安装记录（回滚「首次安装」时使用）。
func (s *Store) RemoveRecord(id string) error {
	err := os.Remove(s.RecordPath(id))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// LoadManifest 读取某个版本目录中的清单。
func (s *Store) LoadManifest(id, version string) (*Manifest, error) {
	return LoadInstalledManifest(s.VersionDir(id, version))
}

// RemovePlugin 删除整个插件（全部版本与记录）。
func (s *Store) RemovePlugin(id string) error {
	if err := validatePluginID(id); err != nil {
		return err
	}
	if err := os.RemoveAll(s.PluginDir(id)); err != nil {
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
	if relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
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

// CleanupOldVersions 只保留 keep 个最新版本目录，返回被删除的版本。
//
// protect 指定的版本永不删除（通常是当前启用版本与可回滚版本）。
func (s *Store) CleanupOldVersions(id string, keep int, protect ...string) ([]string, error) {
	versions, err := s.ListVersions(id)
	if err != nil {
		return nil, err
	}
	if len(versions) <= keep {
		return nil, nil
	}
	protected := make(map[string]struct{}, len(protect))
	for _, v := range protect {
		if v != "" {
			protected[v] = struct{}{}
		}
	}

	var removed []string
	kept := 0
	for i := len(versions) - 1; i >= 0; i-- {
		version := versions[i]
		if _, ok := protected[version]; ok {
			continue
		}
		if kept < keep {
			kept++
			continue
		}
		if err := s.RemoveVersion(id, version); err != nil {
			return removed, err
		}
		removed = append(removed, version)
	}
	sort.Strings(removed)
	return removed, nil
}

// ---------------------------------------------------------------- 包缓存

// cachePath 由摘要得到缓存文件路径。
func (s *Store) cachePath(digest string) (string, error) {
	normalized := NormalizeChecksum(digest)
	if normalized == "" {
		return "", fmt.Errorf("缓存摘要为空")
	}
	name := strings.ReplaceAll(strings.TrimPrefix(normalized, "sha256:"), ":", "_")
	if name == "" {
		return "", fmt.Errorf("缓存摘要非法: %q", digest)
	}
	return filepath.Join(s.cacheDir, name+".zip"), nil
}

// PutCache 把安装包写入缓存（已存在则跳过）。
//
// 除 zip 本体外还会写一份 <摘要>.json 的清单副本：离线安装时无法访问索引，
// 只能靠缓存得知「本地已有哪个插件的哪个版本」，这份副本就是那唯一的线索。
func (s *Store) PutCache(digest string, payload []byte, mf *Manifest) error {
	path, err := s.cachePath(digest)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.cacheDir, 0o755); err != nil {
		return fmt.Errorf("创建缓存目录失败: %w", err)
	}
	if info, statErr := os.Stat(path); statErr != nil || info.Size() != int64(len(payload)) {
		if err := writeFileAtomic(path, payload, 0o644); err != nil {
			return fmt.Errorf("写入插件包缓存失败: %w", err)
		}
	}
	if mf == nil {
		return nil
	}
	raw, marshalErr := json.MarshalIndent(mf, "", "  ")
	if marshalErr != nil {
		return fmt.Errorf("序列化缓存清单失败: %w", marshalErr)
	}
	if err := writeFileAtomic(s.cacheManifestPath(digest), raw, 0o644); err != nil {
		return fmt.Errorf("写入缓存清单失败: %w", err)
	}
	return nil
}

// cacheManifestPath 缓存清单副本路径。
func (s *Store) cacheManifestPath(digest string) string {
	path, err := s.cachePath(digest)
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(path, ".zip") + ".json"
}

// CachedPackage 缓存中一个可离线安装的包。
type CachedPackage struct {
	// Manifest 包内清单
	Manifest *Manifest
	// Checksum 包内容摘要
	Checksum string
	// Path zip 文件路径
	Path string
}

// CachedPackages 列出缓存中全部可用的包。
//
// 清单损坏或 zip 缺失的条目会被跳过 —— 缓存是加速手段，不是权威状态，
// 坏掉的缓存不应影响正常安装流程。
func (s *Store) CachedPackages() []CachedPackage {
	entries, err := os.ReadDir(s.cacheDir)
	if err != nil {
		return nil
	}
	out := make([]CachedPackage, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		digest := "sha256:" + strings.TrimSuffix(entry.Name(), ".json")
		raw, readErr := os.ReadFile(filepath.Join(s.cacheDir, entry.Name()))
		if readErr != nil {
			continue
		}
		mf, parseErr := ParseManifest(raw)
		if parseErr != nil {
			continue
		}
		zipPath, ok := s.CacheFile(digest)
		if !ok {
			continue
		}
		out = append(out, CachedPackage{Manifest: mf, Checksum: digest, Path: zipPath})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Manifest.ID != out[j].Manifest.ID {
			return out[i].Manifest.ID < out[j].Manifest.ID
		}
		return out[i].Manifest.Version < out[j].Manifest.Version
	})
	return out
}

// CacheFile 返回缓存中该摘要对应的文件路径；未命中返回 ("", false)。
func (s *Store) CacheFile(digest string) (string, bool) {
	path, err := s.cachePath(digest)
	if err != nil {
		return "", false
	}
	info, statErr := os.Stat(path)
	if statErr != nil || info.IsDir() {
		return "", false
	}
	return path, true
}

// ReadCache 读取缓存中的安装包；未命中时返回 (nil, false, nil)。
func (s *Store) ReadCache(digest string) ([]byte, bool, error) {
	path, err := s.cachePath(digest)
	if err != nil {
		return nil, false, err
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return nil, false, nil
		}
		return nil, false, readErr
	}
	// 缓存内容损坏时视为未命中（不信任磁盘上的缓存）
	if err := VerifyChecksum(raw, digest); err != nil {
		return nil, false, nil
	}
	return raw, true, nil
}

// CleanupCache 删除缓存中不再需要的包，返回删除数量。
//
// keep 中的摘要会被保留（当前安装与可回滚版本所需）。
func (s *Store) CleanupCache(keep map[string]struct{}) (int, error) {
	entries, err := os.ReadDir(s.cacheDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		switch {
		case strings.HasSuffix(name, ".zip"):
		case strings.HasSuffix(name, ".json"):
		default:
			continue
		}
		base := strings.TrimSuffix(strings.TrimSuffix(name, ".zip"), ".json")
		digest := "sha256:" + base
		if _, ok := keep[digest]; ok {
			continue
		}
		if err := os.Remove(filepath.Join(s.cacheDir, name)); err != nil {
			return removed, err
		}
		if strings.HasSuffix(name, ".zip") {
			removed++
		}
	}
	return removed, nil
}

// ---------------------------------------------------------------- 工具

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
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
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
