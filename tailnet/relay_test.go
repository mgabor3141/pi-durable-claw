package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

// fakeWorkspace is an sshd that accepts only the harness's key, runs "echo" sessions (stdout, stderr, exit status),
// opens direct-tcpip channels, and answers a global request.
func fakeWorkspace(t *testing.T, hostKey ssh.Signer, harnessKey ssh.PublicKey) string {
	t.Helper()
	config := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if meta.User() == "agent" && bytes.Equal(key.Marshal(), harnessKey.Marshal()) {
			return nil, nil
		}
		return nil, errors.New("denied")
	}}
	config.AddHostKey(hostKey)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(conn, config)
				if err != nil {
					conn.Close()
					return
				}
				go func() {
					for req := range reqs {
						if req.Type == "ping@test" {
							_ = req.Reply(true, append([]byte("pong:"), req.Payload...))
						} else if req.WantReply {
							_ = req.Reply(false, nil)
						}
					}
				}()
				for incoming := range chans {
					switch incoming.ChannelType() {
					case "session":
						go session(incoming)
					case "direct-tcpip":
						go directTCPIP(incoming)
					default:
						_ = incoming.Reject(ssh.UnknownChannelType, "no "+incoming.ChannelType())
					}
				}
			}()
		}
	}()
	return listener.Addr().String()
}

func session(incoming ssh.NewChannel) {
	channel, reqs, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for req := range reqs {
		if req.Type != "exec" {
			_ = req.Reply(false, nil)
			continue
		}
		command := string(req.Payload[4:])
		_ = req.Reply(true, nil)
		_, _ = io.WriteString(channel, strings.TrimPrefix(command, "echo ")+"\n")
		_, _ = io.WriteString(channel.Stderr(), "to stderr\n")
		status := make([]byte, 4)
		binary.BigEndian.PutUint32(status, 3)
		_, _ = channel.SendRequest("exit-status", false, status)
		return
	}
}

func directTCPIP(incoming ssh.NewChannel) {
	var target struct {
		Host       string
		Port       uint32
		OriginHost string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(incoming.ExtraData(), &target); err != nil {
		_ = incoming.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	conn, err := net.Dial("tcp", net.JoinHostPort(target.Host, itoa(target.Port)))
	if err != nil {
		_ = incoming.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, reqs, err := incoming.Accept()
	if err != nil {
		conn.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	go func() { _, _ = io.Copy(conn, channel); conn.Close() }()
	_, _ = io.Copy(channel, conn)
	channel.Close()
}

func itoa(n uint32) string { return strconv.FormatUint(uint64(n), 10) }

func echoServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(conn, conn); conn.Close() }()
		}
	}()
	return listener.Addr().String()
}

type relayFixture struct {
	addr      string
	logs      *strings.Builder
	relayKey  ssh.PublicKey
	whoIsCall func(string) (Peer, error)
}

// startRelay runs the relay on loopback in front of a fake workspace whose key is trusted as pi-env stores it.
func startRelay(t *testing.T, peer Peer, trustedWorkspaceKey func(actual ssh.PublicKey) ssh.PublicKey) relayFixture {
	t.Helper()
	harnessKey := newSigner(t)
	workspaceKey := newSigner(t)
	workspaceAddr := fakeWorkspace(t, workspaceKey, harnessKey.PublicKey())
	knownHostsFile := filepath.Join(t.TempDir(), "known_hosts")
	line := knownhosts.Line([]string{"claw-workspace"}, trustedWorkspaceKey(workspaceKey.PublicKey()))
	if err := os.WriteFile(knownHostsFile, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	trusted, err := knownhosts.New(knownHostsFile)
	if err != nil {
		t.Fatal(err)
	}
	logs := &strings.Builder{}
	gate := &Gate{WhoIs: func(context.Context, string) (Peer, error) { return peer, nil }}
	gate.SetOwner("owner@example.com")
	relayKey := newSigner(t)
	relay := &Relay{
		Gate:    gate,
		HostKey: relayKey,
		Dial: func(ctx context.Context) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "tcp", workspaceAddr)
		},
		Upstream: &ssh.ClientConfig{User: "agent", Auth: []ssh.AuthMethod{ssh.PublicKeys(harnessKey)}, HostKeyCallback: aliasHostKeys(trusted, "claw-workspace"), Timeout: 5 * time.Second},
		Addr:     workspaceAddr,
		Logf:     func(format string, args ...any) { logs.WriteString(strings.TrimSpace(sprintf(format, args...)) + "\n") },
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() { _ = relay.Serve(listener) }()
	return relayFixture{addr: listener.Addr().String(), logs: logs, relayKey: relayKey.PublicKey()}
}

// dial logs in as a laptop would: no key, any user name, the relay's host key pinned.
func dial(t *testing.T, fixture relayFixture, user string) (*ssh.Client, error) {
	t.Helper()
	return ssh.Dial("tcp", fixture.addr, &ssh.ClientConfig{User: user, HostKeyCallback: ssh.FixedHostKey(fixture.relayKey), Timeout: 5 * time.Second})
}

func same(actual ssh.PublicKey) ssh.PublicKey { return actual }

func TestRelayRunsCommandsKeylessWithOutputAndExitStatus(t *testing.T) {
	fixture := startRelay(t, Peer{Login: "owner@example.com"}, same)
	client, err := dial(t, fixture, "whoever")
	if err != nil {
		t.Fatalf("login without a key: %v", err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	session.Stdout, session.Stderr = &stdout, &stderr
	err = session.Run("echo hello from the workspace")
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.ExitStatus() != 3 {
		t.Fatalf("exit status: %v", err)
	}
	if stdout.String() != "hello from the workspace\n" || stderr.String() != "to stderr\n" {
		t.Fatalf("output: %q / %q", stdout.String(), stderr.String())
	}
	// Many sessions over one connection, as VS Code opens them.
	for i := 0; i < 5; i++ {
		session, err := client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		out, _ := session.Output("echo again")
		if string(out) != "again\n" {
			t.Fatalf("session %d: %q", i, out)
		}
	}
}

func TestRelayForwardsPortsAndGlobalRequests(t *testing.T) {
	fixture := startRelay(t, Peer{Login: "owner@example.com"}, same)
	client, err := dial(t, fixture, "agent")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conn, err := client.Dial("tcp", echoServer(t))
	if err != nil {
		t.Fatalf("local forward: %v", err)
	}
	payload := bytes.Repeat([]byte("vscode-server "), 10_000)
	go func() { _, _ = conn.Write(payload) }()
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, got); err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("forwarded bytes: %v", err)
	}
	conn.Close()
	ok, reply, err := client.SendRequest("ping@test", true, []byte("x"))
	if err != nil || !ok || string(reply) != "pong:x" {
		t.Fatalf("global request: %v %v %q", ok, err, reply)
	}
	if _, err := client.Dial("tcp", "127.0.0.1:1"); err == nil {
		t.Fatal("a refused forward must be refused here too")
	}
}

func TestRelayRefusesPeersTheGateRefuses(t *testing.T) {
	fixture := startRelay(t, Peer{Login: "stranger@example.com"}, same)
	if _, err := dial(t, fixture, "agent"); err == nil {
		t.Fatal("a stranger got in")
	}
	if !strings.Contains(fixture.logs.String(), "stranger@example.com is not this node's owner") {
		t.Fatalf("logs: %s", fixture.logs.String())
	}
}

func TestRelayRefusesAWorkspaceWithAnotherHostKey(t *testing.T) {
	other := newSigner(t).PublicKey()
	fixture := startRelay(t, Peer{Login: "owner@example.com"}, func(ssh.PublicKey) ssh.PublicKey { return other })
	client, err := dial(t, fixture, "agent")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, err = client.NewSession()
	if err == nil || !strings.Contains(err.Error(), "host key does not match") {
		t.Fatalf("session against an untrusted workspace: %v", err)
	}
}
