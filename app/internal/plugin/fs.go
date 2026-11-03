package plugin

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// 插件侧的本地文件能力。

// maxReadFileBytes 单次读取上限（4 MiB）
const maxReadFileBytes = 4 << 20

// maxWriteFileBytes 单次写入上限（16 MiB）
const maxWriteFileBytes = 16 << 20

// winVarPattern 匹配 %APPDATA% 这类 Windows 环境变量写法
var winVarPattern = regexp.MustCompile(`%([A-Za-z_][A-Za-z0-9_]*)%`)

// expandPath 展开 ~、$VAR、%VAR% 并转为绝对路径。
func expandPath(path string) string {
	text := strings.TrimSpace(path)
	if text == "" {
		return ""
	}

	if text == "~" || strings.HasPrefix(text, "~/") || strings.HasPrefix(text, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			text = home + text[1:]
		}
	}

	text = winVarPattern.ReplaceAllStringFunc(text, func(match string) string {
		key := match[1 : len(match)-1]
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		return match
	})
	text = os.ExpandEnv(text)

	if abs, err := filepath.Abs(text); err == nil {
		return filepath.Clean(abs)
	}
	return filepath.Clean(text)
}

// allowsFile 判断路径是否落在白名单目录内。
func (p Permissions) allowsFile(path string) bool {
	if len(p.Files) == 0 {
		return false
	}

	target := expandPath(path)
	if target == "" {
		return false
	}

	for _, item := range p.Files {
		root := expandPath(item)
		if root == "" {
			continue
		}
		if target == root {
			return true
		}
		prefix := root
		if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
			prefix += string(os.PathSeparator)
		}
		if strings.HasPrefix(target, prefix) {
			return true
		}
	}
	return false
}

// ReadTextFile 读取白名单目录下的文本文件。
func (h *HostBridge) ReadTextFile(path string) (string, error) {
	if !h.perms.allowsFile(path) {
		return "", fmt.Errorf("%w: 读取本地文件（未在清单 permissions.files 中声明）", ErrPermissionDenied)
	}

	full := expandPath(path)
	info, err := os.Stat(full)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("读取文件失败: %s 是目录", full)
	}
	if info.Size() > maxReadFileBytes {
		return "", fmt.Errorf("读取文件失败: 超过 %d 字节上限", maxReadFileBytes)
	}

	raw, err := os.ReadFile(full)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	return string(raw), nil
}

// FileExists 判断白名单目录下的路径是否存在。
func (h *HostBridge) FileExists(path string) bool {
	if !h.perms.allowsFile(path) {
		return false
	}
	_, err := os.Stat(expandPath(path))
	return err == nil
}

// ListDir 列出白名单目录下的条目名（不递归）。
func (h *HostBridge) ListDir(path string) ([]string, error) {
	if !h.perms.allowsFile(path) {
		return nil, fmt.Errorf("%w: 列出目录（未在清单 permissions.files 中声明）", ErrPermissionDenied)
	}

	full := expandPath(path)
	entries, err := os.ReadDir(full)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("读取目录失败: %w", err)
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, nil
}

// WriteTextFile 把文本写入清单 permissions.files 声明目录下的文件。
func (h *HostBridge) WriteTextFile(path, fileName, content string) (string, error) {
	if !h.perms.allowsFile(path) {
		return "", fmt.Errorf("%w: 写入本地文件（未在清单 permissions.files 中声明目录）", ErrPermissionDenied)
	}
	if len(content) > maxWriteFileBytes {
		return "", fmt.Errorf("写入文件失败: 内容超过 %d 字节上限", maxWriteFileBytes)
	}

	full := expandPath(path)
	if info, err := os.Stat(full); err == nil && info.IsDir() {
		name := strings.TrimSpace(fileName)
		if name == "" {
			return "", fmt.Errorf("写入文件失败: %s 是目录，需要提供文件名", full)
		}
		// 只接受纯文件名：带路径分隔符的名字会把写入点挪到白名单之外
		if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
			return "", fmt.Errorf("写入文件失败: 文件名不能包含路径分隔符: %q", name)
		}
		full = filepath.Join(full, name)
	}

	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", fmt.Errorf("写入文件失败: 创建目录 %s 时出错: %w", filepath.Dir(full), err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("写入文件失败: %w", err)
	}
	return full, nil
}

// SaveTextFile 弹出「另存为」对话框并把文本写入用户选定的文件。
func (h *HostBridge) SaveTextFile(title, defaultFileName, content string, filters []FileFilter) (string, error) {
	if !h.perms.FileWrite {
		return "", fmt.Errorf("%w: 导出文件（未声明 permissions.fileWrite）", ErrPermissionDenied)
	}
	if len(content) > maxWriteFileBytes {
		return "", fmt.Errorf("导出文件失败: 内容超过 %d 字节上限", maxWriteFileBytes)
	}

	path, err := h.env.PromptSaveFile(title, defaultFileName, filters)
	if err != nil {
		return "", fmt.Errorf("打开保存对话框失败: %w", err)
	}
	if strings.TrimSpace(path) == "" {
		// 用户取消：不是错误，交给插件决定要不要提示
		return "", nil
	}

	full := expandPath(path)
	if info, statErr := os.Stat(full); statErr == nil && info.IsDir() {
		return "", fmt.Errorf("导出文件失败: %s 是目录", full)
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", fmt.Errorf("导出文件失败: 创建目录 %s 时出错: %w", filepath.Dir(full), err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("导出文件失败: %w", err)
	}
	return full, nil
}
