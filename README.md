# ShowUp — Founding 500 waitlist

The waitlist site for ShowUp. People reserve a Founding 500 spot for a one-time **$9.99** (which also covers their first month after launch). Payment runs through **hosted Stripe Checkout**, and every paid reservation lands in a **Google Sheet**.

It's a plain static site on **GitHub Pages**. The only backend is a Google Apps Script attached to your Sheet, which talks to Stripe.

**To finish setup, follow [STRIPE_INTEGRATION_TODO.md](STRIPE_INTEGRATION_TODO.md).** It lists every value to fill in and every step, in order.

```
index.html                  Landing page + reservation form
success.html                Where Stripe sends people after paying; confirms the spot
refund.html                 Self-serve refund page (private link from the email)
terms.html, privacy.html, refunds.html   Policy pages
assets/js/config.js         ← your settings (Apps Script URL, contact email, legal name…)
assets/js/main.js           Animations, form, founding-spot counter, redirect to Stripe
assets/js/success.js        Payment confirmation + confetti
assets/js/refund.js         Refund page
assets/js/pages.js          Footer + policy-page fill-ins on the secondary pages
assets/css/styles.css       All styling
assets/img/                 Logo, favicon, social preview image
apps-script/Code.gs         ← paste into your Google Sheet (Extensions → Apps Script)
STRIPE_INTEGRATION_TODO.md  ← setup checklist
```

## How a reservation flows

1. A visitor fills in the form (name, email, age, interests).
2. The site sends it to your Apps Script, which logs them in the Sheet's **Checkout started** tab and creates a Stripe Checkout Session.
3. They pay on Stripe's hosted checkout page. Stripe redirects them to `success.html?session_id=…`.
4. `success.html` asks the Apps Script to confirm. The script checks with **Stripe directly** that the session is paid, is a ShowUp reservation and is the right amount. It then adds a row to **Reservations**, marks their **Checkout started** row as **Paid**, and emails them a "You're in" confirmation from your Gmail.
5. If someone closes the tab before step 4, a sync that runs every 15 minutes finds their payment on Stripe, adds them and emails them anyway.

Your Stripe secret key lives only inside Google Apps Script. It is never in this repo or on the public site.

## What happens before setup is finished

- **`SHEETS_WEB_APP_URL` empty:** the form shows "Checkout isn't connected yet" and the founding-spot counter stays hidden.
- **Stripe placeholders still in `Code.gs`:** the form shows "Checkout isn't set up yet" and nothing is sent to Stripe.

## Sheet columns

**Checkout started:** Started at, Reference, First name, Email, Age range, Interests, Status, Page

**Reservations:** Paid at, Reference, First name, Email, Age range, Interests, Spot #, Amount, Currency, Stripe session ID, Stripe payment intent, Confirmed by, Confirmation email, Refunded at, Refunded by

**Refunds:** Refunded at, Reference, First name, Email, Spot #, Amount, Currency, Stripe refund ID, Stripe payment intent, Refunded by, Refund email

## Before you take real payments

- **Terms, privacy and refunds.** Drafts are in `terms.html`, `privacy.html` and `refunds.html`, linked from the footer and the checkout checkbox. Fill in `LEGAL_NAME`, `GOVERNING_STATE` and `CONTACT_EMAIL` in `assets/js/config.js`, and have them reviewed before you rely on them.
- **Contact email.** Fill in `CONTACT_EMAIL` in `assets/js/config.js`.
