/*
 * Cross-origin isolation for static hosts (GitHub Pages) that cannot send
 * COOP/COEP headers. Registered only when the page is not already isolated
 * (dev/preview send the headers directly). Mirrors the well-known
 * coi-serviceworker approach, with COEP credentialless so the Pyodide CDN
 * script keeps loading without CORP.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  // Let the browser handle cross-origin no-cors requests (credentialsless
  // mode covers them); we only need to upgrade same-origin responses.
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 0 || response.type === "opaque") return response;
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(() => fetch(event.request)),
  );
});
