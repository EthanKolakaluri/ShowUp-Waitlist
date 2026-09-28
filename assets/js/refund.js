/* ShowUp waitlist — self-serve refund page (refund.html?ref=…&t=…)
   The link comes from the confirmation email or the success page. The
   Apps Script checks the link's signature before showing or refunding
   anything, and makes the refund in Stripe. */
(function () {
  "use strict";

  var CFG = window.SHOWUP_CONFIG || {};
  var STATES = ["#state-checking", "#state-confirm", "#state-working", "#state-done", "#state-message"];
  var params = new URLSearchParams(window.location.search);
  var ref = params.get("ref") || "";
  var token = params.get("t") || "";

  function $(sel) { return document.querySelector(sel); }
  function isSet(v) { return typeof v === "string" && v.trim() !== ""; }

  function show(id) {
    STATES.forEach(function (s) { var el = $(s); if (el) el.hidden = s !== id; });
    var el = $(id);
    var h = el && el.querySelector("h1");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }

  function money(amount, currency) {
    var n = (Number(amount) || 0).toFixed(2);
    var cur = String(currency || "USD").toUpperCase();
    return cur === "USD" ? "$" + n : n + " " + cur;
  }

  function contactLine() {
    return isSet(CFG.CONTACT_EMAIL)
      ? " Email " + CFG.CONTACT_EMAIL + " and we'll sort it out."
      : " Reply to your confirmation email and we'll sort it out.";
  }

  function message(kind, data) {
    var copy = {
      bad_link: ["This refund link doesn't work", "Use the “Refund my reservation” link in your confirmation email." + contactLine()],
      refunded: ["Already refunded", "This reservation was refunded" + (data && data.refundedAt ? " on " + data.refundedAt : "") + ". It can take 5–10 business days to show up on your statement."],
      closed: ["Refunds by link have closed", "ShowUp has launched, so your payment now covers your first month, and the Show-Up Guarantee has your back." + contactLine()],
      failed: ["We couldn't process your refund", "Nothing was charged or changed. Please try again in a moment." + contactLine()],
      network: ["We couldn't reach ShowUp", "Check your connection and try again. Nothing was changed."]
    }[kind] || null;
    if (!copy) copy = ["Something went wrong", "Please try again in a moment." + contactLine()];
    $("#msg-title").textContent = copy[0];
    $("#msg-lead").textContent = copy[1];
    $("#msg-retry").hidden = !(kind === "failed" || kind === "network");
    show("#state-message");
  }

  function post(body) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 25000);
    return fetch(CFG.SHEETS_WEB_APP_URL, {
      method: "POST",
      body: JSON.stringify(body),
      redirect: "follow",
      signal: controller ? controller.signal : undefined
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { clearTimeout(timer); return data || {}; }, function (err) { clearTimeout(timer); throw err; });
  }

  function addFact(list, text) {
    var li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  }

  function renderConfirm(d) {
    var price = money(d.amount, d.currency);
    $("#confirm-title").textContent = isSet(d.firstName) ? "Refund your reservation, " + d.firstName + "?" : "Refund your reservation?";
    $("#confirm-lead").textContent = "You'll get " + price + " back on the card you paid with.";
    var list = $("#confirm-facts");
    list.textContent = "";
    addFact(list, d.spot && isSet(d.city)
      ? "Founding spot #" + d.spot + " in " + d.city + " goes to the next person."
      : "Your founding spot goes to the next person.");
    addFact(list, "You give up the founding price of " + price + "/mo, locked in for members.");
    addFact(list, "Refunds usually show up in 5–10 business days.");
    $("#refund-btn").textContent = "Refund " + price;
    $("#refund-btn").disabled = false;
    show("#state-confirm");
  }

  function load() {
    show("#state-checking");
    post({ action: "refund_status", ref: ref, t: token })
      .then(function (d) {
        if (!d.ok) { message(d.error === "bad_link" ? "bad_link" : "failed"); return; }
        if (d.status === "refunded") { message("refunded", d); return; }
        if (!d.refundsOpen) { message("closed"); return; }
        renderConfirm(d);
      })
      .catch(function () { message("network"); });
  }

  function refund() {
    $("#refund-btn").disabled = true;
    show("#state-working");
    post({ action: "refund", ref: ref, t: token })
      .then(function (d) {
        if (d.ok) {
          $("#done-lead").textContent = d.already
            ? "This reservation was already refunded. It can take 5–10 business days to show up on your statement."
            : "We've sent " + money(d.amount, d.currency) + " back to your card. It usually shows up in 5–10 business days, and we've emailed you a confirmation.";
          show("#state-done");
          return;
        }
        message({ bad_link: "bad_link", refunds_closed: "closed" }[d.error] || "failed");
      })
      .catch(function () { message("network"); });
  }

  function init() {
    $("#refund-btn").addEventListener("click", refund);
    $("#msg-retry").addEventListener("click", load);
    if (!isSet(CFG.SHEETS_WEB_APP_URL)) { message("failed"); return; }
    if (!/^SU-[A-Z0-9]{6,12}$/.test(ref) || !/^[A-Za-z0-9_-]{32}$/.test(token)) { message("bad_link"); return; }
    load();
  }

  init();
})();
