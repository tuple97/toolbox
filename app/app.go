// Package app 承载应用生命周期，向前端暴露可绑定的方法
package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/app/internal/database"
	"toolbox/app/internal/plugin"
	"toolbox/app/internal/script"
	"toolbox/app/internal/services"
	"toolbox/app/internal/update"
	"toolbox/app/internal/utils"
)

// 应用启动状态
const (
	// startupInitializing 初始化尚未完成
	startupInitializing = "initializing"
	// startupReady 初始化完成，全部功能可用
	startupReady = "ready"
	// startupDegraded 初始化失败：本地数据相关功能不可用，界面与更新能力仍在
	startupDegraded = "degraded"
)

// AppStartupState 应用启动状态。
//
// degraded 表示初始化失败（例如数据库损坏）：界面照常打开并显示原因，
// 用户可重试初始化，也能靠应用内更新拉一个修复版本——所以这里不用
// 「启动失败直接退出」的语义。
type AppStartupState struct {
	// State initializing / ready / degraded
	State string `json:"state"`
	// Error 初始化失败原因（degraded 时非空）
	Error string `json:"error"`
}

// App 是绑定到前端的根结构体
type App struct {
	wailsApp   *application.App
	mainWindow *application.WebviewWindow

	// 更新服务（NewApp 创建、SetupUpdate 接线；更新是应用级能力，不属于业务服务）
	updateCtrl *update.Controller

	// 基础设施
	db     *database.DB
	cipher *utils.Cipher
	engine *script.Engine

	// 业务服务
	tabs      *services.TabService
	templates *services.TemplateService
	dicts     *services.DictService
	dbService *services.DBService
	settings  *services.SettingService

	// 插件体系（可选能力：未初始化时相关绑定返回明确错误，不影响其它功能）
	plugins *plugin.Manager

	// 启动状态（可能被并发读取）
	stateMu  sync.Mutex
	state    string
	stateErr string
}

// NewApp 创建 App 实例。
//
// 更新控制器在这里创建、由 SetupUpdate 接线（装配入口在 main.go），
// App 只负责把它暴露给前端。
func NewApp() *App {
	return &App{
		updateCtrl: update.New(Version),
		state:      startupInitializing,
	}
}

// Attach 注入 Wails 应用实例
func (a *App) Attach(wailsApp *application.App) {
	a.wailsApp = wailsApp
}

// AttachWindow 注入主窗口引用
func (a *App) AttachWindow(window *application.WebviewWindow) {
	a.mainWindow = window
}

// ServiceStartup 在应用启动时被调用
func (a *App) ServiceStartup(_ context.Context, _ application.ServiceOptions) error {
	if err := a.init(); err != nil {
		slog.Error("应用初始化失败", "error", err)
		a.setStartupState(startupDegraded, err.Error())
		if a.wailsApp != nil {
			a.wailsApp.Event.Emit("app:init-error", err.Error())
		}
		// 刻意不返回错误：打包版是 GUI 子系统（没有控制台），返回错误只会
		// 变成「双击没反应」。状态通过 GetAppStartupState 暴露，前端给出
		// 可见的错误说明与「重试初始化」入口。
		return nil
	}
	a.setStartupState(startupReady, "")
	slog.Info("应用初始化完成")
	return nil
}

// ServiceShutdown 在应用退出时被调用
func (a *App) ServiceShutdown() error {
	if a.plugins != nil {
		if err := a.plugins.Close(); err != nil {
			slog.Error("关闭插件运行时失败", "error", err)
		}
	}
	if a.db != nil {
		if err := a.db.Close(); err != nil {
			slog.Error("关闭数据库失败", "error", err)
		}
	}
	slog.Info("应用已退出")
	return nil
}

// NotifyBeforeQuit 通知前端保存当前状态
func (a *App) NotifyBeforeQuit() {
	if a.wailsApp == nil {
		return
	}
	a.wailsApp.Event.Emit("app:before-quit")
}

// GetAppStartupState 应用启动状态（degraded 时前端展示原因与重试入口）。
func (a *App) GetAppStartupState() AppStartupState {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	return AppStartupState{State: a.state, Error: a.stateErr}
}

// RetryInit 重新执行初始化。
//
// 用于数据库损坏、目录权限异常等情况下的自救：成功后本地数据功能恢复，
// 失败则把新的原因回给前端。已经初始化成功时直接返回当前状态（不重复打开数据库）。
func (a *App) RetryInit() AppStartupState {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()

	// db 已打开即说明上一次初始化已经走完（后续步骤不会失败）
	if a.db != nil || a.state == startupReady {
		a.state = startupReady
		a.stateErr = ""
		return AppStartupState{State: a.state}
	}

	if err := a.init(); err != nil {
		slog.Error("应用重新初始化失败", "error", err)
		a.state = startupDegraded
		a.stateErr = err.Error()
		return AppStartupState{State: a.state, Error: a.stateErr}
	}
	a.state = startupReady
	a.stateErr = ""
	slog.Info("应用重新初始化完成")
	return AppStartupState{State: a.state}
}

// setStartupState 记录启动状态
func (a *App) setStartupState(state, errMsg string) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.state = state
	a.stateErr = errMsg
}

// init 完成各项依赖的装配
func (a *App) init() error {
	dataDir, err := resolveDataDir()
	if err != nil {
		return err
	}

	cipher, err := utils.NewCipher(dataDir, resolveKeyDir())
	if err != nil {
		return fmt.Errorf("初始化加密器失败: %w", err)
	}
	a.cipher = cipher

	db, err := database.Open(dataDir)
	if err != nil {
		return fmt.Errorf("初始化数据库失败: %w", err)
	}
	a.db = db

	repo := database.NewRepository(db)
	engine := script.NewEngine()
	a.engine = engine

	a.tabs = services.NewTabService(repo)
	a.templates = services.NewTemplateService(repo, engine)
	a.dicts = services.NewDictService(repo)
	a.dbService = services.NewDBService(repo, cipher, engine)
	a.settings = services.NewSettingService(repo)

	// 插件体系：装配后立即加载一次已启用的插件。
	// 加载失败只记为日志——插件是可选能力，不应拖垮启动。
	a.setupPlugins(repo, dataDir)
	if a.plugins != nil {
		if loadErr := a.plugins.Reload(context.Background()); loadErr != nil {
			slog.Error("加载插件失败", "error", loadErr)
		}
	}

	return nil
}

// resolveDataDir 返回数据目录
func resolveDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		// 退回到可执行文件同级目录
		exe, exeErr := os.Executable()
		if exeErr != nil {
			return "", fmt.Errorf("无法确定数据目录: %w", err)
		}
		base = filepath.Dir(exe)
	}
	return filepath.Join(base, "Toolbox"), nil
}

// resolveKeyDir 返回主密钥的回退目录
func resolveKeyDir() string {
	if base, err := os.UserCacheDir(); err == nil {
		return filepath.Join(base, "Toolbox")
	}
	return ""
}

// Greet 返回一句问候语
func (a *App) Greet(name string) string {
	slog.Info("Greet 被调用", "name", name)
	return fmt.Sprintf("Hello %s, It's show time!", name)
}

// ready 检查服务是否已初始化
func (a *App) ready() error {
	if a.dbService == nil || a.tabs == nil || a.settings == nil {
		return fmt.Errorf("应用尚未初始化完成，请稍后重试")
	}
	return nil
}
