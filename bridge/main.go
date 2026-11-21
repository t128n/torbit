// torbit-bridge delivers mail from classic desktop Outlook to Torbit/Orbit.
// It runs on a user's Windows PC, as a Windows service or in the foreground.
package main

import (
	"fmt"
	"os"
	"strings"
)

// version is set at build time: -ldflags "-X main.version=$(cat VERSION)".
var version = "dev"

type command struct {
	name, summary string
	run           func(args []string) int
	hidden        bool
}

var commands []command

func init() {
	commands = []command{
		{"setup", "Guided first-time setup: enroll this PC, check Outlook, install the service", cmdSetup, false},
		{"doctor", "Check enrollment, key, Outlook, Orbit, clock and service; say how to fix problems", cmdDoctor, false},
		{"install", "Install and start the Windows service (needs administrator rights)", cmdInstall, false},
		{"uninstall", "Stop and remove the Windows service (--purge also removes the device)", cmdUninstall, false},
		{"upgrade", "Update torbit-bridge (and the service) to the latest release", cmdUpgrade, false},
		{"enroll", "Register this PC as a device in an Orbit workspace", cmdEnroll, false},
		{"revoke", "Revoke this device in Orbit and delete the local key and data", cmdRevoke, false},
		{"status", "Show the device, key, last run, counts and service state", cmdStatus, false},
		{"run", "Deliver mail in the foreground (the service runs this for you)", cmdRun, false},
		{"backfill", "Deliver inbox mail received since a date, once", cmdBackfill, false},
		{"start", "Start the Windows service", cmdStart, false},
		{"stop", "Stop the Windows service", cmdStop, false},
		{"logs", "Show the end of the bridge log", cmdLogs, false},
		{"version", "Print the version", cmdVersion, false},
		{"service", "Run as a Windows service (started by the Service Control Manager)", cmdService, true},
	}
}

func main() {
	args, restore := handleRelay(os.Args[1:])
	defer restore()
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		usage()
		return
	}
	for _, c := range commands {
		if c.name == args[0] {
			code := c.run(args[1:])
			restore()
			os.Exit(code)
		}
	}
	fmt.Fprintf(os.Stderr, "torbit-bridge: unknown command %q\n\n", args[0])
	usage()
	os.Exit(2)
}

func usage() {
	fmt.Println("torbit-bridge " + version + " - Outlook to Torbit/Orbit mail bridge\n\nUsage: torbit-bridge <command> [flags]\n\nCommands:")
	for _, c := range commands {
		if !c.hidden {
			fmt.Printf("  %-10s %s\n", c.name, c.summary)
		}
	}
	fmt.Println("\nRun 'torbit-bridge <command> -h' for the flags of a command.\nFirst time on this PC: torbit-bridge setup")
}

// handleRelay supports the elevated child process: with --relay FILE its output
// goes to FILE, which the unelevated parent prints. The flag is removed from args.
func handleRelay(args []string) ([]string, func()) {
	out := make([]string, 0, len(args))
	var file string
	for i := 0; i < len(args); i++ {
		if args[i] == "--relay" && i+1 < len(args) {
			file = args[i+1]
			i++
			continue
		}
		out = append(out, args[i])
	}
	if file == "" {
		return out, func() {}
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return out, func() {}
	}
	oo, oe := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = f, f
	done := false
	return out, func() {
		if !done {
			done = true
			f.Close()
			os.Stdout, os.Stderr = oo, oe
		}
	}
}

func errf(format string, a ...any) int {
	msg := fmt.Sprintf(format, a...)
	fmt.Fprintln(os.Stderr, "torbit-bridge: "+strings.TrimSpace(msg))
	return 1
}
