package plugin

import "errors"

// 插件体系的错误分类。
//
// 每一类都是可判定的（errors.Is 可用），前端据此决定提示方式，
// 不需要去字符串里猜原因。
var (
	// ErrNotInstalled 插件未安装
	ErrNotInstalled = errors.New("插件未安装")
	// ErrDisabled 插件已被停用（用户未启用）
	ErrDisabled = errors.New("插件已停用")
	// ErrBlocked 插件因依赖或兼容性问题无法激活
	ErrBlocked = errors.New("插件当前不可用")
	// ErrNoRuntime 插件没有后端运行时
	ErrNoRuntime = errors.New("插件未声明后端运行时")
	// ErrHandlerNotFound 插件未注册指定 handler
	ErrHandlerNotFound = errors.New("插件未注册该处理方法")
	// ErrPermissionDenied 触发了未授予的权限
	ErrPermissionDenied = errors.New("插件缺少所需权限")
	// ErrIncompatible 宿主或插件 API 版本不满足插件要求
	ErrIncompatible = errors.New("插件与当前应用版本不兼容")
	// ErrUntrusted 插件未受信任
	ErrUntrusted = errors.New("插件未被信任")
	// ErrChecksumMismatch 内容摘要不匹配
	ErrChecksumMismatch = errors.New("插件包校验和不匹配")
	// ErrDependencyMissing 依赖缺失
	ErrDependencyMissing = errors.New("插件依赖缺失")
	// ErrDependencyConflict 依赖版本冲突
	ErrDependencyConflict = errors.New("插件依赖版本冲突")
	// ErrCircularDependency 存在循环依赖
	ErrCircularDependency = errors.New("插件之间存在循环依赖")
	// ErrDowngrade 解析结果会静默降级已安装插件
	ErrDowngrade = errors.New("不允许静默降级已安装插件")
	// ErrInUse 插件被其它插件依赖，无法卸载或停用
	ErrInUse = errors.New("插件被其它插件依赖")
	// ErrPlanExpired 安装计划不存在或已失效
	ErrPlanExpired = errors.New("安装计划已失效，请重新预览")
	// ErrInvalidPackage 安装包内容非法
	ErrInvalidPackage = errors.New("插件包内容非法")
	// ErrSourceUnavailable 来源不可用（网络、文件缺失等）
	ErrSourceUnavailable = errors.New("插件来源不可用")
	// ErrNotExported 目标插件没有公开该 handler
	ErrNotExported = errors.New("目标插件未公开该处理方法")
)
