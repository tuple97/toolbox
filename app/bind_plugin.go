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

为什么安装只有一个 Preview + 一个 Install：
在线市场安装、URL 安装、本地 ZIP、本地目录、多包批量安装全部复用同一套
「读取包 → 求解闭包 → 生成计划 → 事务提交」流程。前端不再逐个调用安装接口，
否则批量包之间的相互依赖无法在一次求解里处理。
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

// PluginPreviewPackages 预览一批插件包的安装计划。
//
// resolveDependencies 为 false 时只读取清单（不联网），用于界面快速渲染卡片；
// 为 true 时求解完整依赖闭包并生成安装计划，返回的 planId 用于 PluginInstallPlan。
// offline 为 true 时禁止访问网络：依赖只能来自本批次的包、本地已装版本或本地缓存。
func (a *App) PluginPreviewPackages(
	inputs []plugin.PackageInputWire,
	resolveDependencies bool,
	offline bool,
) (*plugin.InstallPreview, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}

	converted := make([]plugin.PackageInput, 0, len(inputs))
	for _, in := range inputs {
		item := plugin.PackageInput{
			Source:  in.Source,
			ID:      in.ID,
			Version: in.Version,
			Ref:     in.Ref,
		}
		if strings.TrimSpace(in.ContentBase64) != "" {
			content, decodeErr := decodeArchive(in.ContentBase64)
			if decodeErr != nil {
				return nil, fmt.Errorf("%s: %w", displayName(in), decodeErr)
			}
			item.Content = content
		}
		if item.Ref == "" && in.FileName != "" {
			item.Ref = in.FileName
		}
		converted = append(converted, item)
	}

	return mgr.Preview(context.Background(), converted, plugin.PreviewOptions{
		ResolveDependencies: resolveDependencies,
		Offline:             offline,
	})
}

// PluginInstallPlan 按已确认的安装计划完成安装。
//
// trust 表示用户已确认信任来源；acceptPermissions 表示接受新增权限。
// 计划 ID 由 PluginPreviewPackages 返回；计划过期或已被使用时会明确报错，
// 不会重新求解后偷偷换包。
func (a *App) PluginInstallPlan(planID string, trust bool, acceptPermissions bool) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.InstallPlan(context.Background(), planID, trust, acceptPermissions)
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
//
// 索引读取失败不会让插件管理界面不可用：错误随快照返回，界面提示后可重试。
func (a *App) PluginMarketplace(refresh bool) (plugin.MarketplaceSnapshot, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return plugin.MarketplaceSnapshot{}, err
	}
	return mgr.Marketplace(context.Background(), refresh), nil
}

// PluginUninstall 卸载插件。
//
// force 为 false 时，被其它插件依赖会被拒绝，并在错误里说明依赖方；
// force 为 true 时先停用依赖它的插件（含传递依赖）再卸载，
// 返回被停用的插件 id，供前端提示用户。
//
// 卸载默认保留插件的配置数据，彻底清除请另调 PluginClearData。
func (a *App) PluginUninstall(id string, force bool) ([]string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.Uninstall(context.Background(), id, force)
}

// PluginSetEnabled 启用或停用插件。
//
// 停用被其它插件依赖的插件时默认拒绝；cascade 为 true 时级联停用依赖方。
// 返回被一并停用（或本次实际变更）的插件 id。
func (a *App) PluginSetEnabled(id string, enabled bool, cascade bool) ([]string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.SetEnabled(context.Background(), id, enabled, cascade)
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

// PluginUpgrade 把插件升级到最新版本（内部复用同一套安装计划流程）。
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

// PluginRecoverError 返回启动时插件事务恢复遇到的问题（正常时为空）。
func (a *App) PluginRecoverError() string {
	if a.plugins == nil {
		return ""
	}
	return a.plugins.RecoverError()
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

// PluginGetSettings 读取插件的全部配置项。
func (a *App) PluginGetSettings(pluginID string) (map[string]string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return nil, err
	}
	return mgr.StorageList(pluginID)
}

// PluginSetSetting 写入插件的某个配置项。
func (a *App) PluginSetSetting(pluginID string, key string, value string) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.StorageSet(pluginID, key, value)
}

// PluginClearData 彻底清除某个插件的全部配置数据。
//
// 这是一个独立且明确的操作：卸载插件默认不会清理配置，
// 以免升级、回滚或误卸载导致用户数据丢失。
func (a *App) PluginClearData(pluginID string) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.ClearPluginData(pluginID)
}

// PluginRegistryURL 返回当前插件索引地址。
func (a *App) PluginRegistryURL() (string, error) {
	mgr, err := a.pluginReady()
	if err != nil {
		return "", err
	}
	return mgr.RegistryURL(), nil
}

// PluginSetRegistryURL 更换插件索引地址（镜像或私有源）。
//
// 更换地址不会改变宿主内置的验签公钥：镜像同样需要提供能通过验签的索引，
// 否则其中的插件与普通第三方来源一样需要用户确认信任。
func (a *App) PluginSetRegistryURL(url string) error {
	mgr, err := a.pluginReady()
	if err != nil {
		return err
	}
	return mgr.SetRegistryURL(url)
}

// PluginSignatureEnabled 报告宿主是否配置了官方索引签名公钥。
func (a *App) PluginSignatureEnabled() bool {
	return plugin.SignatureEnabled()
}

// PluginAssetBase 返回插件前端资源的 URL 前缀。
//
// 前端据此拼出插件 ESM 入口：<base><id>/<version>/frontend/index.js
func (a *App) PluginAssetBase() string {
	return "/plugins/"
}

// displayName 给安装输入挑一个人类可读的名字，用于错误提示。
func displayName(in plugin.PackageInputWire) string {
	for _, candidate := range []string{in.FileName, in.Ref, in.ID} {
		if strings.TrimSpace(candidate) != "" {
			return candidate
		}
	}
	return "插件包"
}
