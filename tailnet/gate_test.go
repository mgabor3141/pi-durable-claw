package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGateLetsTheOwnerAndTheAllowListIn(t *testing.T) {
	peers := map[string]Peer{
		"1": {Login: "owner@example.com"},
		"2": {Login: "friend@example.com"},
		"3": {Login: "stranger@example.com"},
		"4": {Tags: []string{"tag:ci"}},
		"5": {Tags: []string{"tag:server"}},
	}
	gate := &Gate{Allow: []string{"friend@example.com", "tag:ci"}, WhoIs: func(_ context.Context, addr string) (Peer, error) { return peers[addr], nil }}
	gate.SetOwner("owner@example.com")
	for addr, allowed := range map[string]bool{"1": true, "2": true, "3": false, "4": true, "5": false} {
		if _, err := gate.Check(context.Background(), addr); (err == nil) != allowed {
			t.Errorf("%s: allowed %v, got %v", peers[addr], allowed, err)
		}
	}
	// A tagged node has no owner: only the allow list opens it.
	gate.SetOwner("")
	if _, err := gate.Check(context.Background(), "1"); err == nil {
		t.Error("an ownerless node let a login in that the allow list does not name")
	}
}

func proxyFixture(t *testing.T, peer Peer) (*httptest.Server, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Upgrade") == "websocket" {
			hijacker := writer.(http.Hijacker)
			conn, buffered, _ := hijacker.Hijack()
			defer conn.Close()
			_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			line, _ := buffered.ReadString('\n')
			_, _ = io.WriteString(conn, "echo:"+line)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]string{"host": request.Host, "proto": request.Header.Get("X-Forwarded-Proto"), "path": request.URL.Path})
	}))
	t.Cleanup(upstream.Close)
	target, _ := url.Parse(upstream.URL)
	gate := &Gate{WhoIs: func(context.Context, string) (Peer, error) { return peer, nil }}
	gate.SetOwner("owner@example.com")
	front := httptest.NewTLSServer(Proxy(target, gate, t.Logf))
	t.Cleanup(front.Close)
	return front, upstream
}

func TestProxyKeepsTheHostAndPassesUpgrades(t *testing.T) {
	front, _ := proxyFixture(t, Peer{Login: "owner@example.com"})
	request, _ := http.NewRequest("GET", front.URL+"/api/x", nil)
	request.Host = "claw.tail1234.ts.net"
	response, err := front.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var seen map[string]string
	_ = json.NewDecoder(response.Body).Decode(&seen)
	if seen["host"] != "claw.tail1234.ts.net" || seen["proto"] != "https" || seen["path"] != "/api/x" {
		t.Fatalf("upstream saw %v", seen)
	}

	conn, err := tls.Dial("tcp", strings.TrimPrefix(front.URL, "https://"), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: claw.tail1234.ts.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	reader := bufio.NewReader(conn)
	status, _ := reader.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade answered %q", status)
	}
	for line, _ := reader.ReadString('\n'); line != "\r\n"; line, _ = reader.ReadString('\n') {
	}
	_, _ = io.WriteString(conn, "frame\n")
	echoed, _ := reader.ReadString('\n')
	if echoed != "echo:frame\n" {
		t.Fatalf("upgraded stream: %q", echoed)
	}
}

func TestProxyRefusesPeersTheGateRefuses(t *testing.T) {
	front, _ := proxyFixture(t, Peer{Login: "stranger@example.com"})
	response, err := front.Client().Get(front.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "CLAW_TAILNET_ALLOW") {
		t.Fatalf("%d %s", response.StatusCode, body)
	}
}

func TestReporterWritesChangesOnly(t *testing.T) {
	file := filepath.Join(t.TempDir(), "status.json")
	var lines []string
	reporter := &Reporter{File: file, Out: func(line []byte) { lines = append(lines, string(line)) }}
	running := Status{State: "running", DNSName: "claw.tail1234.ts.net", MagicDNS: true, HTTPS: false, Owner: "owner@example.com"}
	running.Problems = problems(running)
	for i := 0; i < 3; i++ {
		if err := reporter.Report(running); err != nil {
			t.Fatal(err)
		}
	}
	if len(lines) != 1 {
		t.Fatalf("reported %d times", len(lines))
	}
	raw, _ := os.ReadFile(file)
	var read Status
	_ = json.Unmarshal(raw, &read)
	if read.DNSName != "claw.tail1234.ts.net" || len(read.Problems) != 1 || !strings.Contains(read.Problems[0], "HTTPS certificates are off") {
		t.Fatalf("file: %s", raw)
	}
	if err := reporter.Stopped(nil); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(file)
	read = Status{}
	_ = json.Unmarshal(raw, &read)
	if read.State != "stopped" || read.DNSName != "claw.tail1234.ts.net" || !read.MagicDNS || read.Problems != nil {
		t.Fatalf("stopped keeps the name and drops the problems: %s", raw)
	}
	if got := problems(Status{State: "needs-login"}); got != nil {
		t.Fatalf("a node not running has no tailnet problems yet: %v", got)
	}
}

var _ = net.Dial
