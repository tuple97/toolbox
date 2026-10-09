package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"toolbox/app/internal/plugin"
)

// decodeArchive 解码前端传来的 base64 插件包内容。
func decodeArchive(contentBase64 string) ([]byte, error) {
	raw := strings.TrimSpace(contentBase64)
	if raw == "" {
		return nil, fmt.Errorf("插件包内容为空")
	}
	// 兼容前端直接传 data URL 的情况（FileReader.readAsDataURL 的产物）
	if idx := strings.IndexByte(raw, ','); idx >= 0 && strings.HasPrefix(raw, "data:") {
		raw = raw[idx+1:]
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("插件包内容不是合法的 base64: %w", err)
	}
	return decoded, nil
}

/*
插件相关的绑定：一律薄转发到 internal/plugin.Manager。

为什么插件后端调用不走「每个插件一套绑定方法」：
Wails 的方法绑定发生在编译期，插件是运行期才安装的，
因此所有插件调用统一收敛到 PluginInvoke 这一个网关，
由管理器按插件标识分发到对应运行时。
*/

// pluginReady 返回可用的插件管理器。
func (a *App) pluginReady() (*plugin.Manager, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if a.plugins == nil {
		return nil, fmt.Errorf("插件体系未初始化")
	}
	return a.plugins, nil
}

// PluginPreviewBasic 快速预览插件包基本信息（本地完成，不联网）。
//
// 界面先用它渲染插件卡片，再调 PluginPreviewInstall 补齐依赖计划 ——
// 依赖求解可能要访问官方索引，不该让基本信息陪着一起等。
func (a *App) PluginPreviewBasic(req plugin.InstallRequest) (*plugin.InstallPreview, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.PreviewBasic(context.Background(), req)
}

// PluginPreviewArchive 预览从离线包安装（包内容以 base64 传入）。
//
// 前端拖入或选中 .zip 后先调它：拿到权限清单、依赖闭包与风险提示，
// 用户在弹窗里确认后再调 PluginInstallArchive。
func (a *App) PluginPreviewArchive(fileName string, contentBase64 string) (*plugin.InstallPreview, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	content, err := decodeArchive(contentBase64)
	if err != nil {
		return nil, err
	}
	return mgr.PreviewArchive(context.Background(), fileName, content)
}

// PluginPreviewArchiveBasic 快速预览离线包的基本信息（不求解依赖）。
func (a *App) PluginPreviewArchiveBasic(fileName string, contentBase64 string) (*plugin.InstallPreview, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	content, err := decodeArchive(contentBase64)
	if err != nil {
		return nil, err
	}
	return mgr.PreviewArchiveBasic(fileName, content)
}

// PluginInstallArchive 从离线包安装。
//
// trust 表示用户确认信任该来源；acceptPermissions 表示接受升级新增的权限。
func (a *App) PluginInstallArchive(
	fileName string,
	contentBase64 string,
	trust bool,
	acceptPermissions bool,
) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	content, err := decodeArchive(contentBase64)
	if err != nil {
		return err
	}
	return mgr.InstallArchive(context.Background(), fileName, content, trust, acceptPermissions)
}

// PluginReadAsset 读取插件内的文本资源。
//
// 供前端在开发模式下以 Blob 方式加载插件前端产物（dev 模式的窗口由
// Vite dev server 提供，/plugins/ 静态地址会被 Vite 接管而读不到文件）。
func (a *App) PluginReadAsset(id string, version string, path string) (string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return "", err
	}
	return mgr.ReadAssetText(id, version, path)
}

// PluginList 返回全部已安装插件的完整信息。
func (a *App) PluginList() ([]plugin.InstalledInfo, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.ListInstalled(), nil
}

// PluginMarketplace 返回插件市场快照（refresh 为 true 时强制刷新索引）。
func (a *App) PluginMarketplace(refresh bool) (*plugin.MarketplaceSnapshot, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.Marketplace(context.Background(), refresh), nil
}

// PluginPreviewInstall 生成安装预览（权限确认弹窗的数据源）。
func (a *App) PluginPreviewInstall(req plugin.InstallRequest) (*plugin.InstallPreview, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.Preview(context.Background(), req)
}

// PluginInstall 安装或升级插件。
//
// req.Trust 表示用户已确认信任来源；
// req.AcceptPermissions 表示用户已确认接受新增权限。
func (a *App) PluginInstall(req plugin.InstallRequest) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.Install(context.Background(), req)
}

// PluginUninstall 卸载插件。
//
// force 为 false 时，被其它插件依赖会被拒绝，并在错误里说明依赖方；
// force 为 true 时先停用依赖它的插件（含传递依赖）再卸载，
// 返回被停用的插件 id，供前端提示用户。
func (a *App) PluginUninstall(id string, force bool) ([]string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.Uninstall(context.Background(), id, force)
}

// PluginSetEnabled 启用或停用插件。
func (a *App) PluginSetEnabled(id string, enabled bool) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.SetEnabled(context.Background(), id, enabled)
}

// PluginSetTrusted 设置插件的信任状态。
func (a *App) PluginSetTrusted(id string, trusted bool) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.SetTrusted(context.Background(), id, trusted)
}

// PluginCheckUpdates 检查全部已安装插件的可用更新。
func (a *App) PluginCheckUpdates() ([]plugin.UpdateInfo, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.CheckUpdates(context.Background())
}

// PluginUpgrade 把插件升级到最新版本。
func (a *App) PluginUpgrade(id string, acceptPermissions bool) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.Upgrade(context.Background(), id, acceptPermissions)
}

// PluginRollback 把插件回滚到上一个版本。
func (a *App) PluginRollback(id string) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.Rollback(context.Background(), id)
}

// PluginReload 重新扫描并加载全部插件（开发者改了插件后手动触发）。
func (a *App) PluginReload() error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.Reload(context.Background())
}

// PluginInvoke 调用插件注册的后端 handler。
//
// 这是插件后端能力的唯一入口：参数与返回值均为 JSON 字符串。
//
// 刻意用 string 而不是 json.RawMessage（[]byte）：
// 后者的绑定会按 base64 编码传输，前端必须做一次无意义的编解码，
// 且失败时的报错难以理解。这里由两端各自完成 JSON 序列化，语义更直白。
func (a *App) PluginInvoke(id string, handler string, args string) (string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return "", err
	}

	payload := json.RawMessage(args)
	if strings.TrimSpace(args) == "" {
		payload = json.RawMessage("{}")
	}
	result, err := mgr.Invoke(context.Background(), id, handler, payload)
	if err != nil {
		return "", err
	}
	return string(result), nil
}

// PluginGetSetting 读取插件的某个配置项。
func (a *App) PluginGetSetting(pluginID string, key string) (string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return "", err
	}
	value, _, err := mgr.StorageGet(pluginID, key)
	return value, err
}

// PluginSetSetting 写入插件的某个配置项。
func (a *App) PluginSetSetting(pluginID string, key string, value string) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.StorageSet(pluginID, key, value)
}

// PluginRegistryURL 返回当前插件索引地址。
func (a *App) PluginRegistryURL() (string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return "", err
	}
	return mgr.RegistryIndexURL(), nil
}

// PluginSetRegistryURL 更换插件索引地址（镜像或私有源）。
func (a *App) PluginSetRegistryURL(url string) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	mgr.SetRegistryIndexURL(url)
	return nil
}

// PluginAssetBase 返回插件前端资源的 URL 前缀。
//
// 前端据此拼出插件 ESM 入口：<base><id>/<version>/frontend/index.js
func (a *App) PluginAssetBase() string {
	return "/plugins/"
}
