package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Release is the part of a GitHub release the upgrade command needs.
type Release struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r *Release) Version() string { return strings.TrimPrefix(r.Tag, "torbit-v") }

func (r *Release) Asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

// AssetName is the standalone bridge binary attached to each release.
func AssetName(version string) string { return "torbit-bridge-windows-x86_64-" + version + ".exe" }

// LatestRelease fetches the newest release (or a specific version) of repo.
func (h *HTTP) LatestRelease(repo, version string) (*Release, error) {
	u := "https://api.github.com/repos/" + repo + "/releases/latest"
	if version != "" {
		u = "https://api.github.com/repos/" + repo + "/releases/tags/torbit-v" + strings.TrimPrefix(version, "v")
	}
	res := h.Do("GET", u, map[string]string{"Accept": "application/vnd.github+json"}, "", nil)
	if res.Status == 0 {
		return nil, fmt.Errorf("could not reach GitHub: %v", res.Err)
	}
	if res.Status == 404 {
		return nil, errors.New("no such release found")
	}
	if res.Status != 200 {
		return nil, fmt.Errorf("GitHub answered %d", res.Status)
	}
	var r Release
	if err := json.Unmarshal([]byte(res.Body), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Download fetches a release asset, with a larger limit than API calls.
func (h *HTTP) Download(url string) ([]byte, error) {
	res := h.doLarge(url)
	if res.Err != nil {
		return nil, res.Err
	}
	if res.Status != 200 {
		return nil, fmt.Errorf("download answered %d", res.Status)
	}
	return []byte(res.Body), nil
}

// VerifySums checks data against the SHA256SUMS text for name.
func VerifySums(sums string, name string, data []byte) error {
	want := ""
	for _, line := range strings.Split(sums, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return fmt.Errorf("SHA256SUMS has no entry for %s", name)
	}
	h := sha256.Sum256(data)
	if hex.EncodeToString(h[:]) != want {
		return errors.New("checksum mismatch; the download is damaged or was tampered with")
	}
	return nil
}

var reVersion = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?`)

// CompareVersions compares "major.minor.patch+build" strings (the VERSION
// file format). It returns -1, 0 or 1. Unparseable versions (a dev build)
// sort lowest.
func CompareVersions(a, b string) int {
	pa, pb := parseVersion(a), parseVersion(b)
	for i := range pa {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parseVersion(v string) [4]int {
	var out [4]int
	m := reVersion.FindStringSubmatch(v)
	if m == nil {
		out[0] = -1
		return out
	}
	for i := 0; i < 4; i++ {
		out[i], _ = strconv.Atoi(m[i+1])
	}
	return out
}
