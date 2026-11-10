package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
)

// Status is what the harness and `claw remote` read, from one file (`status.json` in the state dir), rewritten on change.
type Status struct {
	// "starting", "needs-login", "needs-approval", "running" or "stopped" (tailscaled's backend states, named).
	State    string   `json:"state"`
	AuthURL  string   `json:"authUrl,omitempty"`
	DNSName  string   `json:"dnsName,omitempty"`
	MagicDNS bool     `json:"magicDns"`
	HTTPS    bool     `json:"https"`
	Owner    string   `json:"owner,omitempty"`
	Allow    []string `json:"allow,omitempty"`
	Problems []string `json:"problems,omitempty"`
}

type Reporter struct {
	File string

	mu   sync.Mutex
	last *Status
}

// Report publishes a status that differs from the last one.
func (r *Reporter) Report(status Status) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last != nil && reflect.DeepEqual(*r.last, status) {
		return nil
	}
	r.last = &status
	line, err := json.Marshal(status)
	if err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(r.File), ".status.json.tmp")
	if err := os.WriteFile(temp, append(line, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temp, r.File)
}

// Stopped reports the node stopped, keeping its name: a device keeps its tailnet name, and the harness's next start
// builds its addresses (pairing links, OAuth callbacks) from it.
func (r *Reporter) Stopped(allow []string) error {
	r.mu.Lock()
	last := Status{Allow: allow}
	if r.last != nil {
		last = *r.last
	}
	r.mu.Unlock()
	return r.Report(Status{State: "stopped", DNSName: last.DNSName, MagicDNS: last.MagicDNS, HTTPS: last.HTTPS, Owner: last.Owner, Allow: allow})
}

// backendState names tailscaled's backend state for people.
func backendState(state string) string {
	switch state {
	case "NeedsLogin":
		return "needs-login"
	case "NeedsMachineAuth":
		return "needs-approval"
	case "Running":
		return "running"
	case "Stopped":
		return "stopped"
	default:
		return "starting"
	}
}

// problems are what keeps a running node from serving: MagicDNS and HTTPS certificates are tailnet settings.
func problems(status Status) []string {
	var found []string
	if status.State != "running" {
		return nil
	}
	if !status.MagicDNS {
		found = append(found, "MagicDNS is off in this tailnet: turn it on at https://login.tailscale.com/admin/dns")
	}
	if !status.HTTPS {
		found = append(found, "HTTPS certificates are off in this tailnet: turn them on at https://login.tailscale.com/admin/dns")
	}
	if status.Owner == "" && len(status.Allow) == 0 {
		found = append(found, "this node is a tagged device, so it has no owner: name who may connect in CLAW_TAILNET_ALLOW")
	}
	return found
}
