package agent

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// TokenTTL is how long a consent token, or a pending consent request, stays valid.
const TokenTTL = 10 * time.Minute

// sessionKey signs consent tokens and request state. It is new for each process, so tokens die with the server.
var sessionKey = func() []byte {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return b
}()

// CallHash identifies one exact call: the tool name, the package and artifact, and the arguments, canonically
// encoded. A consent answer only ever applies to the call it was given for.
func CallHash(tool, artifact string, args map[string]any) string {
	keys := make([]string, 0, len(args))
	for k := range args {
		if k != "consent_token" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s", tool, artifact)
	for _, k := range keys {
		v, _ := json.Marshal(args[k])
		fmt.Fprintf(h, "\x00%s=%s", k, v)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func sign(s string) string {
	m := hmac.New(sha256.New, sessionKey)
	m.Write([]byte(s))
	return hex.EncodeToString(m.Sum(nil))[:32]
}

// Seal binds a call hash to an expiry and a random nonce, and signs it: the format of consent tokens and of pending
// request state. The nonce makes each one unique, so spending one never spends another for the same call.
func Seal(prefix, callHash string) string {
	n := make([]byte, 8)
	_, _ = rand.Read(n)
	body := strconv.FormatInt(time.Now().Add(TokenTTL).Unix(), 10) + "." + hex.EncodeToString(n)
	return prefix + body + "." + sign(prefix+body+"."+callHash)
}

// Open checks that sealed was made by this process for callHash and has not expired.
func Open(prefix, sealed, callHash string) bool {
	rest, ok := strings.CutPrefix(sealed, prefix)
	if !ok {
		return false
	}
	parts := strings.Split(rest, ".")
	if len(parts) != 3 {
		return false
	}
	n, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || time.Now().Unix() > n {
		return false
	}
	return hmac.Equal([]byte(parts[2]), []byte(sign(prefix+parts[0]+"."+parts[1]+"."+callHash)))
}

// NewToken is a consent token for one call, for clients that can't ask the person themselves.
func (s *Session) NewToken(callHash string) string { return Seal("ct_", callHash) }

// UseToken checks a consent token for callHash and spends it: each token works once.
func (s *Session) UseToken(token, callHash string) bool {
	return Open("ct_", token, callHash) && s.SpendOnce(token)
}
