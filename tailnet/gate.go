package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
)

// Peer is who a tailnet connection comes from: a user's login, or a tagged device's tags.
type Peer struct {
	Login string
	Tags  []string
}

func (p Peer) String() string {
	if len(p.Tags) > 0 {
		return strings.Join(p.Tags, ",")
	}
	return p.Login
}

// Gate decides who may reach this node at all, before T3's pairing or anything else: the account that owns the node
// (the one that logged it in), and whoever the allow list names (logins, or tags such as "tag:ci").
type Gate struct {
	WhoIs func(ctx context.Context, remoteAddr string) (Peer, error)
	Allow []string

	mu    sync.Mutex
	owner string
}

// SetOwner records the node's owner; "" for a tagged node, which only the allow list opens.
func (g *Gate) SetOwner(login string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.owner = login
}

func (g *Gate) Owner() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.owner
}

// Check answers the peer when it is allowed, else an error that says why (safe to log).
func (g *Gate) Check(ctx context.Context, remoteAddr string) (Peer, error) {
	peer, err := g.WhoIs(ctx, remoteAddr)
	if err != nil {
		return Peer{}, fmt.Errorf("unknown peer %s: %w", remoteAddr, err)
	}
	if len(peer.Tags) > 0 {
		for _, tag := range peer.Tags {
			if slices.Contains(g.Allow, tag) {
				return peer, nil
			}
		}
		return peer, fmt.Errorf("%s is a tagged device not on the allow list", peer)
	}
	if owner := g.Owner(); peer.Login != "" && (peer.Login == owner || slices.Contains(g.Allow, peer.Login)) {
		return peer, nil
	}
	return peer, fmt.Errorf("%s is not this node's owner or on the allow list", peer)
}
