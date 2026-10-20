// Package selfupdate replaces the running ot with the latest signed release.
//
// Every release publishes checksums.txt (SHA-256 of each archive) and checksums.txt.sig, an Ed25519 signature
// of it made with the release key. ot embeds the release key's public half at build time and refuses to update
// when the signature or the archive's checksum does not match.
package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Set with -ldflags "-X github.com/otinstaller/otinstaller/cli/internal/selfupdate.Repo=... -X ...PublicKey=...".
var (
	// Repo is the public GitHub repository that hosts ot releases.
	Repo = "otinstaller/ot"
	// PublicKey is the base64 Ed25519 public key that signs checksums.txt. Builds without it cannot self-update.
	PublicKey = ""
)

const maxDownload = 200 << 20

type Asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type Release struct {
	Tag    string  `json:"tag_name"`
	Assets []Asset `json:"assets"`
}

// Updater talks to GitHub; tests point API at a fake.
type Updater struct {
	HTTP *http.Client
	API  string // https://api.github.com
	Key  ed25519.PublicKey
	OS   string
	Arch string
}

// New returns an updater for this platform, or an error when this build carries no release key.
func New() (*Updater, error) {
	key, err := base64.StdEncoding.DecodeString(PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("this build of ot has no release key, so it cannot update itself; reinstall it from https://otinstaller.com/docs/getting-started")
	}
	return &Updater{HTTP: http.DefaultClient, API: "https://api.github.com", Key: key, OS: runtime.GOOS, Arch: runtime.GOARCH}, nil
}

func (u *Updater) get(ctx context.Context, url string, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "ot-self-update")
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxDownload))
}

// Latest is the newest published release.
func (u *Updater) Latest(ctx context.Context) (*Release, error) {
	b, err := u.get(ctx, strings.TrimRight(u.API, "/")+"/repos/"+Repo+"/releases/latest", "application/vnd.github+json")
	if err != nil {
		return nil, fmt.Errorf("cannot find the latest release: %w", err)
	}
	var r Release
	return &r, json.Unmarshal(b, &r)
}

// ArchiveName is GoReleaser's archive name for a version and platform (zip on Windows).
func (u *Updater) ArchiveName(version string) string {
	ext := "tar.gz"
	if u.OS == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("ot_%s_%s_%s.%s", strings.TrimPrefix(version, "v"), u.OS, u.Arch, ext)
}

func asset(r *Release, name string) (string, error) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL, nil
		}
	}
	return "", fmt.Errorf("release %s has no %s", r.Tag, name)
}

// VerifyChecksums checks the signature over checksums.txt; sig may be raw or base64.
func VerifyChecksums(key ed25519.PublicKey, checksums, sig []byte) error {
	raw := sig
	if len(sig) != ed25519.SignatureSize {
		if d, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig))); err == nil {
			raw = d
		}
	}
	if len(raw) != ed25519.SignatureSize || !ed25519.Verify(key, checksums, raw) {
		return errors.New("the release's checksums are not signed by the ot release key")
	}
	return nil
}

// ChecksumFor finds a file's SHA-256 in checksums.txt ("<hex>  <name>" lines).
func ChecksumFor(checksums []byte, name string) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(checksums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && f[1] == name {
			return f[0], nil
		}
	}
	return "", fmt.Errorf("checksums.txt has no entry for %s", name)
}

// Download fetches, verifies and unpacks the release's ot binary for this platform.
func (u *Updater) Download(ctx context.Context, r *Release) ([]byte, error) {
	name := u.ArchiveName(r.Tag)
	sumsURL, err := asset(r, "checksums.txt")
	if err != nil {
		return nil, err
	}
	sigURL, err := asset(r, "checksums.txt.sig")
	if err != nil {
		return nil, err
	}
	archiveURL, err := asset(r, name)
	if err != nil {
		return nil, err
	}
	sums, err := u.get(ctx, sumsURL, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	sig, err := u.get(ctx, sigURL, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	if err := VerifyChecksums(u.Key, sums, sig); err != nil {
		return nil, err
	}
	want, err := ChecksumFor(sums, name)
	if err != nil {
		return nil, err
	}
	archive, err := u.get(ctx, archiveURL, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	if got := sha256.Sum256(archive); hex.EncodeToString(got[:]) != want {
		return nil, fmt.Errorf("%s does not match its signed checksum", name)
	}
	return extract(archive, u.OS == "windows")
}

func extract(archive []byte, isZip bool) ([]byte, error) {
	if isZip {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if filepath.Base(f.Name) == "ot.exe" {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, maxDownload))
			}
		}
		return nil, errors.New("the archive has no ot.exe")
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err != nil {
			return nil, errors.New("the archive has no ot binary")
		}
		if filepath.Base(h.Name) == "ot" && h.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(tr, maxDownload))
		}
	}
}

// Replace swaps the binary at exe for bin. A running Windows executable cannot be overwritten but can be
// renamed, so the old one is moved aside first (and removed on the next update).
func Replace(exe string, bin []byte) error {
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".ot-update-*")
	if err != nil {
		return fmt.Errorf("cannot write next to %s (try again with permission to change it): %w", exe, err)
	}
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	tmp.Close()
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if runtime.GOOS == "windows" {
		if err := os.Rename(exe, old); err != nil {
			os.Remove(tmp.Name())
			return err
		}
	}
	if err := os.Rename(tmp.Name(), exe); err != nil {
		if runtime.GOOS == "windows" {
			_ = os.Rename(old, exe)
		}
		os.Remove(tmp.Name())
		return err
	}
	return nil
}

// Newer reports whether version a is newer than b (vX.Y.Z; a prerelease is older than its release).
func Newer(a, b string) bool {
	pa, pb := parse(a), parse(b)
	for i := 0; i < 3; i++ {
		if pa.n[i] != pb.n[i] {
			return pa.n[i] > pb.n[i]
		}
	}
	if (pa.pre == "") != (pb.pre == "") {
		return pa.pre == ""
	}
	return pa.pre > pb.pre
}

type semver struct {
	n   [3]int
	pre string
}

func parse(v string) semver {
	core, pre, _ := strings.Cut(strings.TrimPrefix(v, "v"), "-")
	var s semver
	for i, p := range strings.SplitN(core, ".", 3) {
		s.n[i], _ = strconv.Atoi(p)
	}
	s.pre = pre
	return s
}
