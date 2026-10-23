package selfupdate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLatestVersion(t *testing.T) {
	answer := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answer == "" {
			w.WriteHeader(502)
			return
		}
		w.Write([]byte(answer))
	}))
	defer srv.Close()
	for body, want := range map[string]string{
		`{"version":"v1.2.3"}`:      "v1.2.3",
		`{"version":"1.2.3"}`:       "",
		`{"version":"v1.2"}`:        "",
		`{"version":"v1.2.3-rc.1"}`: "",
		`<html>`:                    "",
		"":                          "",
	} {
		answer = body
		got, err := LatestVersion(context.Background(), srv.URL)
		if got != want || (want == "") != (err != nil) {
			t.Errorf("%q: got %q, %v", body, got, err)
		}
	}
}

// Latest asks LatestURL first and names the assets GoReleaser publishes; the GitHub API is the fallback.
func TestLatestPrefersLatestURL(t *testing.T) {
	latest, api := `{"version":"v2.0.0"}`, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			w.Write([]byte(latest))
		case "/repos/" + Repo + "/releases/latest":
			api++
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.9.0"})
		}
	}))
	defer srv.Close()
	u := &Updater{HTTP: srv.Client(), API: srv.URL, LatestURL: srv.URL + "/latest", Downloads: "https://github.com", OS: "linux", Arch: "arm64"}
	r, err := u.Latest(context.Background())
	if err != nil || r.Tag != "v2.0.0" || api != 0 {
		t.Fatalf("latest: %+v %v (API asked %d times)", r, err, api)
	}
	if url, _ := asset(r, "ot_2.0.0_linux_arm64.tar.gz"); url != "https://github.com/"+Repo+"/releases/download/v2.0.0/ot_2.0.0_linux_arm64.tar.gz" {
		t.Errorf("archive url: %q", url)
	}
	if _, err := asset(r, "checksums.txt.sig"); err != nil {
		t.Error(err)
	}
	latest = `{"version":"nope"}`
	if r, err := u.Latest(context.Background()); err != nil || r.Tag != "v1.9.0" || api != 1 {
		t.Fatalf("fallback: %+v %v", r, err)
	}
}
