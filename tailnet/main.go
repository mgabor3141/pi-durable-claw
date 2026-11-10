// claw-tailnet joins your tailnet as its own device (embedded Tailscale, tsnet), as gmux does, and serves claw there:
// HTTPS on 443 to the harness's T3 app, and SSH on 22 into the workspace, keyless, for "Open in VS Code" and the like.
// Only the node's owner and the allow list get through. The harness starts and stops it (`src/tailnet.ts`) and reads
// its status from a file, as `claw remote` does.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

func main() {
	stateDir := flag.String("state-dir", "", "where the node keeps its identity and status (required)")
	hostname := flag.String("hostname", "claw", "the device name on the tailnet")
	upstream := flag.String("upstream", "http://127.0.0.1:3775", "the harness's HTTP address")
	workspace := flag.String("workspace", "workspace:22", "the workspace's SSH address")
	workspaceUser := flag.String("workspace-user", "agent", "the workspace's user")
	identity := flag.String("identity", "", "the harness's SSH key for the workspace (required)")
	knownHosts := flag.String("known-hosts", "", "the harness's known_hosts for the workspace (required)")
	hostKeyAlias := flag.String("host-key-alias", "claw-workspace", "the name the workspace's key is stored under")
	allow := flag.String("allow", "", "comma-separated logins or tags allowed besides the node's owner")
	verbose := flag.Bool("verbose", false, "log Tailscale's own messages")
	flag.Parse()
	logger := log.New(os.Stderr, "", 0)
	if *stateDir == "" || *identity == "" || *knownHosts == "" {
		logger.Fatal("--state-dir, --identity and --known-hosts are required")
	}
	if err := run(options{
		stateDir: *stateDir, hostname: *hostname, upstream: *upstream, workspace: *workspace, workspaceUser: *workspaceUser,
		identity: *identity, knownHosts: *knownHosts, hostKeyAlias: *hostKeyAlias, allow: splitList(*allow), verbose: *verbose,
	}, logger); err != nil {
		logger.Fatal(err)
	}
}

type options struct {
	stateDir, hostname, upstream, workspace, workspaceUser, identity, knownHosts, hostKeyAlias string
	allow                                                                                      []string
	verbose                                                                                    bool
}

func splitList(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func run(opts options, logger *log.Logger) error {
	upstreamURL, err := url.Parse(opts.upstream)
	if err != nil {
		return fmt.Errorf("--upstream: %w", err)
	}
	nodeDir := filepath.Join(opts.stateDir, "node")
	if err := os.MkdirAll(nodeDir, 0o700); err != nil {
		return err
	}
	hostKey, err := loadOrCreateHostKey(filepath.Join(opts.stateDir, "ssh_host_ed25519_key"))
	if err != nil {
		return fmt.Errorf("the relay's host key: %w", err)
	}
	clientKey, err := readSigner(opts.identity)
	if err != nil {
		return fmt.Errorf("the harness's SSH key: %w", err)
	}
	trusted, err := knownhosts.New(opts.knownHosts)
	if err != nil {
		return fmt.Errorf("the harness's known_hosts: %w", err)
	}

	server := &tsnet.Server{Dir: nodeDir, Hostname: opts.hostname, UserLogf: logger.Printf}
	if opts.verbose {
		server.Logf = logger.Printf
	} else {
		server.Logf = func(string, ...any) {}
	}
	if err := server.Start(); err != nil {
		return fmt.Errorf("starting Tailscale: %w", err)
	}
	client, err := server.LocalClient()
	if err != nil {
		return err
	}

	gate := &Gate{Allow: opts.allow, WhoIs: func(ctx context.Context, remoteAddr string) (Peer, error) {
		who, err := client.WhoIs(ctx, remoteAddr)
		if err != nil {
			return Peer{}, err
		}
		if who.Node != nil && who.Node.IsTagged() {
			return Peer{Tags: who.Node.Tags}, nil
		}
		if who.UserProfile == nil {
			return Peer{}, errors.New("no user")
		}
		return Peer{Login: who.UserProfile.LoginName}, nil
	}}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	// Status first: until the node is logged in the listeners wait, and the login link is what the user needs.
	reporter := &Reporter{File: filepath.Join(opts.stateDir, "status.json")}
	go watch(ctx, client, gate, opts.allow, reporter, logger)

	relay := &Relay{
		Gate:    gate,
		HostKey: hostKey,
		Dial: func(ctx context.Context) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "tcp", opts.workspace)
		},
		Upstream: &ssh.ClientConfig{
			User:            opts.workspaceUser,
			Auth:            []ssh.AuthMethod{ssh.PublicKeys(clientKey)},
			HostKeyCallback: aliasHostKeys(trusted, opts.hostKeyAlias),
			Timeout:         10 * time.Second,
		},
		Addr: opts.workspace,
		Logf: logger.Printf,
	}
	go func() {
		listener, err := server.Listen("tcp", ":22")
		if err != nil {
			logger.Printf("ssh: cannot listen on 22: %v", err)
			return
		}
		_ = relay.Serve(listener)
	}()
	httpServer := &http.Server{Handler: Proxy(upstreamURL, gate, logger.Printf), ReadHeaderTimeout: 30 * time.Second}
	go serveHTTPS(ctx, server, httpServer, logger)

	<-ctx.Done()
	_ = httpServer.Close()
	_ = reporter.Stopped(opts.allow)
	// tsnet's Close can wait 5 s on a listener still waiting for login; the node's state is already saved, so it gets
	// 2 s and the program ends, inside the harness's stop grace.
	closed := make(chan struct{})
	go func() { _ = server.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
	}
	return nil
}

// serveHTTPS listens on 443 once it can: the listener waits for the node to log in, and fails while the tailnet has
// HTTPS certificates off, so it is retried until it works (turning certificates on needs no restart).
func serveHTTPS(ctx context.Context, server *tsnet.Server, httpServer *http.Server, logger *log.Logger) {
	var lastErr string
	for ctx.Err() == nil {
		listener, err := server.ListenTLS("tcp", ":443")
		if err == nil {
			_ = httpServer.Serve(listener)
			return
		}
		if err.Error() != lastErr {
			logger.Printf("https: not serving yet: %v", err)
			lastErr = err.Error()
		}
		sleep(ctx, 30*time.Second)
	}
}

// watch follows the node's state and reports it: the login link while it needs one, its name, owner and the tailnet
// settings it needs once it runs.
func watch(ctx context.Context, client *local.Client, gate *Gate, allow []string, reporter *Reporter, logger *log.Logger) {
	var authURL string
	report := func() {
		status := Status{State: "starting", Allow: allow}
		if st, err := client.StatusWithoutPeers(ctx); err == nil {
			status.State = backendState(st.BackendState)
			if st.AuthURL != "" {
				authURL = st.AuthURL
			}
			if st.Self != nil {
				status.DNSName = strings.TrimSuffix(st.Self.DNSName, ".")
				if st.Self.Tags == nil || st.Self.Tags.Len() == 0 {
					if user, ok := st.User[st.Self.UserID]; ok {
						status.Owner = user.LoginName
					}
				}
			}
			status.MagicDNS = st.CurrentTailnet != nil && st.CurrentTailnet.MagicDNSEnabled
			status.HTTPS = status.DNSName != "" && slices.Contains(st.CertDomains, status.DNSName)
		}
		if status.State == "needs-login" {
			status.AuthURL = authURL
		}
		gate.SetOwner(status.Owner)
		status.Problems = problems(status)
		if err := reporter.Report(status); err != nil {
			logger.Printf("status: %v", err)
		}
	}
	for ctx.Err() == nil {
		watcher, err := client.WatchIPNBus(ctx, ipn.NotifyInitialState|ipn.NotifyNoPrivateKeys)
		if err != nil {
			report()
			sleep(ctx, 2*time.Second)
			continue
		}
		tick := time.NewTicker(30 * time.Second)
		notes := make(chan ipn.Notify)
		go func() {
			defer close(notes)
			for {
				note, err := watcher.Next()
				if err != nil {
					return
				}
				notes <- note
			}
		}()
		report()
	loop:
		for {
			select {
			case note, ok := <-notes:
				if !ok {
					break loop
				}
				if note.BrowseToURL != nil {
					authURL = *note.BrowseToURL
				}
				report()
			case <-tick.C:
				report()
			case <-ctx.Done():
				break loop
			}
		}
		tick.Stop()
		watcher.Close()
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func readSigner(path string) (ssh.Signer, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(raw)
}

// loadOrCreateHostKey keeps the relay's own host key with the node's state, so laptops' known_hosts stay valid.
func loadOrCreateHostKey(path string) (ssh.Signer, error) {
	if signer, err := readSigner(path); err == nil {
		return signer, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(private, "claw-tailnet")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(private)
}
