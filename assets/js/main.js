/* ShowUp waitlist — landing page behavior */
(function () {
  "use strict";

  var CFG = window.SHOWUP_CONFIG || {};
  var STORE_KEY = "showup_reservation";

  /* ---------- Small helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function isSet(v) { return typeof v === "string" && v.trim() !== ""; }
  function reducedMotion() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

  function saveLocal(data) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } })
             .catch(function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
  }

  // POST to Google Apps Script. Plain-text body avoids a CORS preflight.
  function postToSheet(payload) {
    if (!isSet(CFG.SHEETS_WEB_APP_URL)) return Promise.resolve(null);
    return fetch(CFG.SHEETS_WEB_APP_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      redirect: "follow"
    }).then(function (r) { return r.json(); });
  }

  function makeRef() {
    var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var out = "";
    var bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < bytes.length; j++) out += alphabet[bytes[j] % alphabet.length];
    return "SU-" + out;
  }

  /* ---------- Config-driven labels ---------- */
  function applyLabels() {
    if (isSet(CFG.PRICE_LABEL)) $all(".price-label").forEach(function (el) { el.textContent = CFG.PRICE_LABEL; });
    if (isSet(CFG.REGULAR_PRICE_LABEL)) $all(".regular-price-label").forEach(function (el) { el.textContent = CFG.REGULAR_PRICE_LABEL; });
    if (CFG.FOUNDING_CAP) $all(".cap-label").forEach(function (el) { el.textContent = String(CFG.FOUNDING_CAP); });
    var year = $("#year");
    if (year) year.textContent = String(new Date().getFullYear());
    if (isSet(CFG.CONTACT_EMAIL)) {
      var wrap = $(".contact-wrap"), link = $(".contact-link");
      if (wrap && link) { link.href = "mailto:" + CFG.CONTACT_EMAIL; link.textContent = CFG.CONTACT_EMAIL; wrap.hidden = false; }
    }
  }

  /* ---------- Nav shadow ---------- */
  function initNav() {
    var nav = $("#nav");
    if (!nav) return;
    var onScroll = function () { nav.classList.toggle("is-scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------- Reveal on scroll + count-up ---------- */
  function countUp(el) {
    var target = parseInt(el.getAttribute("data-count"), 10) || 0;
    if (reducedMotion()) { el.textContent = String(target); return; }
    var start = null, dur = 1400;
    function tick(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function initReveal() {
    var els = $all(".reveal, .reveal-line");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      $all("[data-count]").forEach(countUp);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.classList.add("in");
        $all("[data-count]", el).forEach(countUp);
        io.unobserve(el);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Cities + founding spots ---------- */
  var counts = null;

  function cityList() {
    var list = Array.isArray(CFG.CITIES) ? CFG.CITIES : [];
    return list.filter(function (c) { return isSet(c); });
  }

  function realCities() {
    return cityList().filter(function (c) { return c.toLowerCase() !== "other"; });
  }

  function initCityField() {
    var select = $("#city-select"), text = $("#city-text");
    if (!select || !text) return;
    var cities = cityList();
    if (realCities().length === 0) {
      // No launch cities configured yet: free-text city.
      select.hidden = true; select.required = false; select.disabled = true;
      text.hidden = false; text.required = true;
      return;
    }
    var html = '<option value="" selected disabled>Choose your city</option>';
    cities.forEach(function (c) {
      var safe = c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      html += '<option value="' + safe + '">' + safe + "</option>";
    });
    select.innerHTML = html;
    select.addEventListener("change", function () {
      var other = select.value.toLowerCase() === "other";
      text.hidden = !other; text.required = other;
      if (other) text.focus();
      showCitySpots(select.value);
    });
  }

  function spotsLeft(city) {
    var cap = Number(CFG.FOUNDING_CAP) || 500;
    var taken = counts && counts.cities && counts.cities[city] ? Number(counts.cities[city]) : 0;
    return { cap: cap, taken: taken, left: Math.max(0, cap - taken) };
  }

  function showCitySpots(city) {
    var el = $("#city-spots");
    if (!el) return;
    if (!counts || !isSet(city) || city.toLowerCase() === "other") { el.hidden = true; return; }
    var s = spotsLeft(city);
    el.textContent = s.left + " of " + s.cap + " founding spots left in " + city;
    el.hidden = false;
  }

  function renderSpots() {
    var box = $("#spots"), list = $("#spots-list");
    var cities = realCities();
    if (!box || !list || !counts || cities.length === 0) return;
    list.innerHTML = "";
    cities.forEach(function (city) {
      var s = spotsLeft(city);
      var row = document.createElement("div");
      row.innerHTML = '<div class="spot__row"><span></span><span></span></div><div class="bar"><div class="bar__fill"></div></div>';
      row.querySelector(".spot__row span").textContent = city;
      row.querySelector(".spot__row span:last-child").textContent = s.left + " of " + s.cap + " left";
      list.appendChild(row);
      var fill = row.querySelector(".bar__fill");
      requestAnimationFrame(function () { fill.style.width = Math.min(100, (s.taken / s.cap) * 100) + "%"; });
    });
    box.hidden = false;
  }

  function loadCounts() {
    if (!isSet(CFG.SHEETS_WEB_APP_URL)) return;
    var url = CFG.SHEETS_WEB_APP_URL + (CFG.SHEETS_WEB_APP_URL.indexOf("?") > -1 ? "&" : "?") + "action=counts";
    withTimeout(fetch(url).then(function (r) { return r.json(); }), 8000).then(function (data) {
      if (!data || !data.ok) return;
      counts = data;
      renderSpots();
      var select = $("#city-select");
      if (select && !select.hidden) showCitySpots(select.value);
    });
  }

  /* ---------- Reserve form ---------- */
  function fieldWrap(input) { return input.closest(".field") || input.closest(".check-row"); }

  function setInvalid(input, bad) {
    var wrap = fieldWrap(input);
    if (wrap) wrap.classList.toggle("is-invalid", bad);
    input.setAttribute("aria-invalid", bad ? "true" : "false");
  }

  function showFormError(msg) {
    var el = $("#form-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  function validate(form) {
    var ok = true, first = null;
    var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    $all("input, select", form).forEach(function (input) {
      if (input.disabled || input.hidden || input.type === "checkbox" && input.name === "interests") return;
      var bad = false;
      if (input.type === "checkbox") bad = input.required && !input.checked;
      else if (input.required) bad = !isSet(input.value);
      if (!bad && input.type === "email") bad = !emailRe.test(input.value.trim());
      setInvalid(input, bad);
      if (bad) { ok = false; if (!first) first = input; }
    });
    if (first) first.focus();
    return ok;
  }

  function collect(form) {
    var fd = new FormData(form);
    var citySelect = $("#city-select");
    var city = "";
    if (citySelect && !citySelect.hidden && citySelect.value.toLowerCase() !== "other") city = citySelect.value;
    else city = (fd.get("cityText") || "").toString().trim();
    return {
      firstName: (fd.get("firstName") || "").toString().trim(),
      email: (fd.get("email") || "").toString().trim(),
      city: city,
      age: (fd.get("age") || "").toString(),
      interests: fd.getAll("interests").join(", ")
    };
  }

  function stopLoading(btn) {
    btn.classList.remove("is-loading");
    btn.removeAttribute("aria-busy");
  }

  function checkoutErrorMessage(res) {
    var contact = isSet(CFG.CONTACT_EMAIL) ? " If it keeps happening, email " + CFG.CONTACT_EMAIL + "." : "";
    if (res && (res.error === "server_not_configured" || res.error === "checkout_not_configured")) {
      return "Checkout isn't set up yet. Finish the steps in STRIPE_INTEGRATION_TODO.md.";
    }
    if (res && res.error === "bad_email") return "That email doesn't look right. Please check it and try again.";
    return "We couldn't open checkout just now. Please try again in a moment." + contact;
  }

  function initForm() {
    var form = $("#reserve-form"), btn = $("#reserve-btn");
    if (!form || !btn) return;

    form.addEventListener("input", function (e) {
      if (e.target && e.target.getAttribute("aria-invalid") === "true") setInvalid(e.target, false);
    });
    form.addEventListener("change", function (e) {
      if (e.target && e.target.type === "checkbox" && e.target.required) setInvalid(e.target, !e.target.checked);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      showFormError("");
      if (!validate(form)) { showFormError("Please fill in the highlighted fields."); return; }

      if (!isSet(CFG.SHEETS_WEB_APP_URL)) {
        showFormError("Checkout isn't connected yet. Add your Apps Script URL in assets/js/config.js.");
        return;
      }

      var data = collect(form);
      data.ref = makeRef();
      data.startedAt = new Date().toISOString();
      saveLocal(data);

      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");

      // The Apps Script logs the checkout start in the Sheet and creates the
      // Stripe Checkout Session, then we send the visitor to Stripe's page.
      var payload = {
        action: "checkout",
        ref: data.ref,
        firstName: data.firstName,
        email: data.email,
        city: data.city,
        age: data.age,
        interests: data.interests,
        page: window.location.href.split("#")[0]
      };
      withTimeout(postToSheet(payload), 20000).then(function (res) {
        if (res && res.ok && typeof res.url === "string" && /^https:\/\//.test(res.url)) {
          window.location.href = res.url;
          return;
        }
        stopLoading(btn);
        showFormError(checkoutErrorMessage(res));
      });
    });

    // Restore the button if the user comes back with the browser's back button.
    window.addEventListener("pageshow", function () { stopLoading(btn); });
  }

  document.documentElement.classList.remove("no-js");
  applyLabels();
  initNav();
  initReveal();
  initCityField();
  initForm();
  loadCounts();
})();
