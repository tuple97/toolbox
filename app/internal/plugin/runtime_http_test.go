package plugin

import (
	"net/http"
	"testing"

	"github.com/dop251/goja"
)

/* TestHTTPResponseValueFieldNames 锁住响应对象暴露给插件的字段名 */
func TestHTTPResponseValueFieldNames(t *testing.T) {
	vm := goja.New()
	resp := &HTTPResponse{
		Status:    http.StatusOK,
		Headers:   map[string]string{"Content-Type": "image/png"},
		Body:      "aGVsbG8=",
		Truncated: false,
	}

	value := httpResponseValue(vm, resp)
	obj, ok := value.(*goja.Object)
	if !ok {
		t.Fatalf("响应应转成 JS 对象，实际 %v", value)
	}

	// 插件脚本里用的就是这几个小写字段，少一个都会静默取到 undefined
	for _, key := range []string{"status", "headers", "body", "truncated"} {
		if field := obj.Get(key); field == nil || goja.IsUndefined(field) || goja.IsNull(field) {
			t.Fatalf("插件需要通过 resp.%s 取值，实际取不到", key)
		}
	}

	if got := obj.Get("body").String(); got != "aGVsbG8=" {
		t.Fatalf("响应体未透传: %q", got)
	}
	if got := obj.Get("status").ToInteger(); got != http.StatusOK {
		t.Fatalf("状态码未透传: %d", got)
	}
	if got := obj.Get("headers").ToObject(vm).Get("Content-Type").String(); got != "image/png" {
		t.Fatalf("响应头未透传: %q", got)
	}
}
