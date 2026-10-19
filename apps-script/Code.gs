/** @OnlyCurrentDoc */
// ↑ Limits this script to the spreadsheet it's attached to, so it can't open
//   any of your other Google Sheets.


/**
 * ShowUp waitlist — Google Sheets backend (Google Apps Script)
 * ---------------------------------------------------------------
 * What it does
 *   1. Creates the Stripe Checkout Session when someone submits the form,
 *      and logs them in the "Checkout started" tab (useful for following
 *      up on abandoned checkouts).
 *   2. "Reservations" tab: adds a row ONLY after Stripe confirms the
 *      payment. It asks Stripe directly, so nobody can fake a reservation
 *      by opening the success page by hand.
 *   3. Emails each person a "You're in" confirmation once their payment is
 *      confirmed (sent from your Gmail; see CONFIRMATION_EMAIL below).
 *   4. Tells the website how many of the 500 founding spots are left, and
 *      stops new checkouts once they're all taken.
 *   5. Refunds: people can refund themselves before launch from a private
 *      link in their email or on the success page, and you can refund anyone
 *      from the ShowUp menu in the Sheet. Each refund is made in Stripe,
 *      logged in the "Refunds" tab, frees the founding spot and emails them.
 *   6. A 15-minute sync catches anyone who paid but closed the tab before
 *      the success page loaded, records refunds made in the Stripe Dashboard,
 *      and sends emails held back by Gmail's daily limit.
 *
 * Setup: see STRIPE_INTEGRATION_TODO.md and README.md. In short:
 *   - Paste this file into Extensions → Apps Script in your Google Sheet.
 *   - Project Settings → Script properties → add STRIPE_API_KEY (your Stripe
 *     secret key). GitHub secrets can't reach this script, so it goes here.
 *   - Replace the placeholders in the CONFIG block below, run setup() once
 *     (it asks for permissions), then deploy as a Web app
 *     (Execute as: Me, Who has access: Anyone).
 *   - Optional: run sendTestEmail() to see the confirmation email yourself.
 *
 * Security
 *   - Limited to this spreadsheet (@OnlyCurrentDoc above).
 *   - The Stripe key stays in Script properties; nothing here returns it.
 *   - Price, success and cancel URLs are fixed here, never taken from visitors.
 *   - Reservations are only written after Stripe confirms the payment.
 *   - Emails only go to people Stripe says have paid, so the form can't be
 *     used to send mail to strangers. Names are escaped.
 *   - Refund links are signed with a secret kept in Script properties
 *     (REFUND_SECRET, created by setup()), so nobody can refund someone else
 *     by guessing a reference. Stripe is sent an idempotency key, so a
 *     payment can never be refunded twice.
 *   - Rate limits (RATE_LIMITS below) stop spam from filling the Sheet or
 *     using up Google's daily quota for outside requests.
 *   - Stripe error details are logged here, never shown to visitors.
 *   - Keep edit access to this Sheet to yourself: editors can see the script
 *     and its Script properties.
 */

const CONFIG = {
  // ---- Stripe Checkout (placeholders: see STRIPE_INTEGRATION_TODO.md) ----
  // "payment" = one-time charge (the $9.99 reservation).
  MODE: 'payment',
  // Your Stripe Price ID for the $9.99 reservation (Dashboard → Product catalog).
  STRIPE_PRICE_ID: 'price_...',
  // Where Stripe sends people after paying. Keep {CHECKOUT_SESSION_ID}.
  SUCCESS_URL: 'https://ethankolakaluri.github.io/ShowUp-Waitlist/success.html?session_id={CHECKOUT_SESSION_ID}',
  // Where Stripe sends people who click back / cancel.
  CANCEL_URL: 'https://ethankolakaluri.github.io/ShowUp-Waitlist/#reserve',

  // Must match the Price amount, in cents (9.99 USD = 999).
  // Set to 0 to skip the amount check.
  EXPECTED_AMOUNT_CENTS: 999,
  EXPECTED_CURRENCY: 'usd',

  // Founding spots in total (keep in sync with assets/js/config.js).
  FOUNDING_CAP: 500,

  // How far back the sync looks for paid checkouts, in days.
  SYNC_LOOKBACK_DAYS: 3,

  // Let people refund themselves from the link in their email and on the
  // success page. Set to false at launch: after that, refunds go through the
  // Show-Up Guarantee and you issue them from the ShowUp menu in the Sheet.
  SELF_SERVE_REFUNDS: true,

  STARTED_SHEET: 'Checkout started',
  RESERVATIONS_SHEET: 'Reservations',
  REFUNDS_SHEET: 'Refunds'
};

// Anti-spam limits. Generous for real visitors, tight enough to stop a script
// from flooding the Sheet or using up the daily outside-request quota.
const RATE_LIMITS = {
  CHECKOUTS_PER_EMAIL_PER_HOUR: 5,     // one person retrying checkout
  CHECKOUTS_PER_10_MIN: 120,           // everyone combined
  CONFIRMS_PER_10_MIN: 300,            // success-page checks, everyone combined
  REFUND_REQUESTS_PER_10_MIN: 60       // refund page loads + refunds, everyone combined
};

// Checkout Session settings — exactly as configured in Stripe Checkout Studio.
// ui_mode: 'hosted_page' is the name in newer Stripe API versions; accounts on an
// older default API version use 'hosted' (see STRIPE_INTEGRATION_TODO.md).
const CHECKOUT_STUDIO_PARAMS = {
  ui_mode: 'hosted_page',
  billing_address_collection: 'auto',
  allow_promotion_codes: 'false',
  submit_type: 'auto',
  integration_identifier: 'hosted_mobile_app_0002',
  origin_context: 'mobile_app'
};

// "You're in" email sent to each person once Stripe confirms their payment.
// It goes out from the Gmail account that owns this script, with FROM_NAME
// as the sender name. Free Gmail accounts can email 100 people a day; anyone
// past that is marked "Waiting" in the Reservations tab and gets their email
// automatically on the next sync after the limit resets.
const CONFIRMATION_EMAIL = {
  ENABLED: true,
  FROM_NAME: 'ShowUp',
  // Where replies go. Leave empty to use your own Gmail address.
  REPLY_TO: 'showup128@gmail.com'
};

// Tag on every session this site creates, so the Sheet only counts ShowUp reservations.
const APP_TAG = 'showup-waitlist';

const STARTED_HEADERS = ['Started at', 'Reference', 'First name', 'Email', 'Age range', 'Interests', 'Status', 'Page'];
const RESERVATION_HEADERS = ['Paid at', 'Reference', 'First name', 'Email', 'Age range', 'Interests', 'Spot #', 'Amount', 'Currency', 'Stripe session ID', 'Stripe payment intent', 'Confirmed by', 'Confirmation email', 'Refunded at', 'Refunded by'];
const REFUND_HEADERS = ['Refunded at', 'Reference', 'First name', 'Email', 'Spot #', 'Amount', 'Currency', 'Stripe refund ID', 'Stripe payment intent', 'Refunded by', 'Refund email'];
const EMAIL_WAITING = 'Waiting (daily email limit)';

/* =============================================================
   One-time setup — run this once from the Apps Script editor
   ============================================================= */
function setup() {
  getSheet_(CONFIG.STARTED_SHEET, STARTED_HEADERS);
  getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
  getSheet_(CONFIG.REFUNDS_SHEET, REFUND_HEADERS);
  getRefundSecret_();

  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncPaidCheckouts'; });
  if (!exists) ScriptApp.newTrigger('syncPaidCheckouts').timeBased().everyMinutes(15).create();

  Logger.log(getStripeKey_() ? 'Setup done. Stripe key found.' : 'Setup done. Add STRIPE_API_KEY in Project Settings → Script properties.');
  if (CONFIRMATION_EMAIL.ENABLED) Logger.log('Confirmation emails are on. Gmail lets this script email ' + MailApp.getRemainingDailyQuota() + ' more people today.');
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
    if (body.action === 'checkout') return json_(createCheckout_(body));
    if (body.action === 'confirm') {
      if (rateLimited_('confirm', RATE_LIMITS.CONFIRMS_PER_10_MIN, 600)) return json_({ ok: false, error: 'rate_limited' });
      return json_(confirmSession_(String(body.session_id || ''), 'Success page'));
    }
    if (body.action === 'refund_status' || body.action === 'refund') {
      if (rateLimited_('refund', RATE_LIMITS.REFUND_REQUESTS_PER_10_MIN, 600)) return json_({ ok: false, error: 'rate_limited' });
      return json_(body.action === 'refund'
        ? selfServeRefund_(String(body.ref || ''), String(body.t || ''))
        : refundStatus_(String(body.ref || ''), String(body.t || '')));
    }
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
    appendRecord_(sheet, {
      'Started at': new Date(),
      'Reference': ref,
      'First name': clean_(b.firstName, 60),
      'Email': clean_(email, 254),
      'Age range': clean_(b.age, 10),
      'Interests': clean_(b.interests, 300),
      'Status': 'Checkout started',
      'Page': clean_(b.page, 300)
    });
    return { ok: true, ref: ref };
  } finally {
    lock.releaseLock();
  }
}

/* =============================================================
   1b. Create the Stripe Checkout Session
   ============================================================= */
function createCheckout_(b) {
  if (!getStripeKey_()) return { ok: false, error: 'server_not_configured' };
  if (!isCheckoutConfigured_()) return { ok: false, error: 'checkout_not_configured' };

  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return { ok: false, error: 'bad_email' };
  if (rateLimited_('checkout', RATE_LIMITS.CHECKOUTS_PER_10_MIN, 600) ||
      rateLimited_('email:' + hash_(email), RATE_LIMITS.CHECKOUTS_PER_EMAIL_PER_HOUR, 3600)) {
    return { ok: false, error: 'rate_limited' };
  }
  if (activeReservations_() >= CONFIG.FOUNDING_CAP) return { ok: false, error: 'sold_out' };

  const started = recordStart_(b);
  if (!started.ok) return started;

  const params = {
    mode: CONFIG.MODE,
    success_url: CONFIG.SUCCESS_URL,
    cancel_url: CONFIG.CANCEL_URL,
    'line_items[0][price]': CONFIG.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: started.ref,
    customer_email: String(b.email || '').trim(),
    'metadata[app]': APP_TAG,
    'metadata[ref]': started.ref
  };
  Object.keys(CHECKOUT_STUDIO_PARAMS).forEach(function (k) { params[k] = CHECKOUT_STUDIO_PARAMS[k]; });

  const session = stripePost_('/v1/checkout/sessions', params);
  if (!session || session.error || !session.url) {
    console.error('Stripe Checkout Session create failed', session && session.error);
    return { ok: false, error: 'stripe_error' };
  }
  return { ok: true, ref: started.ref, url: session.url };
}

function isCheckoutConfigured_() {
  const placeholder = /\.\.\.|example\.com/;
  return !placeholder.test(CONFIG.STRIPE_PRICE_ID) && /^price_/.test(CONFIG.STRIPE_PRICE_ID) &&
    !placeholder.test(CONFIG.SUCCESS_URL) && CONFIG.SUCCESS_URL.indexOf('{CHECKOUT_SESSION_ID}') > -1 &&
    !placeholder.test(CONFIG.CANCEL_URL);
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
    if (existing) return reservationResult_(rowObject_(reservations, existing.values), true);

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
  if (!s.metadata || s.metadata.app !== APP_TAG) return { ok: false, error: 'not_showup_session' };
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

  const record = {
    'Paid at': new Date((s.created || Math.floor(Date.now() / 1000)) * 1000),
    'Reference': ref,
    'First name': clean_(firstName, 60),
    'Email': clean_(email, 254),
    'Age range': clean_(leadData['Age range'], 10),
    'Interests': clean_(leadData['Interests'], 300),
    'Spot #': countReservations_(reservations) + 1,
    'Amount': (Number(s.amount_total) || 0) / 100,
    'Currency': String(s.currency || '').toUpperCase(),
    'Stripe session ID': s.id,
    'Stripe payment intent': typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || '',
    'Confirmed by': source,
    'Confirmation email': CONFIRMATION_EMAIL.ENABLED ? 'Sending…' : ''
  };
  appendRecord_(reservations, record);

  if (lead) {
    const statusCol = headerIndex_(started, 'Status') + 1;
    started.getRange(lead.row, statusCol).setValue('Paid');
  }

  if (CONFIRMATION_EMAIL.ENABLED) {
    const status = sendConfirmation_(record);
    setCell_(reservations, reservations.getLastRow(), 'Confirmation email', status);
  }
  return reservationResult_(record, false);
}

// r: a Reservations row as an object keyed by column header.
function reservationResult_(r, already) {
  const ref = String(r['Reference'] || '');
  const refunded = !!r['Refunded at'];
  const result = {
    ok: true,
    already: already,
    ref: ref,
    firstName: String(r['First name'] || ''),
    spot: r['Spot #'] || '',
    cap: CONFIG.FOUNDING_CAP,
    refunded: refunded
  };
  // The private refund link for this person, shown on the success page.
  if (CONFIG.SELF_SERVE_REFUNDS && ref && !refunded) {
    result.refundToken = refundToken_(ref, r['Stripe session ID']);
  }
  return result;
}

/* =============================================================
   3. Founding spot counts for the website
   ============================================================= */
function getCounts_() {
  const taken = activeReservations_();
  return { ok: true, cap: CONFIG.FOUNDING_CAP, total: taken, left: Math.max(0, CONFIG.FOUNDING_CAP - taken) };
}

// Reservations holding a spot right now (refunded ones don't).
function activeReservations_() {
  const sheet = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
  const refundedCol = headerIndex_(sheet, 'Refunded at');
  return sheet.getDataRange().getValues().slice(1).filter(function (r) { return !(refundedCol > -1 && r[refundedCol]); }).length;
}

// Spot numbers count every reservation, refunded ones too, so no two people
// are ever given the same number.
function countReservations_(sheet) {
  return Math.max(0, sheet.getLastRow() - 1);
}

/* =============================================================
   4. Every-15-minutes sync (set up by setup())
   ============================================================= */
function syncPaidCheckouts() {
  if (CONFIRMATION_EMAIL.ENABLED) {
    sendConfirmationEmails_(function (status) { return status === EMAIL_WAITING; });
    retryRefundEmails_();
  }
  if (!getStripeKey_()) return;
  syncRefunds_();
  const since = Math.floor(Date.now() / 1000) - CONFIG.SYNC_LOOKBACK_DAYS * 86400;
  let startingAfter = '';
  let pages = 0;

  do {
    let path = '/v1/checkout/sessions?limit=100&status=complete' +
      '&created[gte]=' + since;
    if (startingAfter) path += '&starting_after=' + encodeURIComponent(startingAfter);

    const page = stripeGet_(path);
    if (!page || page.error || !Array.isArray(page.data)) return;

    page.data.forEach(function (s) {
      if (s.payment_status !== 'paid' || !s.metadata || s.metadata.app !== APP_TAG) return;
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
   5. Emails
   ============================================================= */

// Run from the editor (or ShowUp menu) to see the email yourself. It goes
// to your own Gmail. Its refund link is a sample and won't work.
function sendTestEmail() {
  const to = Session.getEffectiveUser().getEmail();
  const status = sendConfirmation_({
    'Email': to, 'First name': 'Maya', 'Spot #': 12,
    'Amount': (CONFIG.EXPECTED_AMOUNT_CENTS || 999) / 100, 'Currency': 'USD',
    'Reference': 'SU-TEST1234', 'Stripe session ID': 'cs_test_sample', 'Paid at': new Date()
  });
  Logger.log(status.indexOf('Sent') === 0 ? 'Test email sent to ' + to + '. Check your inbox (and spam).' : 'Test email not sent: ' + status);
}

// Run from the editor (or ShowUp menu) to email everyone in Reservations
// whose "Confirmation email" cell is empty: people who reserved before emails
// were turned on, or rows where you cleared the cell to send it again.
function sendMissingConfirmationEmails() {
  const sent = sendConfirmationEmails_(function (status) { return status === '' || status === EMAIL_WAITING; });
  Logger.log('Sent ' + sent + ' confirmation email(s).');
}

// Sends the email for every Reservations row whose status passes shouldSend.
// Uses its own lock so it never holds up payments being confirmed.
function sendConfirmationEmails_(shouldSend) {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 0; // another run is already sending
  try {
    const sheet = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
    const col = headerIndex_(sheet, 'Confirmation email');
    const refundedCol = headerIndex_(sheet, 'Refunded at');
    const values = sheet.getDataRange().getValues();
    let sent = 0;
    for (let r = 1; r < values.length; r++) {
      if (!shouldSend(String(values[r][col] || ''))) continue;
      if (refundedCol > -1 && values[r][refundedCol]) continue; // refunded: no "You're in"
      if (MailApp.getRemainingDailyQuota() < 1) break;
      const status = sendConfirmation_(rowObject_(sheet, values[r]));
      sheet.getRange(r + 1, col + 1).setValue(status);
      if (status.indexOf('Sent') === 0) sent++;
      if (status === EMAIL_WAITING) break;
    }
    return sent;
  } finally {
    lock.releaseLock();
  }
}

// Refund emails held back by Gmail's daily limit (Refunds tab).
function retryRefundEmails_() {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const log = getSheet_(CONFIG.REFUNDS_SHEET, REFUND_HEADERS);
    const col = headerIndex_(log, 'Refund email');
    const values = log.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col]) !== EMAIL_WAITING) continue;
      if (MailApp.getRemainingDailyQuota() < 1) break;
      const r = rowObject_(log, values[i]);
      const status = sendRefundEmail_(r, { amount: Math.round((Number(r['Amount']) || 0) * 100), currency: r['Currency'] });
      log.getRange(i + 1, col + 1).setValue(status);
      if (status === EMAIL_WAITING) break;
    }
  } finally {
    lock.releaseLock();
  }
}

// Sends the "You're in" email for one reservation (an object keyed by column
// header) and returns what to write in its "Confirmation email" cell.
function sendConfirmation_(r) {
  return sendMail_(r['Email'], function () { return confirmationMessage_(r); });
}

function sendRefundEmail_(r, refund) {
  return sendMail_(r['Email'], function () { return refundMessage_(r, refund); });
}

// Returns a status for the Sheet: "Sent …", "Waiting (daily email limit)",
// "Failed: …" or "Not sent: …".
function sendMail_(address, build) {
  const to = String(address || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return 'Not sent: no valid email';
  if (MailApp.getRemainingDailyQuota() < 1) return EMAIL_WAITING;
  try {
    const msg = build();
    const options = { to: to, subject: msg.subject, body: msg.text, htmlBody: msg.html, name: CONFIRMATION_EMAIL.FROM_NAME };
    if (CONFIRMATION_EMAIL.REPLY_TO) options.replyTo = CONFIRMATION_EMAIL.REPLY_TO;
    MailApp.sendEmail(options);
    return 'Sent ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  } catch (err) {
    console.error('Email failed', err);
    if (/too many times|quota|limit/i.test(String(err))) return EMAIL_WAITING;
    return 'Failed: ' + String((err && err.message) || err).slice(0, 120);
  }
}

function confirmationMessage_(r) {
  const site = siteUrl_();
  const name = String(r['First name'] || '').trim();
  const spot = Number(r['Spot #']) || 0;
  const ref = String(r['Reference'] || '').trim();
  const currency = String(r['Currency'] || 'USD').toUpperCase();
  const price = money_(r['Amount'], currency);
  const date = formatDay_(r['Paid at']);
  const cap = CONFIG.FOUNDING_CAP;

  const hello = name ? "You're in, " + name : "You're in";
  const subject = spot
    ? hello + '! Founding spot #' + spot + ' of ' + cap
    : hello + '! Your ShowUp spot is reserved';
  const lead = 'Your founding spot is reserved. Your ' + price + ' also covers your first month after launch, so there\'s nothing else to pay until month two.';
  const spotLine = spot ? 'of ' + cap + ' founding spots' : '';
  const steps = [
    "We'll email you before launch to finish your match quiz.",
    'At launch, you get your crew and your first AI-planned hangout.',
    'From month two, Crew is ' + price + '/mo, locked in while you\'re a member.'
  ];
  const guarantee = "Go to 3 hangouts in your first 30 days. If you haven't met at least one person you want to see again, we refund your first month in full.";
  const invite = 'mailto:?subject=' + encodeURIComponent('Come to ShowUp with me') +
    '&body=' + encodeURIComponent('I just reserved a founding spot on ShowUp. It matches you with a crew and plans the hangouts for you. Grab a spot before they\'re gone: ' + site);
  const refundUrl = CONFIG.SELF_SERVE_REFUNDS && ref ? refundUrl_(ref, r['Stripe session ID']) : '';

  const text = [
    hello + '.',
    '',
    (spotLine ? 'Spot #' + spot + ' ' + spotLine + '.\n\n' : '') + lead,
    '',
    'What happens next',
    steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n'),
    '',
    'The Show-Up Guarantee',
    guarantee,
    '',
    'Paid: ' + price + ' ' + currency,
    'Date: ' + date,
    ref ? 'Reference: ' + ref : '',
    '',
    "Know someone who'd come along? Send them " + site,
    '',
    'Questions? Just reply to this email.',
    refundUrl ? 'Changed your mind? You can get a full refund anytime before launch: ' + refundUrl : '',
    '',
    'ShowUp'
  ].filter(function (line, i, all) { return line !== '' || all[i - 1] !== ''; }).join('\n');

  const body =
    (spotLine
      ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF0E8;border-radius:18px;margin:0 0 28px;"><tr>' +
        '<td width="1" style="padding:18px 6px 18px 22px;font:800 44px/1 ' + F_HEAD + ';color:#FF5B35;white-space:nowrap;">#' + esc_(spot) + '</td>' +
        '<td style="padding:18px 22px 18px 10px;font:600 15px/1.4 ' + F_BODY + ';color:#2B211C;">' + esc_(spotLine) + '</td>' +
        '</tr></table>'
      : '') +
    '<h2 style="margin:0 0 12px;font:800 18px/1.3 ' + F_HEAD + ';color:#2B211C;">What happens next</h2>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">' +
    steps.map(function (s, i) {
      return '<tr><td width="36" valign="top" style="padding:0 0 12px;">' +
        '<div style="width:26px;height:26px;border-radius:13px;background:#FF5B35;color:#FFFDF9;text-align:center;font:800 13px/26px ' + F_HEAD + ';">' + (i + 1) + '</div></td>' +
        '<td valign="top" style="padding:3px 0 12px;font:15px/1.5 ' + F_BODY + ';color:#5C4F46;">' + esc_(s) + '</td></tr>';
    }).join('') +
    '</table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-left:4px solid #FF5B35;margin:0 0 26px;"><tr><td style="padding:2px 0 2px 16px;">' +
    '<p style="margin:0 0 4px;font:800 16px/1.3 ' + F_HEAD + ';color:#2B211C;">The Show-Up Guarantee</p>' +
    '<p style="margin:0;font:14px/1.55 ' + F_BODY + ';color:#5C4F46;">' + esc_(guarantee) + '</p>' +
    '</td></tr></table>' +
    emailFacts_([['Paid', price + ' ' + currency], ['Date', date], ['Reference', ref]]) +
    '<p style="margin:0 0 10px;font:15px/1.5 ' + F_BODY + ';color:#5C4F46;">Know someone who\'d come along?</p>' +
    emailButton_('Invite a friend', invite);

  const footer = 'Questions? Just reply to this email.<br>' +
    (refundUrl ? 'Changed your mind? You can get a full refund anytime before launch. <a href="' + esc_(refundUrl) + '" style="color:#C8401C;">Refund my reservation</a><br>' : '') +
    'You\'re getting this because you reserved a founding spot at <a href="' + esc_(site) + '" style="color:#C8401C;">ShowUp</a>.';

  return {
    subject: subject,
    text: text,
    html: emailLayout_({
      title: subject,
      preheader: spotLine ? 'Spot #' + spot + ' ' + spotLine + '. ' + lead : lead,
      eyebrow: 'Founding ' + cap,
      heading: hello + '.',
      lead: lead,
      body: body,
      footer: footer
    })
  };
}

function refundMessage_(r, refund) {
  const site = siteUrl_();
  const name = String(r['First name'] || '').trim();
  const spot = Number(r['Spot #']) || 0;
  const ref = String(r['Reference'] || '').trim();
  const currency = String((refund && refund.currency) || r['Currency'] || 'USD').toUpperCase();
  const amount = refund && refund.amount ? refund.amount / 100 : r['Amount'];
  const price = money_(amount, currency);

  const subject = 'Your ShowUp reservation is refunded';
  const heading = name ? 'Your refund is on its way, ' + name + '.' : 'Your refund is on its way.';
  const lead = "We've refunded " + price + ' to the card you paid with. It usually shows up in 5–10 business days, depending on your bank.';
  const released = spot ? 'Founding spot #' + spot + ' has been released.' : 'Your founding spot has been released.';

  const text = [
    heading,
    '',
    lead,
    released,
    '',
    'Refunded: ' + price + ' ' + currency,
    'Date: ' + formatDay_(new Date()),
    ref ? 'Reference: ' + ref : '',
    '',
    'Changed your mind again? You can reserve a founding spot while they last: ' + site + '#reserve',
    '',
    'Questions? Just reply to this email.',
    'ShowUp'
  ].filter(function (line, i, all) { return line !== '' || all[i - 1] !== ''; }).join('\n');

  const body =
    '<p style="margin:0 0 24px;font:600 15px/1.5 ' + F_BODY + ';color:#2B211C;background:#FFF0E8;border-radius:14px;padding:14px 18px;">' + esc_(released) + '</p>' +
    emailFacts_([['Refunded', price + ' ' + currency], ['Date', formatDay_(new Date())], ['Reference', ref]]) +
    '<p style="margin:0 0 10px;font:15px/1.5 ' + F_BODY + ';color:#5C4F46;">Changed your mind again? Founding spots are open while they last.</p>' +
    emailButton_('Reserve again', site + '#reserve');

  return {
    subject: subject,
    text: text,
    html: emailLayout_({
      title: subject,
      preheader: lead,
      eyebrow: 'Refund',
      heading: heading,
      lead: lead,
      body: body,
      footer: 'Questions? Just reply to this email.<br>You\'re getting this because you asked for a refund of your ShowUp reservation.'
    })
  };
}

const F_HEAD = "'Bricolage Grotesque','Helvetica Neue',Helvetica,Arial,sans-serif";
const F_BODY = "'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif";

// Shared email frame: logo, card, footer. Everything is inline-styled so it
// looks the same in Gmail, Apple Mail and Outlook. o.body and o.footer are
// HTML; everything else is escaped here.
function emailLayout_(o) {
  const site = siteUrl_();
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">' +
    '<title>' + esc_(o.title) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=DM+Sans:wght@400;600&display=swap" rel="stylesheet">' +
    '</head><body style="margin:0;padding:0;background:#FBF6EE;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc_(o.preheader) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBF6EE;"><tr><td align="center" style="padding:32px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">' +
    '<tr><td style="padding:0 4px 20px;"><a href="' + esc_(site) + '" style="text-decoration:none;">' +
    '<img src="' + esc_(site + 'assets/img/email-logo.png') + '" width="132" alt="showup" style="display:block;border:0;width:132px;height:auto;font:800 28px ' + F_HEAD + ';color:#2B211C;"></a></td></tr>' +
    '<tr><td style="background:#FFFDF9;border:1px solid #F0E4D7;border-radius:24px;padding:36px 32px;">' +
    '<p style="margin:0 0 14px;"><span style="display:inline-block;background:#FFE4D9;color:#C8401C;border-radius:999px;padding:5px 12px;font:600 12px/1 ' + F_BODY + ';letter-spacing:.08em;text-transform:uppercase;">' + esc_(o.eyebrow) + '</span></p>' +
    '<h1 style="margin:0 0 12px;font:800 34px/1.1 ' + F_HEAD + ';color:#2B211C;letter-spacing:-.02em;">' + esc_(o.heading) + '</h1>' +
    '<p style="margin:0 0 24px;font:16px/1.6 ' + F_BODY + ';color:#5C4F46;">' + esc_(o.lead) + '</p>' +
    o.body +
    '</td></tr>' +
    '<tr><td style="padding:22px 4px 0;font:13px/1.6 ' + F_BODY + ';color:#7A6A5F;">' + o.footer + '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function emailFacts_(pairs) {
  const rows = pairs.filter(function (p) { return p[1]; }).map(function (p) {
    return '<tr><td style="padding:6px 0;font:14px/1.4 ' + F_BODY + ';color:#7A6A5F;">' + esc_(p[0]) + '</td>' +
      '<td align="right" style="padding:6px 0;font:600 14px/1.4 ' + F_BODY + ';color:#2B211C;">' + esc_(p[1]) + '</td></tr>';
  }).join('');
  const gap = '<tr><td colspan="2" style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #F0E4D7;border-bottom:1px solid #F0E4D7;margin:0 0 28px;">' +
    gap + rows + gap + '</table>';
}

function emailButton_(label, href) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#C8401C;border-radius:999px;">' +
    '<a href="' + esc_(href) + '" style="display:inline-block;padding:13px 24px;font:600 15px/1 ' + F_BODY + ';color:#FFFDF9;text-decoration:none;">' + esc_(label) + '</a>' +
    '</td></tr></table>';
}

// The site's home page, taken from CANCEL_URL (…/ShowUp-Waitlist/#reserve → …/ShowUp-Waitlist/).
function siteUrl_() {
  const base = String(CONFIG.CANCEL_URL || '').split('#')[0].split('?')[0];
  return /\/$/.test(base) ? base : base.replace(/\/[^\/]*\.html$/, '') + '/';
}

function money_(amount, currency) {
  const n = (Number(amount) || 0).toFixed(2);
  return String(currency || 'USD').toUpperCase() === 'USD' ? '$' + n : n;
}

function formatDay_(value) {
  const d = value instanceof Date ? value : new Date();
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM d, yyyy');
}

function esc_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* =============================================================
   6. Refunds
   ============================================================= */

// Adds a "ShowUp" menu to the Sheet each time you open it.
// To refund someone (for example a Show-Up Guarantee claim): open the
// Reservations tab, click any cell in their row, then
// ShowUp → Refund selected reservation.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ShowUp')
    .addItem('Refund selected reservation', 'refundSelectedReservation')
    .addSeparator()
    .addItem('Send missing confirmation emails', 'sendMissingConfirmationEmails')
    .addItem('Send me a test email', 'sendTestEmail')
    .addToUi();
}

function refundSelectedReservation() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== CONFIG.RESERVATIONS_SHEET) {
    ui.alert('Open the "' + CONFIG.RESERVATIONS_SHEET + '" tab and click any cell in the row you want to refund.');
    return;
  }
  const rowNumber = sheet.getActiveRange().getRow();
  if (rowNumber < 2) {
    ui.alert('Click any cell in the row of the person you want to refund.');
    return;
  }
  const r = rowObject_(sheet, sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0]);
  const who = (r['First name'] || 'This person') + (r['Email'] ? ' (' + r['Email'] + ')' : '');
  if (r['Refunded at']) {
    ui.alert('Already refunded', who + ' was refunded on ' + formatDay_(r['Refunded at']) + '.', ui.ButtonSet.OK);
    return;
  }
  const where = r['Spot #'] ? ', founding spot #' + r['Spot #'] : '';
  const answer = ui.alert(
    'Refund ' + money_(r['Amount'], r['Currency']) + '?',
    who + where + '.\n\nThis refunds their payment in Stripe, frees their founding spot and emails them.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  const result = refundReservation_(String(r['Stripe session ID'] || ''), 'You (Sheet menu)');
  if (result.ok) {
    ui.alert('Refunded', who + ' will get ' + money_(result.amount, result.currency) + ' back in 5–10 business days. The Refunds tab has the details.', ui.ButtonSet.OK);
  } else {
    ui.alert('Not refunded', 'Stripe didn\'t refund this payment' + (result.message ? ': ' + result.message : '.') +
      '\n\nIf it mentions permissions, give your Stripe key "Refunds: Write".', ui.ButtonSet.OK);
  }
}

// Refund page (refund.html): who is this link for, and is it refundable?
function refundStatus_(ref, t) {
  const found = findByRefundLink_(ref, t);
  if (!found) return { ok: false, error: 'bad_link' };
  const r = found.data;
  return {
    ok: true,
    status: r['Refunded at'] ? 'refunded' : 'active',
    refundsOpen: !!CONFIG.SELF_SERVE_REFUNDS,
    firstName: String(r['First name'] || ''),
    spot: r['Spot #'] || '',
    amount: Number(r['Amount']) || 0,
    currency: String(r['Currency'] || 'USD').toUpperCase(),
    refundedAt: r['Refunded at'] ? formatDay_(r['Refunded at']) : ''
  };
}

// Refund page: the person clicked "Refund".
function selfServeRefund_(ref, t) {
  const found = findByRefundLink_(ref, t);
  if (!found) return { ok: false, error: 'bad_link' };
  const r = found.data;
  if (r['Refunded at']) return { ok: true, already: true, amount: Number(r['Amount']) || 0, currency: String(r['Currency'] || 'USD').toUpperCase() };
  if (!CONFIG.SELF_SERVE_REFUNDS) return { ok: false, error: 'refunds_closed' };
  const result = refundReservation_(String(r['Stripe session ID'] || ''), 'Customer (refund link)');
  if (!result.ok) return { ok: false, error: result.error === 'not_found' ? 'bad_link' : 'refund_failed' }; // no Stripe details to visitors
  return { ok: true, already: !!result.already, amount: result.amount, currency: result.currency };
}

// Refunds one reservation in Stripe and records it. Safe to call twice.
function refundReservation_(sessionId, by) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
    const found = sessionId ? findRow_(sheet, 'Stripe session ID', sessionId) : null;
    if (!found) return { ok: false, error: 'not_found' };
    const r = rowObject_(sheet, found.values);
    const amount = Number(r['Amount']) || 0;
    const currency = String(r['Currency'] || 'USD').toUpperCase();
    if (r['Refunded at']) return { ok: true, already: true, amount: amount, currency: currency };

    let pi = String(r['Stripe payment intent'] || '');
    if (!pi) {
      const s = stripeGet_('/v1/checkout/sessions/' + encodeURIComponent(sessionId));
      pi = s && !s.error ? (typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || '') : '';
    }
    if (!pi) return { ok: false, error: 'refund_failed', message: 'No payment found for this reservation.' };

    // The idempotency key makes Stripe return the same refund if this runs
    // twice, so a payment is never refunded twice.
    let refund = stripePost_('/v1/refunds', {
      payment_intent: pi,
      reason: 'requested_by_customer',
      'metadata[app]': APP_TAG,
      'metadata[ref]': String(r['Reference'] || '')
    }, 'showup-refund-' + sessionId);

    if (refund && refund.error && refund.error.code === 'charge_already_refunded') {
      refund = { id: '(already refunded in Stripe)', amount: Math.round(amount * 100), currency: currency.toLowerCase(), payment_intent: pi };
    }
    if (!refund || refund.error || !refund.id) {
      console.error('Stripe refund failed', refund && refund.error);
      return { ok: false, error: 'refund_failed', message: (refund && refund.error && refund.error.message) || '' };
    }
    recordRefund_(sheet, found.row, r, refund, by);
    return { ok: true, amount: amount, currency: currency };
  } finally {
    lock.releaseLock();
  }
}

// Marks the reservation refunded (freeing the spot), logs it in the Refunds
// tab, updates Checkout started, and emails the person.
function recordRefund_(sheet, rowNumber, r, refund, by) {
  const now = new Date();
  setCell_(sheet, rowNumber, 'Refunded at', now);
  setCell_(sheet, rowNumber, 'Refunded by', by);

  const started = getSheet_(CONFIG.STARTED_SHEET, STARTED_HEADERS);
  const lead = r['Reference'] ? findRow_(started, 'Reference', r['Reference']) : null;
  if (lead) setCell_(started, lead.row, 'Status', 'Refunded');

  const log = getSheet_(CONFIG.REFUNDS_SHEET, REFUND_HEADERS);
  appendRecord_(log, refundRecord_(now, r, refund, by, CONFIRMATION_EMAIL.ENABLED ? 'Sending…' : ''));
  if (CONFIRMATION_EMAIL.ENABLED) setCell_(log, log.getLastRow(), 'Refund email', sendRefundEmail_(r, refund));
}

function refundRecord_(when, r, refund, by, emailStatus) {
  return {
    'Refunded at': when,
    'Reference': clean_(r['Reference'], 20),
    'First name': clean_(r['First name'], 60),
    'Email': clean_(r['Email'], 254),
    'Spot #': r['Spot #'] || '',
    'Amount': (Number(refund.amount) || 0) / 100,
    'Currency': String(refund.currency || r['Currency'] || '').toUpperCase(),
    'Stripe refund ID': clean_(refund.id, 60),
    'Stripe payment intent': clean_(refund.payment_intent || r['Stripe payment intent'], 60),
    'Refunded by': by,
    'Refund email': emailStatus
  };
}

// Part of the 15-minute sync: records refunds you made in the Stripe
// Dashboard, so the Sheet and the founding-spot counter stay right.
function syncRefunds_() {
  const since = Math.floor(Date.now() / 1000) - CONFIG.SYNC_LOOKBACK_DAYS * 86400;
  let startingAfter = '';
  let pages = 0;
  do {
    let path = '/v1/refunds?limit=100&created[gte]=' + since;
    if (startingAfter) path += '&starting_after=' + encodeURIComponent(startingAfter);
    const page = stripeGet_(path);
    if (!page || page.error || !Array.isArray(page.data)) return;

    page.data.forEach(function (refund) {
      if (refund.status !== 'succeeded' && refund.status !== 'pending') return;
      const pi = typeof refund.payment_intent === 'string' ? refund.payment_intent : '';
      if (!pi) return;
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const sheet = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
        const found = findRow_(sheet, 'Stripe payment intent', pi);
        if (!found) return; // not a ShowUp reservation
        const log = getSheet_(CONFIG.REFUNDS_SHEET, REFUND_HEADERS);
        if (findRow_(log, 'Stripe refund ID', refund.id)) return; // already recorded
        const r = rowObject_(sheet, found.values);
        if (r['Refunded at']) return;
        const paid = Math.round((Number(r['Amount']) || 0) * 100);
        if (refund.amount >= paid) {
          recordRefund_(sheet, found.row, r, refund, 'Stripe Dashboard');
        } else {
          // Partial refund: log it, but they keep their spot.
          appendRecord_(log, refundRecord_(new Date(), r, refund, 'Stripe Dashboard (partial, spot kept)', 'Not sent (partial refund)'));
        }
      } finally {
        lock.releaseLock();
      }
    });

    startingAfter = page.has_more && page.data.length ? page.data[page.data.length - 1].id : '';
    pages++;
  } while (startingAfter && pages < 10);
}

function refundUrl_(ref, sessionId) {
  return siteUrl_() + 'refund.html?ref=' + encodeURIComponent(ref) + '&t=' + refundToken_(ref, sessionId);
}

// A private, unguessable token for each reservation's refund link.
function refundToken_(ref, sessionId) {
  const sig = Utilities.computeHmacSha256Signature(String(ref) + ':' + String(sessionId || ''), getRefundSecret_());
  return Utilities.base64EncodeWebSafe(sig).slice(0, 32);
}

function findByRefundLink_(ref, t) {
  if (!/^SU-[A-Z0-9]{6,12}$/.test(ref) || !/^[A-Za-z0-9_-]{32}$/.test(t)) return null;
  const sheet = getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);
  const found = findRow_(sheet, 'Reference', ref);
  if (!found) return null;
  const data = rowObject_(sheet, found.values);
  if (!safeEqual_(refundToken_(ref, data['Stripe session ID']), t)) return null;
  return { row: found.row, data: data };
}

function getRefundSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('REFUND_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('REFUND_SECRET', secret);
  }
  return secret;
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* =============================================================
   Helpers
   ============================================================= */
function getStripeKey_() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('STRIPE_API_KEY') || props.getProperty('STRIPE_SECRET_KEY') || '';
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

// Form-encoded POST to the Stripe API. No Stripe-Version header: the account's
// default API version is used. idempotencyKey (optional) makes retries safe.
function stripePost_(path, params, idempotencyKey) {
  const headers = { Authorization: 'Bearer ' + getStripeKey_() };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = UrlFetchApp.fetch('https://api.stripe.com' + path, {
    method: 'post',
    headers: headers,
    payload: params,
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
  } else {
    // Tabs made by an older version of this script: add any new columns at the end.
    const have = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = headers.filter(function (h) { return have.indexOf(h) < 0; });
    if (missing.length) {
      sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    }
  }
  return sheet;
}

// Appends a row by column name, so each value lands under the right header
// even if the tab has extra, missing or rearranged columns.
function appendRecord_(sheet, record) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map(function (h) { return Object.prototype.hasOwnProperty.call(record, h) ? record[h] : ''; }));
}

function setCell_(sheet, row, header, value) {
  const col = headerIndex_(sheet, header);
  if (col > -1) sheet.getRange(row, col + 1).setValue(value);
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

// Counts requests in a fixed time window using the script cache.
// Returns true once the limit is passed. (Approximate by design: good enough
// to stop floods without slowing real visitors down.)
function rateLimited_(name, limit, windowSeconds) {
  const cache = CacheService.getScriptCache();
  const key = 'rl:' + name + ':' + Math.floor(Date.now() / 1000 / windowSeconds);
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), Math.min(windowSeconds + 60, 21600));
  return count > limit;
}

// Short one-way hash so email addresses aren't stored in the cache.
function hash_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 32);
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
