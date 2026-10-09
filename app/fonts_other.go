//go:build !windows

package app

// ListSystemFonts 非 Windows 平台返回空列表
func ListSystemFonts() []string {
	return nil
}
