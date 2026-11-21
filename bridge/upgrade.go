package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/t128n/torbit/bridge/internal/core"
	"github.com/t128n/torbit/bridge/internal/platform"
)

const defaultRepo = "t128n/torbit"

func cmdUpgrade(args []string) int {
	fs := newFlags("upgrade")
	check := fs.Bool("check", false, "only report whether a newer release exists")
	want := fs.String("version", "", "install this version instead of the latest (also allows a downgrade)")
	repo := fs.String("repo", defaultRepo, "GitHub repository that publishes the releases")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if runtime.GOOS != "windows" {
		return errf("upgrade replaces the Windows binary; build from source on %s", runtime.GOOS)
	}
	h := httpClient()
	rel, err := h.LatestRelease(*repo, *want)
	if err != nil {
		return errf("%v", err)
	}
	latest := rel.Version()
	fmt.Printf("Installed: %s   Release: %s\n", version, latest)
	if *want == "" && core.CompareVersions(version, latest) >= 0 {
		fmt.Println("Already up to date.")
		return 0
	}
	if *check {
		fmt.Printf("A newer release is available: %s. Run: torbit-bridge upgrade\n", latest)
		return 0
	}

	// The service binary lives in Program Files, so replacing it needs admin.
	info, _ := platform.QueryService()
	if info.Installed && !platform.IsElevated() {
		re := []string{"upgrade", "--repo", *repo}
		if *want != "" {
			re = append(re, "--version", *want)
		}
		return elevate(re)
	}

	asset := core.AssetName(latest)
	exeURL, sumsURL := rel.Asset(asset), rel.Asset("SHA256SUMS")
	if exeURL == "" || sumsURL == "" {
		return errf("release %s has no %s or SHA256SUMS", rel.Tag, asset)
	}
	fmt.Println("Downloading", asset)
	data, err := h.Download(exeURL)
	if err != nil {
		return errf("%v", err)
	}
	sums, err := h.Download(sumsURL)
	if err != nil {
		return errf("%v", err)
	}
	if err := core.VerifySums(string(sums), asset, data); err != nil {
		return errf("%v", err)
	}
	fmt.Println("Checksum verified.")

	// Run the download once before it replaces anything: a wrong-architecture or
	// damaged file must not take the working bridge down.
	dir, err := os.MkdirTemp("", "torbit-bridge-upgrade-")
	if err != nil {
		return errf("%v", err)
	}
	defer os.RemoveAll(dir)
	probe := filepath.Join(dir, "torbit-bridge.exe")
	if err := os.WriteFile(probe, data, 0o755); err != nil {
		return errf("%v", err)
	}
	out, err := exec.Command(probe, "version", "--short").Output()
	if err != nil || strings.TrimSpace(string(out)) != latest {
		return errf("the downloaded file does not run or reports another version (%q); nothing was changed", strings.TrimSpace(string(out)))
	}

	self, _ := os.Executable()
	wasRunning := info.Installed && info.State == "running"
	if info.Installed {
		fmt.Println("Stopping the service...")
		if err := platform.ControlService(false); err != nil {
			return errf("%v", err)
		}
		if err := platform.ReplaceFile(info.Path, data); err != nil {
			if wasRunning {
				platform.ControlService(true)
			}
			return errf("could not replace %s: %v", info.Path, err)
		}
		fmt.Println("Replaced", info.Path)
		if samePath(self, info.Path) {
			self = ""
		}
	}
	if self != "" {
		// This copy too, so a later `torbit-bridge ...` from the same folder is new.
		if err := platform.ReplaceFile(self, data); err != nil {
			fmt.Printf("Could not update this copy (%s): %v\n", self, err)
		} else {
			fmt.Println("Replaced", self)
		}
	}
	if wasRunning {
		if err := platform.ControlService(true); err != nil {
			return errf("updated, but the service did not start: %v (try: torbit-bridge start)", err)
		}
		fmt.Println("Service started.")
	}
	fmt.Printf("Upgraded to %s. Check with: torbit-bridge doctor\n", latest)
	return 0
}

func samePath(a, b string) bool {
	ea, e1 := filepath.EvalSymlinks(a)
	eb, e2 := filepath.EvalSymlinks(b)
	if e1 != nil || e2 != nil {
		return strings.EqualFold(a, b)
	}
	return strings.EqualFold(ea, eb)
}
