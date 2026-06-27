/* anchord site — theme + language + docs nav (shared by index.html and docs.html) */
(function () {
  var root = document.documentElement;

  /* ---- theme: persist per device, mirror the app's data-theme contract ---- */
  var savedTheme = localStorage.getItem("anchord-theme");
  if (savedTheme) root.setAttribute("data-theme", savedTheme);
  var themeBtn = document.getElementById("theme");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem("anchord-theme", next);
    });
  }

  /* ---- language: default from the browser, overridable, persisted ---- */
  function browserLang() {
    var l = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    return l.toLowerCase().indexOf("vi") === 0 ? "vi" : "en";
  }
  var lang = localStorage.getItem("anchord-lang") || browserLang();
  var langBtn = document.getElementById("lang");
  function applyLang(l) {
    lang = l;
    root.setAttribute("data-lang", l);
    root.setAttribute("lang", l);
    localStorage.setItem("anchord-lang", l);
    if (langBtn) {
      langBtn.innerHTML =
        '<span class="' + (l === "en" ? "on" : "") + '">EN</span>' +
        '<span style="color:var(--faint)">/</span>' +
        '<span class="' + (l === "vi" ? "on" : "") + '">VI</span>';
      langBtn.setAttribute("aria-label", l === "en" ? "Switch to Vietnamese" : "Chuyển sang tiếng Anh");
    }
  }
  applyLang(lang);
  if (langBtn) langBtn.addEventListener("click", function () { applyLang(lang === "en" ? "vi" : "en"); });

  /* ---- hero demo: fake viewer + MCP terminal, looping ---- */
  (function () {
    var demo = document.getElementById("demo");
    if (!demo) return;
    var termEl = demo.querySelector("#demo-term");
    var verEl = demo.querySelector("#demo-ver");
    var lines = demo.querySelectorAll("[data-line]");
    var toolsWrap = demo.querySelector("[data-tools]");
    var tools = demo.querySelectorAll("[data-tool]");
    var changeP = demo.querySelector("[data-change]");
    var badge = demo.querySelector("[data-badge]");
    var reply = demo.querySelector("[data-reply]");
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var markBy = function (t) { return demo.querySelector('mark[data-mark="' + t + '"]'); };
    var cardBy = function (t) { return demo.querySelector('[data-card="' + t + '"]'); };
    // the 5 annotation tools, in apply order (Markup = the neutral parent, then each type)
    var TYPES = ["comment", "redline", "label", "like"];

    function setTool(name) {
      tools.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tool") === name); });
    }
    function reset() {
      termEl.innerHTML = "";
      verEl.textContent = "v1"; verEl.classList.remove("bump");
      lines.forEach(function (l) { l.classList.remove("in"); });
      demo.querySelectorAll("mark").forEach(function (m) { m.classList.remove("in", "resolved"); });
      demo.querySelectorAll("[data-card]").forEach(function (c) { c.classList.remove("in", "resolved"); });
      tools.forEach(function (t) { t.classList.remove("active"); });
      toolsWrap.classList.remove("in");
      changeP.classList.remove("changed");
      if (reply) reply.classList.remove("in");
      if (badge) badge.textContent = "comment";
    }
    function addLine(cls) {
      var d = document.createElement("div");
      d.className = "demo__line" + (cls ? " " + cls : "");
      termEl.appendChild(d);
      while (termEl.children.length > 7) termEl.removeChild(termEl.firstChild);
      return d;
    }
    function caret(el) { var c = document.createElement("span"); c.className = "demo__caret"; c.innerHTML = "&nbsp;"; el.appendChild(c); return c; }
    async function type(cmd) {
      var d = addLine();
      var pr = document.createElement("span"); pr.className = "pr"; pr.textContent = "$ "; d.appendChild(pr);
      var c = document.createElement("span"); c.className = "cmd"; d.appendChild(c);
      var car = caret(d);
      for (var i = 0; i < cmd.length; i++) { c.textContent += cmd[i]; await sleep(26); }
      car.remove();
      await sleep(240);
    }
    function out(text, cls) { addLine("out " + (cls || "")).textContent = text; }

    function showFinal() {
      lines.forEach(function (l) { l.classList.add("in"); });
      demo.querySelectorAll("mark").forEach(function (m) { m.classList.add("in"); });
      demo.querySelectorAll("[data-card]").forEach(function (c) { c.classList.add("in"); });
      toolsWrap.classList.add("in"); setTool("comment");
      changeP.classList.add("changed"); verEl.textContent = "v2";
      if (reply) reply.classList.add("in");
      cardBy("comment").classList.add("resolved"); markBy("comment").classList.add("resolved");
      cardBy("redline").classList.add("resolved");
      if (badge) badge.textContent = "resolved";
      ["$ anchord create_document spec.md", "✓ published · checkout-api · v1",
       "$ anchord pull_annotations", "← 4 annotations · 1 redline",
       "$ anchord patch_document --block p2", "✓ v2 · +1 −1",
       "$ anchord resolve_comment ann_42", "✓ resolved"].forEach(function (t, i) {
        var d = addLine(i % 2 ? (t[0] === "✓" ? "out ok" : "out recv") : "");
        if (i % 2) d.textContent = t;
        else { d.innerHTML = '<span class="pr">$ </span><span class="cmd">' + t.slice(2) + '</span>'; }
      });
    }

    async function run() {
      while (true) {
        reset();
        await sleep(500);
        // 1 — agent publishes; the doc fades in
        await type("anchord create_document spec.md");
        out("✓ published · checkout-api · v1", "ok");
        lines.forEach(function (l, i) { setTimeout(function () { l.classList.add("in"); }, i * 120); });
        await sleep(850);
        // 2 — reviewers pick up the markup toolbar and apply the 5 tools, one per type
        toolsWrap.classList.add("in"); setTool("markup");
        await sleep(750);
        for (var i = 0; i < TYPES.length; i++) {
          var t = TYPES[i];
          setTool(t);
          var m = markBy(t); if (m) m.classList.add("in");
          var c = cardBy(t); if (c) c.classList.add("in");
          await sleep(900);
        }
        await sleep(400);
        // 3 — agent pulls the feedback and revises (the redline becomes the patch)
        await type("anchord pull_annotations");
        out("← 4 annotations · 1 redline", "recv");
        await sleep(900);
        await type("anchord reply_comment ann_42");
        if (reply) reply.classList.add("in");
        out("✓ replied to Priya", "ok");
        await sleep(1000);
        await type("anchord patch_document --block p2");
        changeP.classList.add("changed");
        cardBy("redline").classList.add("resolved");
        verEl.textContent = "v2"; verEl.classList.add("bump");
        out("✓ v2 · +1 −1", "ok");
        await sleep(1000);
        await type("anchord resolve_comment ann_42");
        cardBy("comment").classList.add("resolved"); markBy("comment").classList.add("resolved");
        if (badge) badge.textContent = "resolved";
        out("✓ resolved", "ok");
        await sleep(3400);
      }
    }

    if (reduce) { showFinal(); } else { run(); }
  })();

  /* ---- docs: mobile sidebar drawer (only present on docs.html) ---- */
  var side = document.getElementById("side");
  var menu = document.getElementById("menu");
  if (side && menu) {
    menu.addEventListener("click", function (e) { e.stopPropagation(); side.classList.toggle("open"); });
    side.addEventListener("click", function (e) { if (e.target.tagName === "A") side.classList.remove("open"); });
    document.addEventListener("click", function (e) {
      if (window.innerWidth <= 860 && !side.contains(e.target) && e.target !== menu) side.classList.remove("open");
    });
  }

  /* ---- lightbox: click a screenshot to enlarge; click again to zoom in/out ---- */
  (function () {
    var box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML =
      '<button class="lightbox__close" aria-label="Close">✕</button>' +
      '<img alt="" />' +
      '<div class="lightbox__hint"></div>';
    document.body.appendChild(box);
    var img = box.querySelector("img");
    var hint = box.querySelector(".lightbox__hint");
    var closeBtn = box.querySelector(".lightbox__close");

    function hintText() {
      var vi = root.getAttribute("data-lang") === "vi";
      return box.classList.contains("zoomed")
        ? (vi ? "Bấm ảnh để thu nhỏ · Esc để đóng" : "Click image to zoom out · Esc to close")
        : (vi ? "Bấm ảnh để phóng to · Esc để đóng" : "Click image to zoom in · Esc to close");
    }
    function open(src, alt) {
      img.src = src; img.alt = alt || "";
      box.classList.remove("zoomed");
      box.classList.add("open");
      hint.textContent = hintText();
      document.body.style.overflow = "hidden";
    }
    function close() {
      box.classList.remove("open", "zoomed");
      document.body.style.overflow = "";
      img.src = "";
    }
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (t.tagName === "IMG" && t.closest(".shot")) { open(t.src, t.alt); }
    });
    img.addEventListener("click", function (e) {
      e.stopPropagation();
      box.classList.toggle("zoomed");
      box.scrollTo(0, 0);
      hint.textContent = hintText();
    });
    box.addEventListener("click", function (e) { if (e.target === box) close(); });
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && box.classList.contains("open")) close(); });
  })();

  /* ---- docs: scroll-spy on the sidebar TOC ---- */
  if (side) {
    var links = Array.prototype.slice.call(side.querySelectorAll("a[href^='#']"));
    var map = {};
    links.forEach(function (a) {
      var el = document.getElementById(a.getAttribute("href").slice(1));
      if (el) map[a.getAttribute("href").slice(1)] = a;
    });
    if (window.IntersectionObserver) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            links.forEach(function (a) { a.classList.remove("active"); });
            var a = map[en.target.id];
            if (a) { a.classList.add("active"); a.scrollIntoView({ block: "nearest" }); }
          }
        });
      }, { rootMargin: "-72px 0px -65% 0px", threshold: 0 });
      Object.keys(map).forEach(function (id) { obs.observe(document.getElementById(id)); });
    }
  }
})();
