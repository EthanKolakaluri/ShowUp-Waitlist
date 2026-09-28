/* ShowUp waitlist — payment confirmation page */
(function () {
  "use strict";

  var CFG = window.SHOWUP_CONFIG || {};
  var STORE_KEY = "showup_reservation";

  function $(sel) { return document.querySelector(sel); }
  function isSet(v) { return typeof v === "string" && v.trim() !== ""; }
  function reducedMotion() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

  function readLocal() {
    try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || "null"); } catch (e) { return null; }
  }

  function show(id) {
    ["#state-checking", "#state-done", "#state-error"].forEach(function (s) {
      var el = $(s);
      if (el) el.hidden = s !== id;
    });
  }

  function addChip(text) {
    var meta = $("#done-meta");
    if (!meta || !isSet(text)) return;
    var span = document.createElement("span");
    span.textContent = text;
    meta.appendChild(span);
  }

  function confetti() {
    if (reducedMotion()) return;
    var colors = ["#FF5B35", "#FFC23D", "#FF9E80", "#C8401C", "#FFE4D9"];
    var box = document.createElement("div");
    box.className = "confetti";
    box.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 90; i++) {
      var p = document.createElement("i");
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      p.style.setProperty("--x", (Math.random() * 30 - 15) + "vw");
      p.style.setProperty("--r", (Math.random() * 900 - 450) + "deg");
      p.style.setProperty("--t", (2.4 + Math.random() * 1.8) + "s");
      p.style.setProperty("--delay", (Math.random() * 0.6) + "s");
      if (i % 3 === 0) { p.style.width = "8px"; p.style.height = "8px"; p.style.borderRadius = "50%"; }
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 5200);
  }

  function done(info) {
    if (info && info.refunded) { fail("refunded"); return; }
    var local = readLocal() || {};
    var name = (info && info.firstName) || local.firstName;
    var city = (info && info.city) || local.city;
    if (isSet(name)) $("#done-title").textContent = "You're in, " + name + ".";
    if (info && info.spot && isSet(city)) addChip("Founding spot #" + info.spot + " in " + city);
    else if (isSet(city)) addChip("Founding member · " + city);
    if (info && info.ref) addChip("Ref " + info.ref);
    else if (isSet(local.ref)) addChip("Ref " + local.ref);
    // Private refund link (only while self-serve refunds are open).
    if (info && isSet(info.refundToken) && isSet(info.ref)) {
      $("#refund-link").href = "refund.html?ref=" + encodeURIComponent(info.ref) + "&t=" + encodeURIComponent(info.refundToken);
      $("#refund-note").hidden = false;
    }
    show("#state-done");
    confetti();
  }

  function fail(reason) {
    var titles = {
      not_paid: "Your payment isn't complete yet",
      missing_session: "We couldn't find your checkout",
      refunded: "This reservation was refunded"
    };
    if (titles[reason]) $("#error-title").textContent = titles[reason];
    if (reason === "missing_session") {
      $("#error-lead").textContent = "This page opens after checkout. If you haven't reserved yet, head back to the form.";
    }
    if (reason === "refunded") {
      $("#error-lead").textContent = "Your refund is on its way to your card. Changed your mind? You can reserve again while founding spots last.";
      $("#retry-btn").hidden = true;
    }
    if (isSet(CFG.CONTACT_EMAIL)) {
      var c = $("#error-contact");
      c.textContent = "Questions? Email " + CFG.CONTACT_EMAIL + ".";
      c.hidden = false;
    }
    show("#state-error");
  }

  function confirm(sessionId) {
    show("#state-checking");
    // Without a Sheet connection there's nothing to check against; Stripe only
    // redirects here after a completed payment, so show the confirmation.
    if (!isSet(CFG.SHEETS_WEB_APP_URL)) { setTimeout(function () { done(null); }, 600); return; }

    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 20000);

    fetch(CFG.SHEETS_WEB_APP_URL, {
      method: "POST",
      body: JSON.stringify({ action: "confirm", session_id: sessionId }),
      redirect: "follow",
      signal: controller ? controller.signal : undefined
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        clearTimeout(timer);
        if (data && data.ok) done(data);
        else fail(data && data.error);
      })
      .catch(function () { clearTimeout(timer); fail("network"); });
  }

  function initShare() {
    var btn = $("#share-btn");
    if (!btn) return;
    var url = window.location.origin + window.location.pathname.replace(/success\.html$/, "");
    btn.addEventListener("click", function () {
      var text = "I just reserved a Founding 500 spot on ShowUp. Your crew, planned for you.";
      if (navigator.share) { navigator.share({ title: "ShowUp", text: text, url: url }).catch(function () {}); return; }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          btn.textContent = "Link copied";
          setTimeout(function () { btn.textContent = "Invite a friend"; }, 2000);
        });
      }
    });
  }

  function init() {
    if (isSet(CFG.PRICE_LABEL)) {
      Array.prototype.forEach.call(document.querySelectorAll(".price-label"), function (el) { el.textContent = CFG.PRICE_LABEL; });
    }
    initShare();
    var params = new URLSearchParams(window.location.search);
    var sessionId = params.get("session_id") || "";
    var retry = $("#retry-btn");
    if (retry) retry.addEventListener("click", function () { if (sessionId) confirm(sessionId); else window.location.href = "./#reserve"; });
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) { fail("missing_session"); return; }
    confirm(sessionId);
  }

  init();
})();
