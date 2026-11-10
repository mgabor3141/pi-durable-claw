package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// Proxy is the tailnet's HTTPS side: the harness's T3 app and API, WebSockets included, as Tailscale Serve forwards
// them. The Host header is kept, so the bridge's same-origin check sees the tailnet name the browser used.
func Proxy(upstream *url.URL, gate *Gate, logf func(string, ...any)) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(upstream)
			request.Out.Host = request.In.Host
			request.SetXForwarded()
		},
		FlushInterval: -1,
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, err error) {
			logf("https: the harness did not answer: %v", err)
			http.Error(writer, "claw's harness is not answering", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if _, err := gate.Check(request.Context(), request.RemoteAddr); err != nil {
			logf("https: refused: %v", err)
			http.Error(writer, "This tailnet account may not use this claw. Its owner can add it with CLAW_TAILNET_ALLOW.", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(writer, request)
	})
}
