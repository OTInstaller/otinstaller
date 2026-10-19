// Package keys stores API keys in the OS keychain (Windows Credential Manager, macOS Keychain,
// Secret Service on Linux).
package keys

import (
	"encoding/json"
	"errors"
	"os"
	"sort"

	"github.com/zalando/go-keyring"

	"github.com/otinstaller/otinstaller/cli/internal/state"
)

const service = "osintverse-ot"

// The keychain has no "list" operation, so key names (never values) are tracked in a small index.
func indexPath() string { return state.Path("keys.json") }

func loadIndex() []string {
	var names []string
	if b, err := os.ReadFile(indexPath()); err == nil {
		_ = json.Unmarshal(b, &names)
	}
	return names
}

func saveIndex(names []string) error {
	sort.Strings(names)
	b, _ := json.Marshal(names)
	if err := os.MkdirAll(state.Home(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(indexPath(), b, 0o600)
}

func Set(name, value string) error {
	if err := keyring.Set(service, name, value); err != nil {
		return err
	}
	names := loadIndex()
	for _, n := range names {
		if n == name {
			return nil
		}
	}
	return saveIndex(append(names, name))
}

// ErrNotFound means the key is neither in the environment nor in the keychain.
var ErrNotFound = errors.New("key not set")

// Get prefers an environment variable of the same name (useful in CI), then the keychain.
func Get(name string) (string, error) {
	if v := os.Getenv(name); v != "" {
		return v, nil
	}
	v, err := keyring.Get(service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

func Delete(name string) error {
	err := keyring.Delete(service, name)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return err
	}
	var keep []string
	for _, n := range loadIndex() {
		if n != name {
			keep = append(keep, n)
		}
	}
	return saveIndex(keep)
}

func List() []string { return loadIndex() }
