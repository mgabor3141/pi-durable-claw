package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Relay is the SSH server on the tailnet's port 22. Who may log in is the tailnet's answer (the Gate), so the client
// needs no key: the "none" method succeeds, as any user name, and every session lands in the workspace as its one user.
// Behind it the relay opens its own SSH connection to the workspace with the harness's key and passes everything
// through unchanged: sessions, exec, subsystems (sftp), port forwarding both ways, and global requests.
type Relay struct {
	Gate     *Gate
	HostKey  ssh.Signer
	Dial     func(ctx context.Context) (net.Conn, error)
	Upstream *ssh.ClientConfig
	Addr     string
	Logf     func(format string, args ...any)
}

func (r *Relay) serverConfig() *ssh.ServerConfig {
	config := &ssh.ServerConfig{NoClientAuth: true, ServerVersion: "SSH-2.0-claw-tailnet"}
	config.AddHostKey(r.HostKey)
	return config
}

// Serve accepts connections until the listener closes.
func (r *Relay) Serve(listener net.Listener) error {
	config := r.serverConfig()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go r.handle(conn, config)
	}
}

func (r *Relay) handle(conn net.Conn, config *ssh.ServerConfig) {
	defer conn.Close()
	ctx := context.Background()
	peer, err := r.Gate.Check(ctx, conn.RemoteAddr().String())
	if err != nil {
		r.Logf("ssh: refused: %v", err)
		return
	}
	client, clientChans, clientReqs, err := ssh.NewServerConn(conn, config)
	if err != nil {
		r.Logf("ssh: handshake with %s failed: %v", peer, err)
		return
	}
	defer client.Close()

	upstream, upstreamChans, upstreamReqs, err := r.dialUpstream(ctx)
	if err != nil {
		// Logged in, but nothing to land in: every channel is refused with the reason, which ssh prints.
		r.Logf("ssh: %s: workspace unreachable: %v", peer, err)
		go ssh.DiscardRequests(clientReqs)
		for channel := range clientChans {
			_ = channel.Reject(ssh.ConnectionFailed, "the workspace is unreachable: "+err.Error())
		}
		return
	}
	defer upstream.Close()
	r.Logf("ssh: %s connected", peer)

	go forwardGlobal(clientReqs, upstream)
	go forwardGlobal(upstreamReqs, client)
	go forwardChannels(clientChans, upstream)
	go forwardChannels(upstreamChans, client)
	done := make(chan struct{}, 2)
	go func() { _ = client.Wait(); done <- struct{}{} }()
	go func() { _ = upstream.Wait(); done <- struct{}{} }()
	<-done
	r.Logf("ssh: %s disconnected", peer)
}

func (r *Relay) dialUpstream(ctx context.Context) (ssh.Conn, <-chan ssh.NewChannel, <-chan *ssh.Request, error) {
	tcp, err := r.Dial(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	conn, chans, reqs, err := ssh.NewClientConn(tcp, r.Addr, r.Upstream)
	if err != nil {
		tcp.Close()
		return nil, nil, nil, err
	}
	return conn, chans, reqs, nil
}

// forwardGlobal passes global requests (port forwarding, keepalives) to the other side, with its answer.
func forwardGlobal(reqs <-chan *ssh.Request, to ssh.Conn) {
	for req := range reqs {
		ok, payload, err := to.SendRequest(req.Type, req.WantReply, req.Payload)
		if req.WantReply {
			_ = req.Reply(ok && err == nil, payload)
		}
	}
}

// forwardChannels opens each channel on the other side and joins the two; a refusal there is the refusal here.
func forwardChannels(chans <-chan ssh.NewChannel, to ssh.Conn) {
	for incoming := range chans {
		go func(incoming ssh.NewChannel) {
			out, outReqs, err := to.OpenChannel(incoming.ChannelType(), incoming.ExtraData())
			if err != nil {
				var refused *ssh.OpenChannelError
				if errors.As(err, &refused) {
					_ = incoming.Reject(refused.Reason, refused.Message)
				} else {
					_ = incoming.Reject(ssh.ConnectionFailed, err.Error())
				}
				return
			}
			in, inReqs, err := incoming.Accept()
			if err != nil {
				out.Close()
				return
			}
			join(in, inReqs, out, outReqs)
		}(incoming)
	}
}

// join passes a channel's data, stderr and requests both ways. A side's requests end when that side closes; the
// other side is closed once everything that side sent has been passed on, and once every answer owed to the other
// side has been given: a workspace answers "exec" and then closes, and a close passed on before that answer would
// fail the command.
func join(a ssh.Channel, aReqs <-chan *ssh.Request, b ssh.Channel, bReqs <-chan *ssh.Request) {
	aToB := pipe(b, a)
	bToA := pipe(a, b)
	owedToA, owedToB := newOwed(), newOwed()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); forwardRequests(aReqs, b, owedToA, aToB, owedToB) }()
	go func() { defer wg.Done(); forwardRequests(bReqs, a, owedToB, bToA, owedToA) }()
	wg.Wait()
}

// owed counts the answers still to be given to one side.
type owed struct {
	mu   sync.Mutex
	cond *sync.Cond
	n    int
}

func newOwed() *owed {
	o := &owed{}
	o.cond = sync.NewCond(&o.mu)
	return o
}

func (o *owed) add(delta int) {
	o.mu.Lock()
	o.n += delta
	if o.n == 0 {
		o.cond.Broadcast()
	}
	o.mu.Unlock()
}

func (o *owed) wait() {
	o.mu.Lock()
	for o.n > 0 {
		o.cond.Wait()
	}
	o.mu.Unlock()
}

func pipe(dst, src ssh.Channel) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = io.Copy(dst, src) }()
		go func() { defer wg.Done(); _, _ = io.Copy(dst.Stderr(), src.Stderr()) }()
		wg.Wait()
		_ = dst.CloseWrite()
		close(done)
	}()
	return done
}

// forwardRequests passes one side's requests to the other and their answers back (`owedBack` counts those). When the
// side closes, the other is closed after its data is through (`sent`) and after the answers owed to it (`owedTo`).
func forwardRequests(reqs <-chan *ssh.Request, to ssh.Channel, owedBack *owed, sent <-chan struct{}, owedTo *owed) {
	for req := range reqs {
		if req.WantReply {
			owedBack.add(1)
		}
		ok, err := to.SendRequest(req.Type, req.WantReply, req.Payload)
		if req.WantReply {
			_ = req.Reply(ok && err == nil, nil)
			owedBack.add(-1)
		}
	}
	<-sent
	owedTo.wait()
	_ = to.Close()
}

// aliasHostKeys checks the workspace's key under the name pi-env stored it as (its `hostKeyAlias`), whatever address
// the relay dials.
func aliasHostKeys(check ssh.HostKeyCallback, alias string) ssh.HostKeyCallback {
	return func(_ string, remote net.Addr, key ssh.PublicKey) error {
		if err := check(net.JoinHostPort(alias, "22"), remote, key); err != nil {
			return fmt.Errorf("the workspace's host key does not match the one the harness trusts: %w", err)
		}
		return nil
	}
}
