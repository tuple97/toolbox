package plugin

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// 安装包解包的安全边界（插件包来自用户或网络，必须当作不可信输入）。
const (
	// maxPackageBytes 安装包最大字节数（64 MiB）
	maxPackageBytes = 64 << 20
	// maxExtractedBytes 解压后总大小上限（128 MiB），防 zip bomb
	maxExtractedBytes = 128 << 20
	// maxPackageFiles 安装包内文件数量上限
	maxPackageFiles = 512
	// maxPackagePathLen 单个条目路径长度上限
	maxPackagePathLen = 512
)

// ExtractPackage 把安装包（zip）解压到目标目录。
//
// 安全约束：
//   - 拒绝绝对路径、`..` 穿越与反斜杠伪造；
//   - 只接受常规文件，忽略符号链接等特殊条目；
//   - 限制条目数量、单条大小与解压后总大小；
//   - 要求包内含 manifest.json。
func ExtractPackage(data []byte, dest string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("%w: 不是合法的 zip 包: %v", ErrInvalidPackage, err)
	}
	if len(reader.File) > maxPackageFiles {
		return fmt.Errorf("%w: 包内文件过多（> %d）", ErrInvalidPackage, maxPackageFiles)
	}

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return fmt.Errorf("创建解压目录失败: %w", err)
	}

	var total int64
	hasManifest := false

	for _, f := range reader.File {
		// 统一使用正斜杠处理，再逐段过滤，杜绝路径穿越
		raw := strings.ReplaceAll(f.Name, "\\", "/")
		if len(raw) > maxPackagePathLen {
			return fmt.Errorf("%w: 包内路径过长: %q", ErrInvalidPackage, f.Name)
		}
		clean := path.Clean(raw)
		if clean == "." {
			continue
		}
		if strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "/../") {
			return fmt.Errorf("%w: 包内含非法路径: %q", ErrInvalidPackage, f.Name)
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if !f.Mode().IsRegular() {
			// 符号链接、设备文件等一律忽略：它们可以绕过目录约束
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
			return fmt.Errorf("%w: 解压后内容超出上限（> %d 字节）", ErrInvalidPackage, maxExtractedBytes)
		}
		if clean == ManifestFileName {
			hasManifest = true
		}
	}

	if !hasManifest {
		return fmt.Errorf("%w: 安装包内缺少 %s", ErrInvalidPackage, ManifestFileName)
	}
	return nil
}

// HasPackageEntry 报告安装包内是否存在某个（未解压的）条目。
//
// 用于在解压之前做一次「包内是否有入口文件」的粗筛。
func HasPackageEntry(data []byte, rel string) bool {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return false
	}
	want := path.Clean(strings.ReplaceAll(rel, "\\", "/"))
	for _, f := range reader.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if path.Clean(strings.ReplaceAll(f.Name, "\\", "/")) == want {
			return true
		}
	}
	return false
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

// validateEntries 校验清单声明的入口在插件目录内确实存在。
//
// 不做这一步会出现「安装成功但插件不可用」：前端入口缺失时工具不会被注册，
// 用户只看到菜单没出现，却拿不到任何错误提示。
func validateEntries(root string, mf *Manifest) error {
	exists := func(rel string) bool {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		return err == nil && !info.IsDir()
	}

	frontend := mf.FrontendEntry()
	if frontend != "" && !exists(frontend) {
		return fmt.Errorf("%w: 缺少前端入口 %s（若装的是插件源码目录，请先在插件仓库执行 pnpm build）",
			ErrInvalidPackage, frontend)
	}

	if mf.BackendKind() != BackendNone {
		entry := mf.BackendEntry()
		if entry != "" && !exists(entry) {
			return fmt.Errorf("%w: 缺少后端入口 %s", ErrInvalidPackage, entry)
		}
	}
	return nil
}

// subPluginDirs 列出目录下「自身含 manifest.json」的一级子目录（已排序）。
//
// 用于把「选中了父目录」这一误操作翻译成人能看懂的错误提示。
func subPluginDirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidate := filepath.Join(dir, entry.Name(), ManifestFileName)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			out = append(out, entry.Name())
		}
	}
	return out
}

// copyTree 递归复制目录（用于本地目录来源的插件）。
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(src, p)
		if relErr != nil {
			return relErr
		}
		target := filepath.Join(dst, rel)

		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
			return mkErr
		}
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return readErr
		}
		return os.WriteFile(target, data, 0o644)
	})
}
