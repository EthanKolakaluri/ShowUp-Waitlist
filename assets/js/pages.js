/* ShowUp waitlist — shared bits for the success, refund and policy pages:
   footer year + contact link, price labels, and the fill-in fields on the
   policy pages (set them in assets/js/config.js). */
(function () {
  "use strict";

  var CFG = window.SHOWUP_CONFIG || {};
  function isSet(v) { return typeof v === "string" && v.trim() !== ""; }
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  if (isSet(CFG.PRICE_LABEL)) all(".price-label").forEach(function (el) { el.textContent = CFG.PRICE_LABEL; });
  if (isSet(CFG.REGULAR_PRICE_LABEL)) all(".regular-price-label").forEach(function (el) { el.textContent = CFG.REGULAR_PRICE_LABEL; });
  if (CFG.FOUNDING_CAP) all(".cap-label").forEach(function (el) { el.textContent = String(CFG.FOUNDING_CAP); });

  if (isSet(CFG.CONTACT_EMAIL)) {
    all(".contact-wrap").forEach(function (wrap) {
      var link = wrap.querySelector(".contact-link");
      if (link) { link.href = "mailto:" + CFG.CONTACT_EMAIL; link.textContent = CFG.CONTACT_EMAIL; wrap.hidden = false; }
    });
  }

  // <span data-fill="LEGAL_NAME">[placeholder]</span> → the value from config.js.
  // Anything still empty stays highlighted so it's easy to spot.
  all("[data-fill]").forEach(function (el) {
    var value = CFG[el.getAttribute("data-fill")];
    if (isSet(value)) { el.textContent = value; el.classList.remove("fill--empty"); }
    else el.classList.add("fill--empty");
  });
  all("[data-fill-email]").forEach(function (el) {
    if (isSet(CFG.CONTACT_EMAIL)) {
      el.textContent = CFG.CONTACT_EMAIL;
      el.setAttribute("href", "mailto:" + CFG.CONTACT_EMAIL);
      el.classList.remove("fill--empty");
    } else {
      el.removeAttribute("href");
      el.classList.add("fill--empty");
    }
  });
})();
