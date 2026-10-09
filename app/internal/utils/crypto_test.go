package utils

import (
	"strings"
	"testing"
)

// 32 字节测试密钥（不落盘，仅用于单测）
var testKey = []byte("0123456789abcdef0123456789abcdef")

func TestEncryptIfNeeded_EncryptsPlain(t *testing.T) {
	c := &Cipher{key: testKey}

	got, err := c.EncryptIfNeeded("P@ssw0rd")
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}
	if !strings.HasPrefix(got, cipherPrefix) {
		t.Fatalf("应输出带前缀的密文，实际: %s", got)
	}

	// 幂等：已经加密过的值不应被再加密一次
	again, err := c.EncryptIfNeeded(got)
	if err != nil {
		t.Fatalf("二次调用失败: %v", err)
	}
	if again != got {
		t.Errorf("密文被重复加密: %s", again)
	}
}

func TestEncryptIfNeeded_PlainLookingLikeCipher(t *testing.T) {
	c := &Cipher{key: testKey}

	// 用户密码恰好以 enc:v1: 开头：不能只看前缀就当成密文跳过加密，
	// 否则明文落库、读取时又会按密文解码。
	tricky := cipherPrefix + "not-a-real-cipher"
	got, err := c.EncryptIfNeeded(tricky)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}
	if got == tricky {
		t.Fatalf("被前缀误判为密文，明文直接落库")
	}

	plain, err := c.Decrypt(got)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	if plain != tricky {
		t.Errorf("解密结果不符: %q", plain)
	}
}
