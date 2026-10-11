package plugin

import (
	"fmt"
	"sort"
	"strings"

	"toolbox/app/internal/semver"
)

// PackageKind 一个可安装包的来源类型。
type PackageKind string

const (
	// KindRegistry 来自官方索引（需要联网下载，可用本地缓存复用）
	KindRegistry PackageKind = "registry"
	// KindURL 来自任意下载地址
	KindURL PackageKind = "url"
	// KindFile 来自本地安装包文件
	KindFile PackageKind = "file"
	// KindLocalDir 来自本地目录（开发者模式）
	KindLocalDir PackageKind = "local"
	// KindBatch 来自同一次批量安装中用户选中的其它包
	KindBatch PackageKind = "batch"
	// KindInstalled 来自本地已安装版本（求解可复用，但不作为安装来源）
	KindInstalled PackageKind = "installed"
)

// Origin 描述「某个版本可以从哪里取得」。
//
// 依赖解析只关心选哪个版本；取得内容由安装器按 Origin 完成。
// 二者共用同一份 Catalog，保证「解析出来的版本」和「实际安装的包」永远对应。
type Origin struct {
	Kind     PackageKind
	// Ref 人类可读来源引用：下载地址 / 本地路径 / 包文件名
	Ref string
	// Checksum 期望的 sha256 摘要（registry 来源必填）
	Checksum string
	// Official 该条目在官方索引中被标记为官方审核
	Official bool
	// Payload 已读取到内存的安装包内容（url / file / batch 来源）
	Payload []byte
	// Dir 本地目录来源的目录路径
	Dir string
	// CachePath 本地包缓存中的 zip 路径（命中时可直接复用）
	CachePath string
	// Priority 同一个 (id, version) 出现多个来源时的优先级，数值大者胜出。
	//
	// 取值约定（见 installer.go）：
	//   - 用户显式选择的包（根要求）：最高，保证「重新安装同一版本」用的是用户给的包；
	//   - 本地已安装版本：次之，让求解优先复用它而不是重新下载；
	//   - 官方索引：最低，仅在没有更好的来源时使用。
	Priority int
}

// 来源优先级。
const (
	originPriorityRegistry  = 1
	originPriorityInstalled = 5
	originPriorityRoot      = 10
)

// Describe 返回用于界面展示的来源描述。
func (o Origin) Describe() string {
	if o.Ref != "" {
		return o.Ref
	}
	return string(o.Kind)
}

// CatalogEntry 目录中的一个候选版本。
type CatalogEntry struct {
	Manifest *Manifest
	Origin   Origin
}

// Catalog 可用插件目录：插件标识 → 各版本候选（按优先级降序）。
//
// 它是依赖求解的唯一输入，也是安装器取包的唯一依据。
// 目录可以由三类来源合并而成：
//   - 本地已安装插件（版本目录里的清单）
//   - 本次安装提供的包（离线 zip / 本地目录）
//   - 官方索引条目
type Catalog struct {
	entries map[string][]*CatalogEntry
}

// NewCatalog 创建空目录。
func NewCatalog() *Catalog {
	return &Catalog{entries: make(map[string][]*CatalogEntry)}
}

// Add 登记一个候选版本。
//
// 重复的 (id, version) 会被合并：优先保留带有可用内容/来源的条目；
// 若两次给出不同的摘要，则判定为冲突并报错 —— 同一个版本不允许有两个内容。
func (c *Catalog) Add(m *Manifest, origin Origin) error {
	if m == nil || m.ID == "" {
		return fmt.Errorf("目录条目缺少清单或插件 id")
	}
	for i, exist := range c.entries[m.ID] {
		if exist.Manifest.Version != m.Version {
			continue
		}
		if exist.Origin.Checksum != "" && origin.Checksum != "" &&
			!strings.EqualFold(NormalizeChecksum(exist.Origin.Checksum), NormalizeChecksum(origin.Checksum)) {
			return fmt.Errorf("插件 %s@%s 存在两个不同内容的包（摘要不一致）", m.ID, m.Version)
		}
		c.entries[m.ID][i] = preferEntry(exist, &CatalogEntry{Manifest: m, Origin: origin})
		return nil
	}
	c.entries[m.ID] = append(c.entries[m.ID], &CatalogEntry{Manifest: m, Origin: origin})
	c.sortVersions(m.ID)
	return nil
}

// MustAdd 忽略冲突地登记条目，仅用于测试与静态目录构建。
func (c *Catalog) MustAdd(m *Manifest, origin Origin) {
	if err := c.Add(m, origin); err != nil {
		panic(err)
	}
}

// preferEntry 在重复条目中挑选应当胜出的一个。
//
// 先比来源优先级（显式选择的包 > 已安装版本 > 索引），
// 同优先级时取信息更完整的一个，保证结果与加入顺序无关。
func preferEntry(a, b *CatalogEntry) *CatalogEntry {
	if b.Origin.Priority != a.Origin.Priority {
		if b.Origin.Priority > a.Origin.Priority {
			return b
		}
		return a
	}
	if completeness(b) > completeness(a) {
		return b
	}
	return a
}

func completeness(e *CatalogEntry) int {
	n := 0
	if e.Origin.Payload != nil {
		n += 4
	}
	if e.Origin.Dir != "" {
		n += 3
	}
	if e.Origin.CachePath != "" {
		n += 2
	}
	if e.Origin.Checksum != "" {
		n++
	}
	return n
}

func (c *Catalog) sortVersions(id string) {
	entries := c.entries[id]
	sort.SliceStable(entries, func(i, j int) bool {
		left, leftErr := semver.Parse(entries[i].Manifest.Version)
		right, rightErr := semver.Parse(entries[j].Manifest.Version)
		if leftErr != nil || rightErr != nil {
			return entries[i].Manifest.Version > entries[j].Manifest.Version
		}
		return left.Compare(right) > 0
	})
}

// Versions 返回某插件的全部候选（降序）。
func (c *Catalog) Versions(id string) []*CatalogEntry {
	return c.entries[id]
}

// Entry 返回指定版本的目录条目，不存在时返回 nil。
func (c *Catalog) Entry(id, version string) *CatalogEntry {
	for _, e := range c.entries[id] {
		if e.Manifest.Version == version {
			return e
		}
	}
	return nil
}

// Has 报告目录中是否存在该插件。
func (c *Catalog) Has(id string) bool {
	return len(c.entries[id]) > 0
}

// IDs 返回目录中的全部插件标识（已排序）。
func (c *Catalog) IDs() []string {
	ids := make([]string, 0, len(c.entries))
	for id := range c.entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Len 返回目录中的插件标识数量。
func (c *Catalog) Len() int { return len(c.entries) }
