package plugin

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"strings"
	"testing"
)

// TestEncryptWithPublicKey 公钥加密结果能被对应私钥解回来。
func TestEncryptWithPublicKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("序列化公钥失败: %v", err)
	}
	// SPKI DER 的 base64：PMS 登录公钥就是这种形态
	spki := base64.StdEncoding.EncodeToString(der)

	cipherText, err := EncryptWithPublicKey(spki, "p@ssw0rd")
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(cipherText)
	if err != nil {
		t.Fatalf("密文不是合法 base64: %v", err)
	}
	plain, err := rsa.DecryptPKCS1v15(rand.Reader, key, raw)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	if string(plain) != "p@ssw0rd" {
		t.Fatalf("解密结果不符: %q", plain)
	}

	// PEM 公钥同样支持
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	if _, err := EncryptWithPublicKey(string(pemKey), "x"); err != nil {
		t.Fatalf("PEM 公钥应可解析: %v", err)
	}

	// 空内容与非法公钥都要报错
	if _, err := EncryptWithPublicKey(spki, "  "); err == nil {
		t.Fatal("空内容应报错")
	}
	if _, err := EncryptWithPublicKey("not-a-key", "x"); err == nil {
		t.Fatal("非法公钥应报错")
	}
	if !strings.Contains(strings.ToLower("NOT-A-KEY"), "not-a-key") {
		t.Fatal("unreachable")
	}
}
