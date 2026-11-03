package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
)

// 插件后端脚本的执行上限：插件是不可信代码，必须有硬性的时间边界。
const (
	// jsInitTimeout 入口脚本初始化超时
	jsInitTimeout = 5 * time.Second
	// jsCallTimeout 单次 handler 调用超时
	jsCallTimeout = 15 * time.Second
	// maxRegisteredHandlers 单插件可注册的 handler 上限
	maxRegisteredHandlers = 128
)

// jsRuntime 基于 goja 的插件后端运行时。
//
// goja 的 Runtime 不是并发安全的，因此所有对外调用都用互斥锁串行化：
// 同一插件的 handler 不会并发执行，插件作者无需自行处理竞态。
type jsRuntime struct {
	mu sync.Mutex

	vm       *goja.Runtime
	handlers map[string]goja.Callable
	host     *HostBridge
	closed   bool
	// onRequest 本地服务的请求处理器（toolbox.server.onRequest 注册）
	onRequest goja.Callable
}

// newJSRuntime 创建空运行时，实际加载在 Start 中完成。
func newJSRuntime() *jsRuntime {
	return &jsRuntime{handlers: make(map[string]goja.Callable)}
}

// Start 注入宿主 API 并执行插件入口脚本。
func (r *jsRuntime) Start(_ context.Context, host *HostBridge, source []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.closed {
		return fmt.Errorf("插件运行时已关闭")
	}
	if len(source) == 0 {
		return fmt.Errorf("插件后端入口内容为空")
	}
	r.host = host
	r.onRequest = nil
	// 本地服务的请求要回到这个运行时里执行，先登记分发函数
	host.SetLocalHandler(r.serveLocal)

	vm := goja.New()
	r.vm = vm
	r.handlers = make(map[string]goja.Callable)

	if err := r.injectAPI(vm); err != nil {
		return err
	}

	// 看门狗：入口脚本死循环时中断执行
	stop := watchDog(vm, jsInitTimeout, "插件初始化超时")
	_, runErr := vm.RunScript(host.PluginID()+"/backend", string(source))
	stop()
	if runErr != nil {
		return fmt.Errorf("执行插件入口脚本失败: %w", jsMessage(runErr))
	}
	return nil
}

/* jsMessage 把 goja 抛出的异常还原成「脚本里写的那句话」 */
func jsMessage(err error) error {
	exception, ok := err.(*goja.Exception)
	if !ok {
		return err
	}

	text := ""
	if value := exception.Value(); value != nil {
		text = strings.TrimSpace(value.String())
	}
	if text == "" {
		text = strings.TrimSpace(exception.Error())
	}
	text = strings.TrimSpace(stripJSErrorPrefix(text))
	if text == "" {
		// 反序列化不出任何文案时，退回原始错误，至少不丢失信息
		return err
	}
	return errors.New(text)
}

/* jsErrorPrefixes 需要剥掉的 JS 错误构造器前缀 */
var jsErrorPrefixes = []string{
	"GoError: ",
	"Error: ",
	"TypeError: ",
	"RangeError: ",
	"ReferenceError: ",
	"SyntaxError: ",
	"EvalError: ",
	"URIError: ",
}

// stripJSErrorPrefix 去掉 "Error:" / "TypeError:" 这类构造器前缀。
func stripJSErrorPrefix(text string) string {
	for _, prefix := range jsErrorPrefixes {
		if strings.HasPrefix(text, prefix) {
			// 只剥一层；文案本身若以同样的词开头就保留
			return strings.TrimSpace(strings.TrimPrefix(text, prefix))
		}
	}
	// 光秃秃的构造器名（"Error" / "TypeError"，没有消息）视为空文案
	bare := strings.TrimSpace(strings.TrimSuffix(text, ":"))
	if bare == "" {
		return ""
	}
	for _, prefix := range jsErrorPrefixes {
		if strings.TrimSuffix(strings.TrimSpace(prefix), ":") == bare {
			return ""
		}
	}
	return text
}

// Call 调用插件注册的 handler。
//
// 并发安全：goja 的 Runtime 只能串行使用，因此外部并发调用会排队。
// 但同一条调用栈上的重入（A→B→A）不能再次加锁，否则会自己锁死自己，
// 这里用 context 中的调用栈追踪区分这两种情况。
func (r *jsRuntime) Call(ctx context.Context, handler string, args json.RawMessage) (json.RawMessage, error) {
	pluginID := ""
	trace := CallTraceFrom(ctx)
	if r.host != nil {
		pluginID = r.host.PluginID()
	}

	// 已有调用栈且本插件已在其上：直接重入，不再加锁（否则自己锁死自己）
	reentrant := false
	if trace != nil && pluginID != "" {
		reentrant = trace.Enter(pluginID)
		defer trace.Exit(pluginID)
	}
	if !reentrant {
		r.mu.Lock()
		defer r.mu.Unlock()
	}

	if r.closed {
		return nil, fmt.Errorf("插件运行时已关闭")
	}
	fn, ok := r.handlers[handler]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrHandlerNotFound, handler)
	}

	var payload any
	if len(args) > 0 {
		if err := json.Unmarshal(args, &payload); err != nil {
			return nil, fmt.Errorf("handler %s 的参数不是合法 JSON: %w", handler, err)
		}
	}
	if payload == nil {
		payload = map[string]any{}
	}

	// 让插件内部的 toolbox.plugins.call 能带上当前调用栈。
	// 用「保存-恢复」而不是置空：嵌套重入时外层执行还要继续用到它。
	if r.host != nil {
		previous := r.host.currentTrace()
		r.host.setCallTrace(trace)
		defer r.host.setCallTrace(previous)
	}

	stop := watchDog(r.vm, jsCallTimeout, "插件处理超时")
	value, err := fn(goja.Undefined(), r.vm.ToValue(payload))
	stop()
	if err != nil {
		/* 插件抛出的异常就是它想给用户看的那句话，不要再包一层 「插件 handler xxx 执行失败」——handler 名是 */
		return nil, jsMessage(err)
	}

	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return json.RawMessage("null"), nil
	}
	encoded, err := json.Marshal(value.Export())
	if err != nil {
		return nil, fmt.Errorf("插件 handler %s 的返回值无法序列化: %w", handler, err)
	}
	return encoded, nil
}

// Handlers 返回已注册的 handler 名。
func (r *jsRuntime) Handlers() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make([]string, 0, len(r.handlers))
	for name := range r.handlers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Close 释放运行时。
//
// 一并关掉插件自带的本地服务：插件被停用/卸载后端口不能继续被占着。
func (r *jsRuntime) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	r.handlers = make(map[string]goja.Callable)
	r.onRequest = nil
	r.vm = nil
	if r.host != nil {
		r.host.StopLocalServer()
	}
	return nil
}

// serveLocal 把本地服务收到的一条请求交给插件 JS 处理。
//
// 与 handler 调用共用同一把锁：goja 运行时不能并发使用，
// 因此本地请求会和前端调用排队执行（这类服务的流量本来就很小）。
func (r *jsRuntime) serveLocal(req LocalRequest) (LocalResponse, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.closed || r.vm == nil || r.onRequest == nil {
		return LocalResponse{Status: 503, Body: `{"error":"插件未注册请求处理器"}`}, nil
	}

	stop := watchDog(r.vm, jsCallTimeout, "插件处理本地请求超时")
	value, err := r.onRequest(goja.Undefined(), toJSONValue(r.vm, req))
	stop()
	if err != nil {
		return LocalResponse{}, fmt.Errorf("插件处理请求失败: %w", err)
	}
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return LocalResponse{Status: 204}, nil
	}

	encoded, err := json.Marshal(value.Export())
	if err != nil {
		return LocalResponse{}, fmt.Errorf("插件返回的响应无法序列化: %w", err)
	}
	var resp LocalResponse
	if err := json.Unmarshal(encoded, &resp); err != nil {
		return LocalResponse{}, fmt.Errorf("插件返回的响应字段非法: %w", err)
	}
	return resp, nil
}

// injectAPI 把 toolbox 全局对象注入运行时作用域。
func (r *jsRuntime) injectAPI(vm *goja.Runtime) error {
	toolbox := vm.NewObject()

	// 基本信息
	meta := vm.NewObject()
	_ = meta.Set("id", r.host.PluginID())
	_ = meta.Set("version", r.host.PluginVersion())
	_ = meta.Set("appVersion", r.host.AppVersion())
	_ = toolbox.Set("plugin", meta)

	// handler 注册
	_ = toolbox.Set("handler", func(call goja.FunctionCall) goja.Value {
		name := strings.TrimSpace(call.Argument(0).String())
		if name == "" {
			panic(vm.NewTypeError("toolbox.handler 需要提供 handler 名称"))
		}
		if len(r.handlers) >= maxRegisteredHandlers {
			panic(vm.NewTypeError(fmt.Sprintf("注册的 handler 过多（> %d）", maxRegisteredHandlers)))
		}
		fn, ok := goja.AssertFunction(call.Argument(1))
		if !ok {
			panic(vm.NewTypeError("toolbox.handler 的第二个参数必须是函数"))
		}
		r.handlers[name] = fn
		return goja.Undefined()
	})

	// 日志
	logFn := func(call goja.FunctionCall) goja.Value {
		parts := make([]string, 0, len(call.Arguments))
		for _, arg := range call.Arguments {
			parts = append(parts, exportJSString(arg))
		}
		r.host.Log("info", strings.Join(parts, " "))
		return goja.Undefined()
	}
	_ = toolbox.Set("log", logFn)
	console := vm.NewObject()
	for _, name := range []string{"log", "info", "warn", "error", "debug"} {
		_ = console.Set(name, logFn)
	}
	_ = vm.Set("console", console)

	// 存储
	storage := vm.NewObject()
	_ = storage.Set("get", func(call goja.FunctionCall) goja.Value {
		value, _, err := r.host.GetSetting(call.Argument(0).String())
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(value)
	})
	_ = storage.Set("set", func(call goja.FunctionCall) goja.Value {
		if err := r.host.SetSetting(call.Argument(0).String(), call.Argument(1).String()); err != nil {
			panic(vm.NewGoError(err))
		}
		return goja.Undefined()
	})
	_ = storage.Set("delete", func(call goja.FunctionCall) goja.Value {
		if err := r.host.DeleteSetting(call.Argument(0).String()); err != nil {
			panic(vm.NewGoError(err))
		}
		return goja.Undefined()
	})
	_ = storage.Set("all", func(goja.FunctionCall) goja.Value {
		all, err := r.host.AllSettings()
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(all)
	})
	_ = toolbox.Set("storage", storage)

	// HTTP
	httpObj := vm.NewObject()
	_ = httpObj.Set("request", func(call goja.FunctionCall) goja.Value {
		req, convErr := decodeHTTPRequest(vm, call.Argument(0))
		if convErr != nil {
			panic(vm.NewTypeError(convErr.Error()))
		}
		resp, err := r.host.HTTPFetch(req)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		/* 响应按 json tag 手工拼，不能用 vm.ToValue： goja 默认把 Go 的字段名原样带进 JS（Sta */
		return httpResponseValue(vm, resp)
	})
	_ = toolbox.Set("http", httpObj)

	// 事件
	events := vm.NewObject()
	_ = events.Set("emit", func(call goja.FunctionCall) goja.Value {
		name := strings.TrimSpace(call.Argument(0).String())
		if name == "" {
			panic(vm.NewTypeError("toolbox.events.emit 需要事件名"))
		}
		var payload any
		if arg := call.Argument(1); arg != nil && !goja.IsUndefined(arg) {
			payload = arg.Export()
		}
		if err := r.host.EmitEvent(name, payload); err != nil {
			panic(vm.NewGoError(err))
		}
		return goja.Undefined()
	})
	_ = toolbox.Set("events", events)

	// 插件间调用
	plugins := vm.NewObject()
	_ = plugins.Set("call", func(call goja.FunctionCall) goja.Value {
		id := strings.TrimSpace(call.Argument(0).String())
		handler := strings.TrimSpace(call.Argument(1).String())
		var args json.RawMessage
		if arg := call.Argument(2); arg != nil && !goja.IsUndefined(arg) && !goja.IsNull(arg) {
			encoded, err := json.Marshal(arg.Export())
			if err != nil {
				panic(vm.NewGoError(fmt.Errorf("参数无法序列化: %w", err)))
			}
			args = encoded
		}
		result, err := r.host.CallPlugin(id, handler, args)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		if len(result) == 0 {
			return goja.Undefined()
		}
		var decoded any
		if err := json.Unmarshal(result, &decoded); err != nil {
			return vm.ToValue(string(result))
		}
		return vm.ToValue(decoded)
	})
	_ = plugins.Set("list", func(goja.FunctionCall) goja.Value {
		return vm.ToValue(r.host.Plugins())
	})
	_ = toolbox.Set("plugins", plugins)

	// 本地服务（只绑回环，端口受清单权限约束）
	server := vm.NewObject()
	_ = server.Set("onRequest", func(call goja.FunctionCall) goja.Value {
		fn, ok := goja.AssertFunction(call.Argument(0))
		if !ok {
			panic(vm.NewTypeError("toolbox.server.onRequest 需要一个函数"))
		}
		r.onRequest = fn
		return goja.Undefined()
	})
	_ = server.Set("start", func(call goja.FunctionCall) goja.Value {
		port := 0
		if arg := call.Argument(0); arg != nil && !goja.IsUndefined(arg) && !goja.IsNull(arg) {
			port = int(arg.ToInteger())
		}
		actual, err := r.host.StartLocalServer(port)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		result := vm.NewObject()
		_ = result.Set("port", actual)
		return result
	})
	_ = server.Set("stop", func(goja.FunctionCall) goja.Value {
		r.host.StopLocalServer()
		return goja.Undefined()
	})
	_ = server.Set("status", func(goja.FunctionCall) goja.Value {
		running, port := r.host.LocalServerStatus()
		result := vm.NewObject()
		_ = result.Set("running", running)
		_ = result.Set("port", port)
		return result
	})
	_ = server.Set("logs", func(call goja.FunctionCall) goja.Value {
		var since int64
		if arg := call.Argument(0); arg != nil {
			if obj, ok := arg.(*goja.Object); ok {
				if v := obj.Get("since"); v != nil && !goja.IsUndefined(v) && !goja.IsNull(v) {
					since = v.ToInteger()
				}
			}
		}
		return toJSONValue(vm, r.host.LocalServerLogs(since))
	})
	_ = toolbox.Set("server", server)

	// 签名（只暴露「用私钥签一段数据」，不做通用加解密）
	crypto := vm.NewObject()
	_ = crypto.Set("sign", func(call goja.FunctionCall) goja.Value {
		arg := call.Argument(0)
		if arg == nil || goja.IsUndefined(arg) || goja.IsNull(arg) {
			panic(vm.NewTypeError("toolbox.crypto.sign 需要一个参数对象"))
		}
		var params struct {
			Algorithm string `json:"algorithm"`
			Key       string `json:"key"`
			Data      string `json:"data"`
			Encoding  string `json:"encoding"`
		}
		encoded, err := json.Marshal(arg.Export())
		if err != nil {
			panic(vm.NewGoError(fmt.Errorf("参数无法序列化: %w", err)))
		}
		if err := json.Unmarshal(encoded, &params); err != nil {
			panic(vm.NewTypeError("参数字段非法: " + err.Error()))
		}
		output, err := SignWithPrivateKey(params.Algorithm, params.Key, params.Data, params.Encoding)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(output)
	})
	_ = crypto.Set("encrypt", func(call goja.FunctionCall) goja.Value {
		arg := call.Argument(0)
		if arg == nil || goja.IsUndefined(arg) || goja.IsNull(arg) {
			panic(vm.NewTypeError("toolbox.crypto.encrypt 需要一个参数对象"))
		}
		var params struct {
			Key  string `json:"key"`
			Data string `json:"data"`
		}
		encoded, err := json.Marshal(arg.Export())
		if err != nil {
			panic(vm.NewGoError(fmt.Errorf("参数无法序列化: %w", err)))
		}
		if err := json.Unmarshal(encoded, &params); err != nil {
			panic(vm.NewTypeError("参数字段非法: " + err.Error()))
		}
		output, err := EncryptWithPublicKey(params.Key, params.Data)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(output)
	})
	// 文件：只能碰清单 permissions.files 里声明的目录；
	// 写入另有 writeAs（目标路径必须来自系统的保存对话框）
	fsObj := vm.NewObject()
	_ = fsObj.Set("readText", func(call goja.FunctionCall) goja.Value {
		text, err := r.host.ReadTextFile(call.Argument(0).String())
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(text)
	})
	_ = fsObj.Set("exists", func(call goja.FunctionCall) goja.Value {
		return vm.ToValue(r.host.FileExists(call.Argument(0).String()))
	})
	_ = fsObj.Set("list", func(call goja.FunctionCall) goja.Value {
		names, err := r.host.ListDir(call.Argument(0).String())
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(names)
	})
	_ = fsObj.Set("writeText", func(call goja.FunctionCall) goja.Value {
		path := call.Argument(0).String()
		fileName := call.Argument(1).String()
		content := call.Argument(2).String()
		written, err := r.host.WriteTextFile(path, fileName, content)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		return vm.ToValue(written)
	})
	_ = fsObj.Set("saveText", func(call goja.FunctionCall) goja.Value {
		var params struct {
			Title    string       `json:"title"`
			FileName string       `json:"fileName"`
			Content  string       `json:"content"`
			Filters  []FileFilter `json:"filters"`
		}
		arg := call.Argument(0)
		if arg == nil || goja.IsUndefined(arg) || goja.IsNull(arg) {
			panic(vm.NewTypeError("toolbox.fs.saveText 需要一个参数对象"))
		}
		encoded, err := json.Marshal(arg.Export())
		if err != nil {
			panic(vm.NewGoError(fmt.Errorf("参数无法序列化: %w", err)))
		}
		if err := json.Unmarshal(encoded, &params); err != nil {
			panic(vm.NewTypeError("参数字段非法: " + err.Error()))
		}
		if strings.TrimSpace(params.Content) == "" {
			panic(vm.NewTypeError("toolbox.fs.saveText 需要提供 content"))
		}
		written, err := r.host.SaveTextFile(params.Title, params.FileName, params.Content, params.Filters)
		if err != nil {
			panic(vm.NewGoError(err))
		}
		// 用户取消时返回空串：插件据此静默收场，不当成失败
		result := vm.NewObject()
		_ = result.Set("path", written)
		_ = result.Set("cancelled", written == "")
		return result
	})
	_ = toolbox.Set("fs", fsObj)

	_ = toolbox.Set("crypto", crypto)

	// MCP 工具运行时注册（P3 阶段消费；先收集，未启用时不影响插件）
	mcp := vm.NewObject()
	_ = mcp.Set("registerTool", func(call goja.FunctionCall) goja.Value {
		// 运行时注册是 P3 能力，当前仅做参数校验并忽略，
		// 保持插件代码前向兼容：声明式 contributes.mcp 是推荐路径。
		return goja.Undefined()
	})
	_ = toolbox.Set("mcp", mcp)

	return vm.Set("toolbox", toolbox)
}

// decodeHTTPRequest 把 JS 对象转成 HTTPRequest。
// httpResponseValue 把 HTTP 响应转成按 json tag 命名的 JS 对象。
//
// 与 toolbox.server 的返回保持一致：字段名必须是 json tag 里的小写形式，
// 否则插件里按 resp.status / resp.body 取值拿到的是 undefined，
// 状态码判断会整段落空。
func httpResponseValue(vm *goja.Runtime, resp *HTTPResponse) goja.Value {
	obj := vm.NewObject()
	_ = obj.Set("status", resp.Status)

	headers := vm.NewObject()
	for key, value := range resp.Headers {
		_ = headers.Set(key, value)
	}
	_ = obj.Set("headers", headers)

	_ = obj.Set("body", resp.Body)
	_ = obj.Set("truncated", resp.Truncated)
	return obj
}

func decodeHTTPRequest(vm *goja.Runtime, value goja.Value) (HTTPRequest, error) {
	var req HTTPRequest
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return req, fmt.Errorf("toolbox.http.request 需要一个请求对象")
	}
	encoded, err := json.Marshal(value.Export())
	if err != nil {
		return req, fmt.Errorf("请求对象无法序列化: %w", err)
	}
	if err := json.Unmarshal(encoded, &req); err != nil {
		return req, fmt.Errorf("请求对象字段非法: %w", err)
	}
	if strings.TrimSpace(req.URL) == "" {
		return req, fmt.Errorf("请求缺少 url")
	}
	return req, nil
}

// watchDog 启动超时看门狗，返回停止函数。
func watchDog(vm *goja.Runtime, d time.Duration, message string) func() {
	timer := time.AfterFunc(d, func() {
		vm.Interrupt(message)
	})
	return func() {
		timer.Stop()
		// 清除中断标记，否则后续调用会立刻抛错
		vm.ClearInterrupt()
	}
}

// toJSONValue 把 Go 值转成按 json tag 命名的 JS 值。
//
// 直接 vm.ToValue 会暴露 Go 的字段名（Method / Path…），插件里就得写
// req.Method 这种大小写混杂的访问方式；走一遍 JSON 后与清单/文档一致。
func toJSONValue(vm *goja.Runtime, value any) goja.Value {
	encoded, err := json.Marshal(value)
	if err != nil {
		return goja.Undefined()
	}
	var generic any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		return goja.Undefined()
	}
	return vm.ToValue(generic)
}

// exportJSString 把 goja 值转成可读字符串。
func exportJSString(value goja.Value) string {
	if value == nil || goja.IsUndefined(value) || goja.IsNull(value) {
		return ""
	}
	switch v := value.Export().(type) {
	case string:
		return v
	case map[string]any, []any:
		encoded, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(encoded)
	default:
		return fmt.Sprintf("%v", v)
	}
}
