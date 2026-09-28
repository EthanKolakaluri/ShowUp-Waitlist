# ShowUp — Founding 500 waitlist

The waitlist site for ShowUp. People reserve a Founding 500 spot for a one-time **$9.99** (which also covers their first month after launch). Payment runs through a **Stripe Payment Link**, and every paid reservation lands in a **Google Sheet**.

It's a plain static site, so it runs on **GitHub Pages** with no server.

```
index.html              Landing page + reservation form
success.html            Where Stripe sends people after paying; confirms the spot
assets/js/config.js     ← your settings (Stripe link, Sheet URL, cities…)
assets/js/main.js       Animations, form, founding-spot counter
assets/js/success.js    Payment confirmation + confetti
assets/css/styles.css   All styling
assets/img/             Logo, favicon, social preview image
apps-script/Code.gs     ← paste into your Google Sheet (Extensions → Apps Script)
```

## How a reservation flows

1. A visitor fills in the form (name, email, city, age, interests).
2. The site logs them in the Sheet's **Checkout started** tab, then sends them to your Stripe Payment Link with their email pre-filled and a reference ID attached.
3. They pay on Stripe. Stripe redirects them to `success.html?session_id=…`.
4. `success.html` asks your Apps Script to confirm. The script checks with **Stripe directly** that the session is paid (right link, right amount), then adds a row to the **Reservations** tab and marks their "Checkout started" row as **Paid**.
5. If someone closes the tab before step 4, a sync that runs every 15 minutes finds their payment on Stripe and adds them anyway.

Your Stripe secret key lives only inside Google Apps Script. It is never in this repo or on the public site.

---

## Fill in these fields

| Where | Field | What goes there |
|---|---|---|
| `assets/js/config.js` | `STRIPE_PAYMENT_LINK` | Your Payment Link URL, e.g. `https://buy.stripe.com/...` |
| `assets/js/config.js` | `SHEETS_WEB_APP_URL` | Your Apps Script web app URL, e.g. `https://script.google.com/macros/s/.../exec` |
| `assets/js/config.js` | `CONTACT_EMAIL` | Support email shown in the footer and on errors |
| `assets/js/config.js` | `CITIES` | Your launch cities (keep `"Other"` last). Leave the list empty and the form shows a free-text city box instead |
| `assets/js/config.js` | `PRICE_LABEL` | Only if your price isn't $9.99 |
| `index.html` (line 12) | `og:image` | The full URL of the preview image, e.g. `https://YOUR-GITHUB-USERNAME.github.io/showup-waitlist/assets/img/og.png`, so link previews show on iMessage, X, Slack etc. |
| `apps-script/Code.gs` | `PAYMENT_LINK_ID` | The Payment Link's ID, starting with `plink_` |
| `apps-script/Code.gs` | `EXPECTED_AMOUNT_CENTS` | Price in cents. `999` for $9.99, `1000` for $10.00 |
| Apps Script → Project Settings → Script properties | `STRIPE_SECRET_KEY` | A Stripe secret or restricted key (see step 2) |

Until `STRIPE_PAYMENT_LINK` is filled in, the form shows "Checkout isn't connected yet" instead of sending people anywhere. Until `SHEETS_WEB_APP_URL` is filled in, nothing is logged and the founding-spot counter stays hidden.

---

## Setup (about 20 minutes)

Do everything in **Stripe test mode** first, then repeat steps 1 and 2 with live keys when you're ready.

### 1. Stripe Payment Link

1. In Stripe, create a product such as **ShowUp Founding 500 reservation** with a **one-time** price of **$9.99 USD**.
2. Create a **Payment Link** for it.
3. Under **After payment**, choose to redirect customers to your website, and use:
   ```
   https://YOUR-GITHUB-USERNAME.github.io/showup-waitlist/success.html?session_id={CHECKOUT_SESSION_ID}
   ```
   Keep `{CHECKOUT_SESSION_ID}` exactly as written. Stripe swaps in the real ID.
4. Copy the link URL into `STRIPE_PAYMENT_LINK` in `assets/js/config.js`.
5. Copy the link's ID (`plink_…`, shown on the Payment Link's page in the dashboard) into `PAYMENT_LINK_ID` in `apps-script/Code.gs`.

The site adds the visitor's email (`prefilled_email`) and a reference ID (`client_reference_id`) to the link automatically. If Stripe ever rejects either one, check the Payment Link's settings in your dashboard.

### 2. Google Sheet + Apps Script

1. Create a new Google Sheet (e.g. "ShowUp waitlist").
2. **Extensions → Apps Script**. Delete the starter code and paste in all of `apps-script/Code.gs`. Fill in the `CONFIG` block at the top. Save.
3. **Project Settings (gear icon) → Script properties → Add script property**
   - Property: `STRIPE_SECRET_KEY`
   - Value: your Stripe key. The safest choice is a **restricted key** with **read** access to **Checkout Sessions** only. Use the `test` key while testing.
4. Back in the editor, choose the `setup` function and click **Run**. Approve the permissions prompt. This creates the **Checkout started** and **Reservations** tabs and the 15-minute sync.
5. **Deploy → New deployment → Select type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** into `SHEETS_WEB_APP_URL` in `assets/js/config.js`.

If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version**. That keeps the same URL.

### 3. GitHub Pages

1. Push this folder to a public GitHub repo named `showup-waitlist`.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. The site goes live at `https://YOUR-GITHUB-USERNAME.github.io/showup-waitlist/` within a minute or two.

### 4. Test it end to end

1. Open the live site and reserve with Stripe's test card **4242 4242 4242 4242** (any future date, any CVC).
2. You should land on the "You're in" page with confetti.
3. Check the Sheet: a row in **Reservations**, and the matching **Checkout started** row marked **Paid**.
4. The founding-spot counter on the site updates on the next page load.

### 5. Go live

Create a live-mode product and Payment Link, then update `STRIPE_PAYMENT_LINK`, `PAYMENT_LINK_ID`, and the `STRIPE_SECRET_KEY` script property with live values. Redeploy the Apps Script as a new version and push the config change.

---

## Before you take real payments

- **Terms, privacy and refunds.** Stripe generally expects your site to show terms, a privacy policy and a refund policy. Add pages for these and link them in the footer. The Show-Up Guarantee should be written out in those terms.
- **Contact email.** Fill in `CONTACT_EMAIL` so people can reach you.
- **Launch cities.** Replace the empty `CITIES` entries with the cities you're opening in.

## Sheet columns

**Checkout started:** Started at, Reference, First name, Email, City, Age range, Interests, Status, Page

**Reservations:** Paid at, Reference, First name, Email, City, Age range, Interests, City spot #, Amount, Currency, Stripe session ID, Stripe payment intent, Confirmed by
