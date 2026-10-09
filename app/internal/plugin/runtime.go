package plugin

import (
	"context"
	"encoding/json"
	"fmt"
)

// Runtime 插件后端运行时抽象。
//
// 当前实现为 goja（JavaScript），并预留 wazero（WebAssembly）。
// 上层（Manager）只依赖这个接口，因此新增运行时不需要改动调用方。
type Runtime interface {
	// Start 加载插件入口并完成初始化。
	// host 提供受权限约束的宿主能力，source 为入口脚本/模块的原始内容。
	Start(ctx context.Context, host *HostBridge, source []byte) error
	// Call 调用插件注册的 handler，参数与返回值均为 JSON。
	Call(ctx context.Context, handler string, args json.RawMessage) (json.RawMessage, error)
	// Handlers 返回插件已注册的 handler 名。
	Handlers() []string
	// Close 释放运行时资源。
	Close() error
}

// RuntimeFactory 按后端类型创建运行时；未支持的类型返回错误。
type RuntimeFactory func(kind BackendKind) (Runtime, error)

// defaultRuntimeFactory 内置的运行时工厂。
//
// 目前只提供 JS；WASM 位点保留在 switch 中，
// 落地时只需补上 newWASMRuntime 即可，调用方无需改动。
func defaultRuntimeFactory(kind BackendKind) (Runtime, error) {
	switch kind {
	case BackendJS:
		return newJSRuntime(), nil
	case BackendWASM:
		return nil, fmt.Errorf("WebAssembly 运行时尚未启用（插件请使用 runtime.backend = \"js\"）")
	case BackendNone:
		return nil, ErrNoRuntime
	default:
		return nil, fmt.Errorf("未知的插件后端运行时: %q", kind)
	}
}
