package plugin

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 本地服务的边界。
//
// 插件是不可信代码：它只能绑回环地址、只能用白名单端口、请求体与日志量都有上限，
// 否则一个插件就能把宿主的端口占满或把内存吃光。
const (
	// maxLocalRequestBody 单次请求体最大字节数（1 MiB）
	maxLocalRequestBody = 1 << 20
	// maxLocalServerLogs 内存中保留的访问日志条数
	maxLocalServerLogs = 500
	// localServerReadTimeout 读取请求的超时
	localServerReadTimeout = 15 * time.Second
)

// LocalRequest 转发给插件 JS 的请求描述（都是普通字符串，便于 JSON 序列化）。
type LocalRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// LocalResponse 插件 JS 返回的响应描述。
type LocalResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// ServerLogEntry 一条本地服务访问日志（供插件界面实时展示）。
type ServerLogEntry struct {
	ID         int64  `json:"id"`
	At         string `json:"at"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	DurationMS int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

// LocalServer 插件自带的本地 HTTP 服务。
//
// 生命周期完全由插件控制（toolbox.server.start / stop），但真正监听什么、
// 能开在哪个端口由宿主按清单权限裁决 —— 这是「插件能对外提供服务」与
// 「插件不能随便占端口」之间的折中。
type LocalServer struct {
	pluginID string
	handler  func(LocalRequest) (LocalResponse, error)

	mu     sync.Mutex
	srv    *http.Server
	ln     net.Listener
	port   int
	logs   []ServerLogEntry
	nextID int64
}

// NewLocalServer 创建一个尚未监听的本地服务。
func NewLocalServer(pluginID string, handler func(LocalRequest) (LocalResponse, error)) *LocalServer {
	return &LocalServer{pluginID: pluginID, handler: handler}
}

// Start 在 127.0.0.1 上监听指定端口；port 为 0 时由系统分配。
// 返回实际监听的端口。
func (s *LocalServer) Start(port int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil {
		return s.port, nil
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return 0, fmt.Errorf("监听端口失败: %w", err)
	}
	actual := ln.Addr().(*net.TCPAddr).Port

	srv := &http.Server{
		Handler:           http.HandlerFunc(s.serveHTTP),
		ReadHeaderTimeout: localServerReadTimeout,
	}
	s.ln = ln
	s.srv = srv
	s.port = actual

	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			s.appendLog(ServerLogEntry{Error: "服务异常退出: " + err.Error()})
		}
	}()
	return actual, nil
}

// Stop 关闭本地服务。
//
// 用 Close 而不是 Shutdown：Stop 可能由「正在处理请求的插件自己」调用，
// Shutdown 会等当前请求结束，等于等自己，必然死锁。
func (s *LocalServer) Stop() {
	s.mu.Lock()
	srv := s.srv
	s.srv = nil
	s.ln = nil
	s.port = 0
	s.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
}

// Status 返回是否在监听与实际端口。
func (s *LocalServer) Status() (bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.srv != nil, s.port
}

// Logs 返回 id 大于 since 的日志（最多 maxLocalServerLogs 条）。
func (s *LocalServer) Logs(since int64) []ServerLogEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ServerLogEntry, 0, len(s.logs))
	for _, entry := range s.logs {
		if entry.ID > since {
			out = append(out, entry)
		}
	}
	return out
}

// serveHTTP 把一条真实请求转交给插件处理。
func (s *LocalServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	body, err := io.ReadAll(io.LimitReader(r.Body, maxLocalRequestBody))
	if err != nil {
		http.Error(w, "读取请求失败", http.StatusBadRequest)
		s.appendLog(ServerLogEntry{
			Method: r.Method, Path: r.URL.Path, Status: http.StatusBadRequest,
			DurationMS: time.Since(started).Milliseconds(), Error: err.Error(),
		})
		return
	}

	headers := make(map[string]string, len(r.Header))
	for k := range r.Header {
		headers[k] = r.Header.Get(k)
	}

	resp, handleErr := s.handler(LocalRequest{
		Method:  r.Method,
		Path:    r.URL.Path,
		Query:   r.URL.RawQuery,
		Headers: headers,
		Body:    strings.TrimSpace(string(body)),
	})

	if handleErr != nil {
		http.Error(w, "插件处理失败: "+handleErr.Error(), http.StatusInternalServerError)
		s.appendLog(ServerLogEntry{
			Method: r.Method, Path: r.URL.Path, Status: http.StatusInternalServerError,
			DurationMS: time.Since(started).Milliseconds(), Error: handleErr.Error(),
		})
		return
	}

	status := resp.Status
	if status == 0 {
		status = http.StatusOK
	}
	for k, v := range resp.Headers {
		w.Header().Set(k, v)
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, resp.Body)

	s.appendLog(ServerLogEntry{
		Method: r.Method, Path: r.URL.Path, Status: status,
		DurationMS: time.Since(started).Milliseconds(),
	})
}

// appendLog 写入一条访问日志，超出上限时丢弃最旧的。
func (s *LocalServer) appendLog(entry ServerLogEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	entry.ID = s.nextID
	if entry.At == "" {
		entry.At = time.Now().Format(time.RFC3339)
	}
	s.logs = append(s.logs, entry)
	if len(s.logs) > maxLocalServerLogs {
		s.logs = s.logs[len(s.logs)-maxLocalServerLogs:]
	}
}
