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
 *   4. Returns founding-spot counts per city for the website's counter.
 *   5. A 15-minute sync catches anyone who paid but closed the tab before
 *      the success page loaded, and sends emails held back by Gmail's
 *      daily limit.
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
 *     used to send mail to strangers. Names and cities are escaped.
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

  // Founding spots per city (keep in sync with assets/js/config.js).
  FOUNDING_CAP: 500,

  // How far back the sync looks for paid checkouts, in days.
  SYNC_LOOKBACK_DAYS: 3,

  STARTED_SHEET: 'Checkout started',
  RESERVATIONS_SHEET: 'Reservations'
};

// Anti-spam limits. Generous for real visitors, tight enough to stop a script
// from flooding the Sheet or using up the daily outside-request quota.
const RATE_LIMITS = {
  CHECKOUTS_PER_EMAIL_PER_HOUR: 5,     // one person retrying checkout
  CHECKOUTS_PER_10_MIN: 120,           // everyone combined
  CONFIRMS_PER_10_MIN: 300             // success-page checks, everyone combined
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
  REPLY_TO: ''
};

// Tag on every session this site creates, so the Sheet only counts ShowUp reservations.
const APP_TAG = 'showup-waitlist';

const STARTED_HEADERS = ['Started at', 'Reference', 'First name', 'Email', 'City', 'Age range', 'Interests', 'Status', 'Page'];
const RESERVATION_HEADERS = ['Paid at', 'Reference', 'First name', 'Email', 'City', 'Age range', 'Interests', 'City spot #', 'Amount', 'Currency', 'Stripe session ID', 'Stripe payment intent', 'Confirmed by', 'Confirmation email'];
const EMAIL_WAITING = 'Waiting (daily email limit)';

/* =============================================================
   One-time setup — run this once from the Apps Script editor
   ============================================================= */
function setup() {
  getSheet_(CONFIG.STARTED_SHEET, STARTED_HEADERS);
  getSheet_(CONFIG.RESERVATIONS_SHEET, RESERVATION_HEADERS);

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
    source,
    CONFIRMATION_EMAIL.ENABLED ? 'Sending…' : ''
  ];
  reservations.appendRow(row);

  if (lead) {
    const statusCol = headerIndex_(started, 'Status') + 1;
    started.getRange(lead.row, statusCol).setValue('Paid');
  }

  if (CONFIRMATION_EMAIL.ENABLED) {
    const status = sendConfirmation_(rowObject_(reservations, row));
    setCell_(reservations, reservations.getLastRow(), 'Confirmation email', status);
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
  if (CONFIRMATION_EMAIL.ENABLED) sendConfirmationEmails_(function (status) { return status === EMAIL_WAITING; });
  if (!getStripeKey_()) return;
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
   5. Confirmation email
   ============================================================= */

// Run from the editor to see the email yourself (it goes to your own Gmail).
function sendTestEmail() {
  const to = Session.getEffectiveUser().getEmail();
  const status = sendConfirmation_({
    'Email': to, 'First name': 'Maya', 'City': 'Los Angeles', 'City spot #': 12,
    'Amount': (CONFIG.EXPECTED_AMOUNT_CENTS || 999) / 100, 'Currency': 'USD',
    'Reference': 'SU-TEST1234', 'Paid at': new Date()
  });
  Logger.log(status.indexOf('Sent') === 0 ? 'Test email sent to ' + to + '. Check your inbox (and spam).' : 'Test email not sent: ' + status);
}

// Run from the editor to email everyone in Reservations whose
// "Confirmation email" cell is empty: people who reserved before emails were
// turned on, or rows where you cleared the cell to send it again.
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
    const values = sheet.getDataRange().getValues();
    let sent = 0;
    for (let r = 1; r < values.length; r++) {
      if (!shouldSend(String(values[r][col] || ''))) continue;
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

// Sends the email for one reservation (an object keyed by column header) and
// returns what to write in its "Confirmation email" cell.
function sendConfirmation_(r) {
  const to = String(r['Email'] || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return 'Not sent: no valid email';
  if (MailApp.getRemainingDailyQuota() < 1) return EMAIL_WAITING;
  try {
    const msg = confirmationMessage_(r);
    const options = { to: to, subject: msg.subject, body: msg.text, htmlBody: msg.html, name: CONFIRMATION_EMAIL.FROM_NAME };
    if (CONFIRMATION_EMAIL.REPLY_TO) options.replyTo = CONFIRMATION_EMAIL.REPLY_TO;
    MailApp.sendEmail(options);
    return 'Sent ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  } catch (err) {
    console.error('Confirmation email failed', err);
    if (/too many times|quota|limit/i.test(String(err))) return EMAIL_WAITING;
    return 'Failed: ' + String((err && err.message) || err).slice(0, 120);
  }
}

function confirmationMessage_(r) {
  const site = siteUrl_();
  const name = String(r['First name'] || '').trim();
  const city = String(r['City'] || '').trim();
  const spot = Number(r['City spot #']) || 0;
  const ref = String(r['Reference'] || '').trim();
  const currency = String(r['Currency'] || 'USD').toUpperCase();
  const price = money_(r['Amount'], currency);
  const paidAt = r['Paid at'] instanceof Date ? r['Paid at'] : new Date();
  const date = Utilities.formatDate(paidAt, Session.getScriptTimeZone(), 'MMM d, yyyy');
  const cap = CONFIG.FOUNDING_CAP;

  const hello = name ? "You're in, " + name : "You're in";
  const subject = spot && city
    ? hello + '! Founding spot #' + spot + ' in ' + city
    : hello + '! Your ShowUp spot is reserved';
  const lead = 'Your founding spot is reserved. Your ' + price + ' also covers your first month after launch, so there\'s nothing else to pay until month two.';
  const spotLine = spot && city ? 'of ' + cap + ' founding spots in ' + city : '';
  const steps = [
    "We'll email you before launch to finish your match quiz.",
    'At launch, you get your crew and your first AI-planned hangout.',
    'From month two, Crew is ' + price + '/mo, locked in while you\'re a member.'
  ];
  const guarantee = "Go to 3 hangouts in your first 30 days. If you haven't met at least one person you want to see again, we refund your first month in full.";
  const invite = 'mailto:?subject=' + encodeURIComponent('Come to ShowUp with me') +
    '&body=' + encodeURIComponent('I just reserved a founding spot on ShowUp. It matches you with a crew and plans the hangouts for you. Grab a spot before they\'re gone: ' + site);

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
    'ShowUp'
  ].filter(function (line, i, all) { return line !== '' || all[i - 1] !== ''; }).join('\n');

  const F_HEAD = "'Bricolage Grotesque','Helvetica Neue',Helvetica,Arial,sans-serif";
  const F_BODY = "'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif";
  const row = function (label, value) {
    return '<tr><td style="padding:6px 0;font:14px/1.4 ' + F_BODY + ';color:#7A6A5F;">' + esc_(label) + '</td>' +
      '<td align="right" style="padding:6px 0;font:600 14px/1.4 ' + F_BODY + ';color:#2B211C;">' + esc_(value) + '</td></tr>';
  };

  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">' +
    '<title>' + esc_(subject) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=DM+Sans:wght@400;600&display=swap" rel="stylesheet">' +
    '</head><body style="margin:0;padding:0;background:#FBF6EE;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc_(spotLine ? 'Spot #' + spot + ' ' + spotLine + '. ' + lead : lead) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBF6EE;"><tr><td align="center" style="padding:32px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">' +

    // Logo
    '<tr><td style="padding:0 4px 20px;"><a href="' + esc_(site) + '" style="text-decoration:none;">' +
    '<img src="' + esc_(site + 'assets/img/email-logo.png') + '" width="132" alt="showup" style="display:block;border:0;width:132px;height:auto;font:800 28px ' + F_HEAD + ';color:#2B211C;"></a></td></tr>' +

    // Card
    '<tr><td style="background:#FFFDF9;border:1px solid #F0E4D7;border-radius:24px;padding:36px 32px;">' +
    '<p style="margin:0 0 14px;"><span style="display:inline-block;background:#FFE4D9;color:#C8401C;border-radius:999px;padding:5px 12px;font:600 12px/1 ' + F_BODY + ';letter-spacing:.08em;text-transform:uppercase;">Founding ' + esc_(cap) + '</span></p>' +
    '<h1 style="margin:0 0 12px;font:800 34px/1.1 ' + F_HEAD + ';color:#2B211C;letter-spacing:-.02em;">' + esc_(hello) + '.</h1>' +
    '<p style="margin:0 0 24px;font:16px/1.6 ' + F_BODY + ';color:#5C4F46;">' + esc_(lead) + '</p>' +

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

    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #F0E4D7;border-bottom:1px solid #F0E4D7;margin:0 0 28px;">' +
    '<tr><td colspan="2" style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>' +
    row('Paid', price + ' ' + currency) + row('Date', date) + (ref ? row('Reference', ref) : '') +
    '<tr><td colspan="2" style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>' +
    '</table>' +

    '<p style="margin:0 0 10px;font:15px/1.5 ' + F_BODY + ';color:#5C4F46;">Know someone who\'d come along?</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#C8401C;border-radius:999px;">' +
    '<a href="' + esc_(invite) + '" style="display:inline-block;padding:13px 24px;font:600 15px/1 ' + F_BODY + ';color:#FFFDF9;text-decoration:none;">Invite a friend</a>' +
    '</td></tr></table>' +
    '</td></tr>' +

    // Footer
    '<tr><td style="padding:22px 4px 0;font:13px/1.6 ' + F_BODY + ';color:#7A6A5F;">' +
    'Questions? Just reply to this email.<br>' +
    'You\'re getting this because you reserved a founding spot at <a href="' + esc_(site) + '" style="color:#C8401C;">ShowUp</a>.' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';

  return { subject: subject, text: text, html: html };
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

function esc_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
// default API version is used.
function stripePost_(path, params) {
  const res = UrlFetchApp.fetch('https://api.stripe.com' + path, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + getStripeKey_() },
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
