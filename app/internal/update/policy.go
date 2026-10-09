package update

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

// PublicKey 发布签名（Ed25519）公钥。
//
// 当前为 nil：只做 SHA-256 校验。启用签名发布时把公钥（raw 32 字节或 PEM）
// 填在这里，并在 main.go 的 Updater 配置里透传即可，其余代码无需改动。
var PublicKey []byte

// ErrDevMode 开发模式不检查更新（跑的是 Vite 开发服务器，版本号是 dev 兜底值）。
var ErrDevMode = errors.New("开发模式不检查更新")

// DevMode 是否处于开发模式。
//
// 用 `FRONTEND_DEVSERVER_URL` 作为信号：根目录 package.json 的 dev:app 脚本
// 会注入它，开发时不应把已发布的正式版当成「新版本」提示自己。
func DevMode() bool {
	return os.Getenv("FRONTEND_DEVSERVER_URL") != ""
}

// HTTPClient 更新专用的 HTTP 客户端。
//
// 刻意不设 http.Client.Timeout：它覆盖「读取响应体」的整个过程，
// 固定的总时限会让稍慢的网络永远下不完更新包。这里只给连接建立阶段设超时，
// 下载本身的生命周期由 context（用户取消）控制。
func HTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   15 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			IdleConnTimeout:       60 * time.Second,
			ExpectContinueTimeout: time.Second,
			ForceAttemptHTTP2:     true,
		},
	}
}

// requireChecksum 校验发布契约：更新包必须带 SHA-256 校验和。
//
// 清单缺失、清单里没有对应条目、算法或长度异常都直接拒绝。
// 框架在缺少校验和时会「当作没配置校验」继续安装，那是静默降级，这里不允许。
func requireChecksum(rel *updater.Release) error {
	verification := rel.Verification
	if verification == nil || len(verification.Digest) == 0 {
		return errors.New("发布包缺少校验和（checksums.txt），已拒绝更新")
	}
	if verification.DigestAlgo != "" && verification.DigestAlgo != "sha256" {
		return fmt.Errorf("不支持的校验算法 %q，已拒绝更新", verification.DigestAlgo)
	}
	if len(verification.Digest) != sha256.Size {
		return fmt.Errorf("校验和长度异常（%d 字节），已拒绝更新", len(verification.Digest))
	}
	return nil
}
