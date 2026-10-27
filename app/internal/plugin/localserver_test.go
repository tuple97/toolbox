package plugin

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"testing"
)

// TestLocalServerRoundTrip 本地服务能把请求交给插件并记录访问日志。
func TestLocalServerRoundTrip(t *testing.T) {
	var seen LocalRequest
	srv := NewLocalServer("com.test.srv", func(req LocalRequest) (LocalResponse, error) {
		seen = req
		return LocalResponse{
			Status:  http.StatusOK,
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    `{"ok":true}`,
		}, nil
	})

	port, err := srv.Start(0)
	if err != nil {
		t.Fatalf("启动本地服务失败: %v", err)
	}
	t.Cleanup(srv.Stop)

	resp, err := http.Post(
		fmt.Sprintf("http://127.0.0.1:%d/jrebel/leases?x=1", port),
		"application/json", io.NopCloser(&stringReader{s: `{"clientTime":"1"}`}))
	if err != nil {
		t.Fatalf("请求本地服务失败: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != `{"ok":true}` {
		t.Fatalf("响应不符合预期: %d %s", resp.StatusCode, body)
	}
	if seen.Path != "/jrebel/leases" || seen.Query != "x=1" || seen.Method != http.MethodPost {
		t.Fatalf("插件收到的请求不正确: %+v", seen)
	}
	if seen.Body != `{"clientTime":"1"}` {
		t.Fatalf("请求体未透传: %q", seen.Body)
	}

	logs := srv.Logs(0)
	if len(logs) != 1 || logs[0].Status != http.StatusOK || logs[0].Path != "/jrebel/leases" {
		t.Fatalf("访问日志不正确: %+v", logs)
	}
	// since 之后没有新日志
	if len(srv.Logs(logs[0].ID)) != 0 {
		t.Fatal("since 之后的日志应为空")
	}
}

// TestLocalServerStops 关闭后端口不再可用。
func TestLocalServerStops(t *testing.T) {
	srv := NewLocalServer("com.test.srv", func(LocalRequest) (LocalResponse, error) {
		return LocalResponse{Status: http.StatusOK}, nil
	})
	port, err := srv.Start(0)
	if err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	if running, p := srv.Status(); !running || p != port {
		t.Fatalf("状态不正确: running=%v port=%d", running, p)
	}
	srv.Stop()
	if running, _ := srv.Status(); running {
		t.Fatal("Stop 之后不应仍在监听")
	}
	if _, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port)); err == nil {
		t.Fatal("关闭后仍能连上端口")
	}
}

// stringReader 避免在测试里引入 strings.Reader 的额外导入。
type stringReader struct{ s string }

func (r *stringReader) Read(p []byte) (int, error) {
	if r.s == "" {
		return 0, io.EOF
	}
	n := copy(p, r.s)
	r.s = r.s[n:]
	return n, nil
}

// TestSignWithPrivateKey 签名结果可被标准库验签通过。
func TestSignWithPrivateKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	signature, err := SignWithPrivateKey("RSA-SHA1", string(pemBytes), "data", "")
	if err != nil {
		t.Fatalf("签名失败: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		t.Fatalf("签名不是合法 base64: %v", err)
	}
	digest := sha1.Sum([]byte("data"))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA1, digest[:], raw); err != nil {
		t.Fatalf("验签失败: %v", err)
	}

	if _, err := SignWithPrivateKey("RSA-SHA1", "not-a-pem", "data", ""); err == nil {
		t.Fatal("非法私钥应报错")
	}
	if _, err := SignWithPrivateKey("RSA-SHA512", string(pemBytes), "data", ""); err == nil {
		t.Fatal("未支持的算法应报错")
	}
}

// TestServerPermissionAllowsPort 端口白名单的判定。
func TestServerPermissionAllowsPort(t *testing.T) {
	closed := ServerPermission{}
	if closed.AllowsPort(12345) {
		t.Fatal("未开启时不应允许任何端口")
	}
	any := ServerPermission{Enabled: true}
	if !any.AllowsPort(12345) || any.AllowsPort(80) {
		t.Fatal("未声明白名单时应只允许 1024 以上的端口")
	}
	listed := ServerPermission{Enabled: true, Ports: []int{12345}}
	if !listed.AllowsPort(12345) || listed.AllowsPort(12346) {
		t.Fatal("白名单模式应只允许声明的端口")
	}
	if !listed.AllowsPort(0) {
		t.Fatal("0 表示由系统分配，应始终允许")
	}
}
