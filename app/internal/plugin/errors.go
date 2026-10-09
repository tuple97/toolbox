package plugin

import "errors"

var (
	// ErrNotInstalled 插件未安装
	ErrNotInstalled = errors.New("插件未安装")
	// ErrDisabled 插件已被停用
	ErrDisabled = errors.New("插件已停用")
	// ErrNoRuntime 插件没有后端运行时
	ErrNoRuntime = errors.New("插件未声明后端运行时")
	// ErrHandlerNotFound 插件未注册指定 handler
	ErrHandlerNotFound = errors.New("插件未注册该处理方法")
	// ErrPermissionDenied 触发了未授予的权限
	ErrPermissionDenied = errors.New("插件缺少所需权限")
	// ErrIncompatible 宿主版本不满足插件要求
	ErrIncompatible = errors.New("插件与当前应用版本不兼容")
	// ErrUntrusted 插件未受信任
	ErrUntrusted = errors.New("插件未被信任")
	// ErrChecksumMismatch 下载内容校验和不匹配
	ErrChecksumMismatch = errors.New("插件包校验和不匹配")
	// ErrDependencyMissing 依赖缺失
	ErrDependencyMissing = errors.New("插件依赖缺失")
	// ErrDependencyConflict 依赖版本冲突
	ErrDependencyConflict = errors.New("插件依赖版本冲突")
	// ErrCircularDependency 存在循环依赖
	ErrCircularDependency = errors.New("插件之间存在循环依赖")
	// ErrInUse 插件被其它插件依赖，无法卸载
	ErrInUse = errors.New("插件被其它插件依赖")
)
