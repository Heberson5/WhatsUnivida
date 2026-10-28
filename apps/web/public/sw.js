// Deliberately does no caching — this app is entirely live data (chat
// messages, queue state, presence) over Socket.IO/REST, so caching any
// response here risks serving stale data instead of what's actually
// happening right now. Its only job is to exist and pass every request
// straight through to the network: some browsers (older Chrome/Android)
// only offer the "Add to Home Screen" install prompt once a fetch handler
// is registered, even one that changes nothing — see PROMPT: "abrir em
// layout de aplicativo".
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
