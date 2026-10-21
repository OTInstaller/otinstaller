package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// registryExec plays docker and cosign: pulls of refused images fail with the given message, and cosign
// verifies only the references listed as signed.
type registryExec struct {
	fakeExec
	refused map[string]string
	signed  map[string]bool
}

func (f *registryExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	switch {
	case name == "docker" && args[0] == "pull":
		if msg, ok := f.refused[args[1]]; ok {
			io.WriteString(stderr, msg)
			return 1, nil
		}
	case name == "cosign":
		if !f.signed[args[len(args)-1]] {
			return 1, nil
		}
	}
	return 0, nil
}

const signer = "https://github.com/dheeraj/holehe-lite/.github/workflows/release.yml@refs/tags/v1.2.0"

func mirrorOf(image string) string {
	_, digest, _ := strings.Cut(image, "@")
	return "mirror.otinstaller.com/osintverse/holehe-lite@" + digest
}

func TestRefusedImageInstallsFromTheMirrorWithTheSameSignature(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	mirror := mirrorOf(m.Runtime.Image)
	for _, msg := range []string{
		"Error response from daemon: denied",
		"Error response from daemon: unauthorized: authentication required",
		"Error response from daemon: failed to resolve reference: unexpected status from HEAD request: 403 Forbidden",
		"Error response from daemon: manifest unknown",
		"Error response from daemon: error from registry: repository is disabled",
		"failed to resolve reference \"ghcr.io/x/y@sha256:...\": ghcr.io/x/y@sha256:...: not found",
	} {
		fx := &registryExec{fakeExec: fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}, refused: map[string]string{m.Runtime.Image: msg}, signed: map[string]bool{mirror: true}}
		var errOut strings.Builder
		r := &Runner{Exec: fx, Stderr: &errOut, Engine: "docker"}
		inst, err := r.Install(context.Background(), m, nil, InstallOptions{SignerIdentity: signer, SignerIssuer: "https://token.actions.githubusercontent.com", MirrorImage: mirror})
		if err != nil {
			t.Fatalf("%q: %v", msg, err)
		}
		if inst.LocalImage != mirror || !inst.FromBackup || inst.Artifact != m.Runtime.Image {
			t.Fatalf("%q: expected the mirror image, got %+v", msg, inst)
		}
		verify := fx.calls[len(fx.calls)-1]
		if verify[0] != "cosign" || verify[len(verify)-1] != mirror || !strings.Contains(strings.Join(verify, " "), signer) {
			t.Fatalf("%q: expected cosign to verify the same signer on the mirror, got %v", msg, verify)
		}
		if !strings.Contains(errOut.String(), "OTInstaller mirror") {
			t.Fatalf("%q: expected a note about the mirror, got %q", msg, errOut.String())
		}
	}
}

func TestMirrorIsNotUsedForOtherFailures(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	mirror := mirrorOf(m.Runtime.Image)
	cases := map[string]InstallOptions{
		// A network problem is not a refusal.
		"dial tcp: lookup ghcr.io: no such host": {MirrorImage: mirror},
		// The mirror must serve the same digest.
		"denied": {MirrorImage: "mirror.otinstaller.com/osintverse/holehe-lite@sha256:" + strings.Repeat("e", 64)},
		// Nothing mirrored (a non-OSI license, or not backed up yet).
		"denied ": {},
	}
	for msg, opt := range cases {
		fx := &registryExec{fakeExec: fakeExec{paths: map[string]bool{"docker": true}}, refused: map[string]string{m.Runtime.Image: msg}}
		r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
		if _, err := r.Install(context.Background(), m, nil, opt); err == nil {
			t.Fatalf("%q: expected the install to fail", msg)
		}
		if len(fx.calls) != 1 {
			t.Fatalf("%q: expected no second pull, got %v", msg, fx.calls)
		}
	}
}

func TestMirrorImageWithABadSignatureIsRefused(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	mirror := mirrorOf(m.Runtime.Image)
	fx := &registryExec{fakeExec: fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}, refused: map[string]string{m.Runtime.Image: "denied"}, signed: map[string]bool{}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	_, err := r.Install(context.Background(), m, nil, InstallOptions{SignerIdentity: signer, SignerIssuer: "https://token.actions.githubusercontent.com", MirrorImage: mirror})
	if _, ok := err.(*TrustError); !ok {
		t.Fatalf("expected TrustError, got %v", err)
	}
}

func TestWheelFallsBackToTheRegistryCopyWithTheSameHash(t *testing.T) {
	wheel := []byte("the real wheel")
	sum := sha256.Sum256(wheel)
	good := hex.EncodeToString(sum[:])
	pypiStatus := http.StatusNotFound
	backup := wheel
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/pypi/") {
			w.WriteHeader(pypiStatus)
			return
		}
		if r.URL.Path == "/v1/tools/osintverse/phone-parse/0.3.1/wheel/phone_parse-0.3.1-py3-none-any.whl" {
			w.Write(backup)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	old := PyPIBase
	PyPIBase = srv.URL
	defer func() { PyPIBase = old }()
	m := load(t, "pipx-tool.yaml")
	m.Runtime.WheelSHA256 = good
	backupURL := srv.URL + "/v1/tools/osintverse/phone-parse/0.3.1/wheel/phone_parse-0.3.1-py3-none-any.whl"

	path, used, err := FetchWheelWithBackup(context.Background(), m, backupURL, io.Discard)
	if err != nil || !used || filepath.Base(path) != "phone_parse-0.3.1-py3-none-any.whl" {
		t.Fatalf("expected the backup copy, got %q %v %v", path, used, err)
	}

	// The copy is held to the manifest's hash like PyPI's.
	backup = []byte("tampered")
	if _, _, err := FetchWheelWithBackup(context.Background(), m, backupURL, io.Discard); err == nil {
		t.Fatal("expected a TrustError for a tampered backup")
	} else if _, ok := err.(*TrustError); !ok {
		t.Fatalf("expected TrustError, got %T %v", err, err)
	}

	// PyPI being down is not PyPI removing the wheel.
	backup = wheel
	pypiStatus = http.StatusBadGateway
	if _, used, err := FetchWheelWithBackup(context.Background(), m, backupURL, io.Discard); err == nil || used {
		t.Fatalf("expected no fallback for a 502, got used=%v err=%v", used, err)
	}
	pypiStatus = http.StatusForbidden
	if _, used, err := FetchWheelWithBackup(context.Background(), m, backupURL, io.Discard); err != nil || !used {
		t.Fatalf("expected the backup for a 403, got used=%v err=%v", used, err)
	}
}

func TestWheelBackupWhenPyPIDroppedTheFile(t *testing.T) {
	wheel := []byte("w2")
	sum := sha256.Sum256(wheel)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/pypi/") {
			// The release is still listed, but no file has the manifest's hash any more.
			fmt.Fprint(w, `{"urls":[{"filename":"other.whl","url":"x","packagetype":"bdist_wheel","digests":{"sha256":"00"}}]}`)
			return
		}
		w.Write(wheel)
	}))
	defer srv.Close()
	old := PyPIBase
	PyPIBase = srv.URL
	defer func() { PyPIBase = old }()
	m := load(t, "pipx-tool.yaml")
	m.Runtime.WheelSHA256 = hex.EncodeToString(sum[:])
	if _, used, err := FetchWheelWithBackup(context.Background(), m, srv.URL+"/b/p-0.3.1-py3-none-any.whl", io.Discard); err != nil || !used {
		t.Fatalf("expected the backup, got used=%v err=%v", used, err)
	}
	// A backup URL that does not end in a wheel file name is not used.
	if _, used, _ := FetchWheelWithBackup(context.Background(), m, srv.URL+"/b/evil", io.Discard); used {
		t.Fatal("a backup URL without a .whl name must not be used")
	}
}
