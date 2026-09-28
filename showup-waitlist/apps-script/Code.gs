/**
 * ShowUp waitlist — Google Sheets backend (Google Apps Script)
 * ---------------------------------------------------------------
 * What it does
 *   1. "Checkout started" tab: logs everyone who submits the form,
 *      before they pay (useful for following up on abandoned checkouts).
 *   2. "Reservations" tab: adds a row ONLY after Stripe confirms the
 *      payment. It asks Stripe directly, so nobody can fake a reservation
 *      by opening the success page by hand.
 *   3. Returns founding-spot counts per city for the website's counter.
 *   4. A 15-minute sync catches anyone who paid but closed the tab before
 *      the success page loaded.
 *
 * Setup: see README.md, step 2. In short:
 *   - Paste this file into Extensions → Apps Script in your Google Sheet.
 *   - Project Settings → Script properties → add STRIPE_SECRET_KEY.
 *   - Fill in the CONFIG block below, run setup() once, then deploy as a
 *     Web app (Execute as: Me, Who has access: Anyone).
 */

const CONFIG = {
  // Your Stripe Payment Link ID (starts with "plink_"). Leave empty until you
  // have it. Needed for the 15-minute sync and recommended for security.
  PAYMENT_LINK_ID: '',

  // Must match the Payment Link price, in cents (9.99 USD = 999).
  // Set to 0 to skip the amount check.
  EXPECTED_AMOUNT_CENTS: 999,
  EXPECTED_CURRENCY: 'usd',

  // Founding spots per city (keep in sync with assets/js/config.js).
  FOUNDING_CAP: 500,

  // How far back the sync looks for paid checkouts, in days.
  SYNC_LOOKBACK_DAYS: 3,

  STARTED_SHEET: 'Checkout started',
  RESERVATIONS_SHEET: 'Reservations'
};

const STARTED_HEADERS = ['Started at', 'Reference', 'First name', 'Email', 'City', 'Age range', 'Interests', 'Status', 'Page'];
const RESERVATION_HEADERS = ['Paid at', 'Reference', 'First name', 'Email', 'City', 'Age range', 'Interests', 'City spot #', 'Amount', 'Currency', 'Stripe session ID', 'Stripe payment intent', 'Confirmed by'];

/* =============================================================
   One-time setup — run this once from the Apps Script editor
   ============================================================= */
function setup() {
  getSheet_(CONFIG.STARTED_SHEET, STARTED_HEADERS);
  getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);

  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncPaidCheckouts'; });
  if (!exists) ScriptApp.newTrigger('syncPaidCheckouts').timeBased().everyMinutes(15).create();

  const key = PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY');
  Logger.log(key ? 'Setup done. Stripe key found.' : 'Setup done. Add STRIPE_SECRET_KEY in Project Settings → Script properties.');
}

/* =============================================================
   Web app endpoints
   ============================================================= */
function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || '').toLowerCase();
  if (action === 'counts') return json_(getCounts_());
  return json_({ ok: true, service: 'showup-waitlist' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  try {
    if (body.action === 'start') return json_(recordStart_(body));
    if (body.action === 'confirm') return json_(confirmSession_(String(body.session_id || ''), 'Success page'));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
  }
}

/* =============================================================
   1. Checkout started
   ============================================================= */
function recordStart_(b) {
  const ref = String(b.ref || '').trim();
  const email = String(b.email || '').trim();
  if (!/^SU-[A-Z0-9]{6,12}$/.test(ref)) return { ok: false, error: 'bad_ref' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return { ok: false, error: 'bad_email' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getSheet_(CONFIG.STARTED_SHEET, STARTED_HEADERS);
    if (findRow_(sheet, 'Reference', ref)) return { ok: true, ref: ref, duplicate: true };
    sheet.appendRow([
      new Date(),
      ref,
      clean_(b.firstName, 60),
      clean_(email, 254),
      clean_(b.city, 80),
      clean_(b.age, 10),
      clean_(b.interests, 300),
      'Checkout started',
      clean_(b.page, 300)
    ]);
    return { ok: true, ref: ref };
  } finally {
    lock.releaseLock();
  }
}

/* =============================================================
   2. Confirm a paid Stripe Checkout Session → Reservations
   ============================================================= */
function confirmSession_(sessionId, source) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return { ok: false, error: 'bad_session' };
  if (!getStripeKey_()) return { ok: false, error: 'server_not_configured' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const reservations = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
    const existing = findRow_(reservations, 'Stripe session ID', sessionId);
    if (existing) return reservationResult_(existing.values, true);

    const session = stripeGet_('/v1/checkout/sessions/' + encodeURIComponent(sessionId));
    const check = validateSession_(session);
    if (!check.ok) return check;

    return addReservation_(session, source);
  } finally {
    lock.releaseLock();
  }
}

function validateSession_(s) {
  if (!s || s.error) return { ok: false, error: 'not_found' };
  if (s.payment_status !== 'paid') return { ok: false, error: 'not_paid' };
  if (CONFIG.PAYMENT_LINK_ID && s.payment_link !== CONFIG.PAYMENT_LINK_ID) return { ok: false, error: 'wrong_payment_link' };
  if (CONFIG.EXPECTED_AMOUNT_CENTS && s.amount_total !== CONFIG.EXPECTED_AMOUNT_CENTS) return { ok: false, error: 'wrong_amount' };
  if (CONFIG.EXPECTED_CURRENCY && String(s.currency || '').toLowerCase() !== CONFIG.EXPECTED_CURRENCY) return { ok: false, error: 'wrong_currency' };
  return { ok: true };
}

function addReservation_(s, source) {
  const reservations = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
  const started = getSheet_(CONFIG.STARTED_SHEET, STARTED_HEADERS);

  const ref = /^SU-[A-Z0-9]{6,12}$/.test(String(s.client_reference_id || '')) ? s.client_reference_id : '';
  const lead = ref ? findRow_(started, 'Reference', ref) : null;
  const leadData = lead ? rowObject_(started, lead.values) : {};
  const details = s.customer_details || {};

  const firstName = leadData['First name'] || firstWord_(details.name);
  const email = details.email || leadData['Email'] || '';
  const city = leadData['City'] || '';
  const spot = city ? countCity_(reservations, city) + 1 : '';

  const row = [
    new Date((s.created || Math.floor(Date.now() / 1000)) * 1000),
    ref,
    clean_(firstName, 60),
    clean_(email, 254),
    clean_(city, 80),
    clean_(leadData['Age range'], 10),
    clean_(leadData['Interests'], 300),
    spot,
    (Number(s.amount_total) || 0) / 100,
    String(s.currency || '').toUpperCase(),
    s.id,
    typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || '',
    source
  ];
  reservations.appendRow(row);

  if (lead) {
    const statusCol = headerIndex_(started, 'Status') + 1;
    started.getRange(lead.row, statusCol).setValue('Paid');
  }
  return reservationResult_(row, false);
}

function reservationResult_(values, already) {
  const i = function (h) { return RESERVATION_HEADERS.indexOf(h); };
  return {
    ok: true,
    already: already,
    ref: values[i('Reference')] || '',
    firstName: values[i('First name')] || '',
    city: values[i('City')] || '',
    spot: values[i('City spot #')] || '',
    cap: CONFIG.FOUNDING_CAP
  };
}

/* =============================================================
   3. Founding spot counts for the website
   ============================================================= */
function getCounts_() {
  const sheet = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
  const cityCol = headerIndex_(sheet, 'City');
  const values = sheet.getDataRange().getValues().slice(1);
  const cities = {};
  values.forEach(function (r) {
    const c = String(r[cityCol] || '').trim();
    if (c) cities[c] = (cities[c] || 0) + 1;
  });
  return { ok: true, cap: CONFIG.FOUNDING_CAP, cities: cities, total: values.length };
}

function countCity_(sheet, city) {
  const cityCol = headerIndex_(sheet, 'City');
  const target = String(city).trim().toLowerCase();
  return sheet.getDataRange().getValues().slice(1).filter(function (r) {
    return String(r[cityCol] || '').trim().toLowerCase() === target;
  }).length;
}

/* =============================================================
   4. Every-15-minutes sync (set up by setup())
   ============================================================= */
function syncPaidCheckouts() {
  if (!CONFIG.PAYMENT_LINK_ID || !getStripeKey_()) return;
  const since = Math.floor(Date.now() / 1000) - CONFIG.SYNC_LOOKBACK_DAYS * 86400;
  let startingAfter = '';
  let pages = 0;

  do {
    let path = '/v1/checkout/sessions?limit=100&status=complete' +
      '&payment_link=' + encodeURIComponent(CONFIG.PAYMENT_LINK_ID) +
      '&created[gte]=' + since;
    if (startingAfter) path += '&starting_after=' + encodeURIComponent(startingAfter);

    const page = stripeGet_(path);
    if (!page || page.error || !Array.isArray(page.data)) return;

    page.data.forEach(function (s) {
      if (s.payment_status !== 'paid') return;
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const reservations = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
        if (findRow_(reservations, 'Stripe session ID', s.id)) return;
        if (validateSession_(s).ok) addReservation_(s, 'Auto-sync');
      } finally {
        lock.releaseLock();
      }
    });

    startingAfter = page.has_more && page.data.length ? page.data[page.data.length - 1].id : '';
    pages++;
  } while (startingAfter && pages < 10);
}

/* =============================================================
   Helpers
   ============================================================= */
function getStripeKey_() {
  return PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY') || '';
}

function stripeGet_(path) {
  const res = UrlFetchApp.fetch('https://api.stripe.com' + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + getStripeKey_() },
    muteHttpExceptions: true
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) { data = {}; }
  if (res.getResponseCode() !== 200) return { error: data.error || { message: 'HTTP ' + res.getResponseCode() } };
  return data;
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function headerIndex_(sheet, header) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.indexOf(header);
}

function findRow_(sheet, header, value) {
  const col = headerIndex_(sheet, header);
  if (col < 0) return null;
  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][col]) === String(value)) return { row: r + 1, values: values[r] };
  }
  return null;
}

function rowObject_(sheet, values) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const obj = {};
  headers.forEach(function (h, i) { obj[h] = values[i]; });
  return obj;
}

// Trim, cap length, and stop spreadsheet formula injection.
function clean_(value, max) {
  let v = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 200);
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return v;
}

function firstWord_(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
