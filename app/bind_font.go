package app

// ---------------------------------------------------------------- 字体

// ListSystemFonts 返回本机已安装的字体族名称列表
func (a *App) ListSystemFonts() []string {
	return ListSystemFonts()
}
