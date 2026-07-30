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
  // Only documents and dedicated worker entry scripts need isolation headers.
  // Leave WASM, runtime archives, streams, and other subresources on the
  // browser's direct fetch path; wrapping them is unnecessary and fragile in
  // Firefox.
  if (
    event.request.mode !== "navigate" &&
    event.request.destination !== "worker" &&
    event.request.destination !== "sharedworker"
  ) {
    return;
  }
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.status === 0 || response.type === "opaque") return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
