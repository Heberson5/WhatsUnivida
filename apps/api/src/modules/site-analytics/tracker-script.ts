/**
 * The tracking snippet another site loads (GET /api/public/site/tracker.js):
 *
 *   <script async src="https://<este sistema>/api/public/site/tracker.js"></script>
 *
 * One visit per page load; while the tab is visible it sends a sign of life every 15 s with the seconds actually in
 * front of the visitor, and a last one when the tab is hidden or closed. Respects "Do Not Track" / Global Privacy
 * Control (nothing is sent). No cookie: a random id in localStorage tells new from returning visitors.
 * Plain ES5 on purpose — it runs on any site, in any browser.
 */
export const TRACKER_SCRIPT = `(function () {
  try {
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl) return;
    var script = document.currentScript;
    if (!script || !script.src) return;
    var api = new URL(script.src).origin + "/api/public/site";
    var rand = function () { return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2); };
    var vid;
    try { vid = localStorage.getItem("wa_site_vid"); if (!vid) { vid = rand(); localStorage.setItem("wa_site_vid", vid); } } catch (e) { vid = rand(); }
    var visitId = null, active = 0, last = Date.now(), visible = document.visibilityState !== "hidden";
    var tick = function () { var now = Date.now(); if (visible) active += (now - last) / 1000; last = now; };
    var post = function (path, body, beacon) {
      var data = JSON.stringify(body);
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(api + path, data); return; }
      return fetch(api + path, { method: "POST", body: data, keepalive: true, headers: { "Content-Type": "text/plain" } })
        .then(function (r) { return r.status === 201 ? r.json() : null; })
        .catch(function () { return null; });
    };
    var ping = function (beacon) { tick(); if (visitId) post("/visits/" + visitId + "/ping", { seconds: Math.round(active), ended: beacon }, beacon); };
    var start = post("/visits", { visitorId: vid, url: location.href, title: document.title, referrer: document.referrer || null });
    if (start) start.then(function (r) { visitId = r && r.id; });
    setInterval(function () { if (visible) ping(false); }, 15000);
    document.addEventListener("visibilitychange", function () {
      tick();
      visible = document.visibilityState !== "hidden";
      if (!visible) ping(true);
    });
    window.addEventListener("pagehide", function () { ping(true); });
  } catch (e) {}
})();
`;
