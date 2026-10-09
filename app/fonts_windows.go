//go:build windows

package app

import (
	"sort"
	"strings"
	"sync"

	"golang.org/x/sys/windows/registry"
)

// 字体注册表项（机器级 + 用户级）
var fontRegistryKeys = []struct {
	root registry.Key
	path string
}{
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`},
	{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`},
}

// 注册表值名末尾的字体类型后缀
var fontTypeSuffixes = []string{
	" (TrueType)",
	" (OpenType)",
	" (All res)",
	" (VGA res)",
	" (Plotter)",
}

// 纯符号/装饰字体
var symbolFontPatterns = []string{
	"symbol", "wingdings", "webdings", "marlett", "holiday", "camcorder",
}

// 样式后缀，仅当去掉后缀后的名字也在列表里时才丢弃
var fontStyleSuffixes = []string{
	" Bold Italic", " Bold Oblique", " Bold", " Italic", " Oblique", " Regular",
}

// 字体列表在单次运行内缓存
var (
	fontsOnce  sync.Once
	fontsCache []string
)

// ListSystemFonts 返回本机已安装的字体族名称（去重、忽略大小写排序）
func ListSystemFonts() []string {
	fontsOnce.Do(func() {
		fontsCache = collectSystemFonts()
	})
	// 返回副本，避免调用方修改缓存
	result := make([]string, len(fontsCache))
	copy(result, fontsCache)
	return result
}

// collectSystemFonts 汇总所有注册表项中的字体族名
func collectSystemFonts() []string {
	seen := make(map[string]struct{})
	names := make([]string, 0, 256)

	for _, item := range fontRegistryKeys {
		families := readFontFamilies(item.root, item.path)
		for _, name := range families {
			key := strings.ToLower(name)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			names = append(names, name)
		}
	}

	sort.Slice(names, func(i, j int) bool {
		return strings.ToLower(names[i]) < strings.ToLower(names[j])
	})
	return dropStyleVariants(names)
}

// dropStyleVariants 丢弃「已有字族 + 样式后缀」的冗余条目
func dropStyleVariants(names []string) []string {
	existing := make(map[string]struct{}, len(names))
	for _, name := range names {
		existing[strings.ToLower(name)] = struct{}{}
	}

	result := make([]string, 0, len(names))
	for _, name := range names {
		if isStyleVariant(name, existing) {
			continue
		}
		result = append(result, name)
	}
	return result
}

// isStyleVariant 判断是否为其他字族的样式变体。
func isStyleVariant(name string, existing map[string]struct{}) bool {
	for _, suffix := range fontStyleSuffixes {
		if !strings.HasSuffix(name, suffix) {
			continue
		}
		base := strings.ToLower(strings.TrimSuffix(name, suffix))
		if _, ok := existing[base]; ok {
			return true
		}
	}
	return false
}

// readFontFamilies 读取单个注册表项下的字体族名。
func readFontFamilies(root registry.Key, path string) []string {
	key, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer key.Close()

	valueNames, err := key.ReadValueNames(0)
	if err != nil {
		return nil
	}

	families := make([]string, 0, len(valueNames))
	for _, valueName := range valueNames {
		families = append(families, splitFontValueName(valueName)...)
	}
	return families
}

// splitFontValueName 把注册表值名拆成字体族名（多个族用 " & " 连接）
func splitFontValueName(valueName string) []string {
	name := strings.TrimSpace(valueName)
	if name == "" || looksLikeFileName(name) {
		return nil
	}

	for _, suffix := range fontTypeSuffixes {
		if strings.HasSuffix(name, suffix) {
			name = strings.TrimSuffix(name, suffix)
			break
		}
	}

	parts := strings.Split(name, " & ")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || isSymbolFont(part) {
			continue
		}
		result = append(result, part)
	}
	return result
}

// looksLikeFileName 判断注册表值名是否为字体文件名
func looksLikeFileName(name string) bool {
	lower := strings.ToLower(name)
	for _, ext := range []string{".ttf", ".ttc", ".otf", ".fon", ".fnt"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// isSymbolFont 判断是否为符号/装饰字体。
func isSymbolFont(name string) bool {
	lower := strings.ToLower(name)
	for _, pattern := range symbolFontPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}
