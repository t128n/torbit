//go:build !windows

package platform

import (
	"errors"
	"io"
	"time"
)

const (
	ServiceName        = "TorbitBridge"
	ExitAlreadyRunning = 3
)

var (
	ErrNotElevated    = errors.New("administrator rights are needed")
	ErrAlreadyRunning = errors.New("the bridge is already running for this user")
	errWindowsOnly    = errors.New("the Windows service is only available on Windows")
)

type InstallOptions struct {
	User     string
	Interval time.Duration
	NoStart  bool
	Log      io.Writer
}

type ServiceInfo struct {
	Installed                    bool
	State, StartType, Path, User string
}

func IsWindowsService() bool                     { return false }
func IsElevated() bool                           { return false }
func CurrentUser() (string, string, error)       { return "", "", errWindowsOnly }
func ResolveUser(string) (string, string, error) { return "", "", errWindowsOnly }
func RelaunchElevated([]string) (int, error)     { return 1, errWindowsOnly }
func InstallService(InstallOptions) error        { return errWindowsOnly }
func UninstallService(io.Writer) error           { return errWindowsOnly }
func QueryService() (ServiceInfo, error)         { return ServiceInfo{}, nil }
func ControlService(bool) error                  { return errWindowsOnly }
func RunService(string, time.Duration) error     { return errWindowsOnly }
func InstalledExe() string                       { return "" }
func InstallDir() string                         { return "" }
func ServiceLogPath() string                     { return "" }
func ExplainOutlookError(err error) string       { return err.Error() }
func ReplaceFile(dst string, data []byte) error  { return errWindowsOnly }
