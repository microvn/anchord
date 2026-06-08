// Standalone fixture server for the S-002 sandbox E2E (driven by Playwright).
// Not shipped — it seeds one untrusted HTML doc and serves it through the real
// sandbox route + a viewer page that records postMessage results so the test can
// read JS-ran (AS-006) and isolation (AS-007) outcomes from the main frame.
import { contentHeaders, sandboxIframe } from "./sandbox";

// Untrusted doc: proves JS runs, then tries to read the parent app's DOM/cookies.
const MALICIOUS = `<!doctype html><html><body>
<p id="status">init</p>
<script>
  document.getElementById('status').textContent='js-ran';   // AS-006: scripts execute
  var isolation='blocked';
  try { var c = parent.document.cookie; isolation='LEAKED:'+c; } catch(e) { isolation='blocked'; }
  // postMessage crosses the sandbox boundary (this is the annotation-core bridge premise)
  parent.postMessage({ ran:true, isolation:isolation, status:document.getElementById('status').textContent }, '*');
</script>
</body></html>`;

const VIEWER = `<!doctype html><html><body>
<script>
  window.__result = { received:false };
  addEventListener('message', function(e){
    window.__result = Object.assign({ received:true }, e.data);
  });
</script>
${sandboxIframe("/v/vtest")}
</body></html>`;

Bun.serve({
  port: Number(process.env.PORT ?? 3211),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/d/test") {
      // set an app-origin cookie the sandboxed doc must NOT be able to read
      return new Response(VIEWER, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "app_session=secret; Path=/" },
      });
    }
    if (url.pathname === "/v/vtest") {
      return new Response(MALICIOUS, { headers: contentHeaders() });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`e2e-fixture on ${process.env.PORT ?? 3211}`);
