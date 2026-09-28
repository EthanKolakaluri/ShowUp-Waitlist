# ShowUp — Founding 500 waitlist

The waitlist site for ShowUp. People reserve a Founding 500 spot for a one-time **$9.99** (which also covers their first month after launch). Payment runs through **hosted Stripe Checkout**, and every paid reservation lands in a **Google Sheet**.

It's a plain static site on **GitHub Pages**. The only backend is a Google Apps Script attached to your Sheet, which talks to Stripe.

**To finish setup, follow [STRIPE_INTEGRATION_TODO.md](STRIPE_INTEGRATION_TODO.md).** It lists every value to fill in and every step, in order.

```
index.html                  Landing page + reservation form
success.html                Where Stripe sends people after paying; confirms the spot
assets/js/config.js         ← your settings (Apps Script URL, contact email, cities…)
assets/js/main.js           Animations, form, founding-spot counter, redirect to Stripe
assets/js/success.js        Payment confirmation + confetti
assets/css/styles.css       All styling
assets/img/                 Logo, favicon, social preview image
apps-script/Code.gs         ← paste into your Google Sheet (Extensions → Apps Script)
STRIPE_INTEGRATION_TODO.md  ← setup checklist
```

## How a reservation flows

1. A visitor fills in the form (name, email, city, age, interests).
2. The site sends it to your Apps Script, which logs them in the Sheet's **Checkout started** tab and creates a Stripe Checkout Session.
3. They pay on Stripe's hosted checkout page. Stripe redirects them to `success.html?session_id=…`.
4. `success.html` asks the Apps Script to confirm. The script checks with **Stripe directly** that the session is paid, is a ShowUp reservation and is the right amount. It then adds a row to **Reservations**, marks their **Checkout started** row as **Paid**, and emails them a "You're in" confirmation from your Gmail.
5. If someone closes the tab before step 4, a sync that runs every 15 minutes finds their payment on Stripe, adds them and emails them anyway.

Your Stripe secret key lives only inside Google Apps Script. It is never in this repo or on the public site.

## What happens before setup is finished

- **`SHEETS_WEB_APP_URL` empty:** the form shows "Checkout isn't connected yet" and the founding-spot counter stays hidden.
- **Stripe placeholders still in `Code.gs`:** the form shows "Checkout isn't set up yet" and nothing is sent to Stripe.
- **`CITIES` empty:** the form shows a free-text city box instead of a dropdown.

## Sheet columns

**Checkout started:** Started at, Reference, First name, Email, City, Age range, Interests, Status, Page

**Reservations:** Paid at, Reference, First name, Email, City, Age range, Interests, City spot #, Amount, Currency, Stripe session ID, Stripe payment intent, Confirmed by, Confirmation email

## Before you take real payments

- **Terms, privacy and refunds.** Stripe generally expects your site to show terms, a privacy policy and a refund policy. Add pages for these and link them in the footer, and write the Show-Up Guarantee into those terms.
- **Contact email and launch cities.** Fill in `CONTACT_EMAIL` and `CITIES` in `assets/js/config.js`.
