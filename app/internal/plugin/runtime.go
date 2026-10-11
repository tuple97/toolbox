package plugin

import (
	"context"
	"encoding/json"
	"fmt"
)

// Runtime 插件后端运行时抽象。
//
// 当前实现为 goja（JavaScript）。上层（Manager）只依赖这个接口，
// 新增运行时不需要改动调用方。协议里没有落地的运行时不会被声明，
// 因此不存在「清单允许、运行时报含糊错误」的情况。
type Runtime interface {
	// Start 加载插件入口并完成初始化。
	// host 提供受权限约束的宿主能力，source 为入口脚本的原始内容。
	Start(ctx context.Context, host *HostBridge, source []byte) error
	// Call 调用插件注册的 handler，参数与返回值均为 JSON。
	Call(ctx context.Context, handler string, args json.RawMessage) (json.RawMessage, error)
	// Handlers 返回插件已注册的 handler 名。
	Handlers() []string
	// Close 释放运行时资源；关闭后不再接受调用。
	Close() error
}

// RuntimeFactory 按运行时声明创建实例；未支持的类型返回错误。
type RuntimeFactory func(spec RuntimeSpec) (Runtime, error)

// CallTrace 记录「当前调用栈上正在执行哪些插件」。
//
// 为什么需要它：goja 的 Runtime 不是并发安全的，所以每次执行都要加锁串行化。
// 但插件之间可以互相调用（A→B→A），同一次调用栈上再次进入某个插件时，
// 它的锁已经被这一条栈持有了 —— 直接再加一次就是自己把自己锁死。
// 用调用栈追踪把「已在本栈中执行」与「外部并发调用」区分开：
// 前者直接重入，后者老老实实排队。
type CallTrace struct {
	depth map[string]int
}

// NewCallTrace 创建一条调用栈追踪。
func NewCallTrace() *CallTrace {
	return &CallTrace{depth: make(map[string]int)}
}

// Enter 标记插件进入执行；返回它此前是否已在本栈中。
func (t *CallTrace) Enter(pluginID string) bool {
	if t == nil {
		return false
	}
	already := t.depth[pluginID] > 0
	t.depth[pluginID]++
	return already
}

// Exit 标记插件退出执行。
func (t *CallTrace) Exit(pluginID string) {
	if t == nil {
		return
	}
	if t.depth[pluginID] <= 1 {
		delete(t.depth, pluginID)
		return
	}
	t.depth[pluginID]--
}

// callTraceKey 调用栈追踪在 context 中的键。
type callTraceKey struct{}

// WithCallTrace 把调用栈追踪放进 context。
func WithCallTrace(ctx context.Context, trace *CallTrace) context.Context {
	return context.WithValue(ctx, callTraceKey{}, trace)
}

// CallTraceFrom 取出 context 中的调用栈追踪（可能为 nil）。
func CallTraceFrom(ctx context.Context) *CallTrace {
	if ctx == nil {
		return nil
	}
	trace, _ := ctx.Value(callTraceKey{}).(*CallTrace)
	return trace
}

// defaultRuntimeFactory 内置的运行时工厂。
func defaultRuntimeFactory(spec RuntimeSpec) (Runtime, error) {
	kind, err := spec.Kind()
	if err != nil {
		return nil, err
	}
	switch kind {
	case BackendJS:
		return newJSRuntime(), nil
	case BackendNone:
		return nil, ErrNoRuntime
	default:
		return nil, fmt.Errorf("未知的插件后端运行时: %q", kind)
	}
}
