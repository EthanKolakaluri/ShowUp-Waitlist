# Stripe integration — to-do

This is the single source of truth for finishing the Stripe setup on the ShowUp waitlist site.

The site uses **hosted Stripe Checkout**: when someone submits the reservation form, the Google Apps Script backend creates a Checkout Session and sends them to Stripe's payment page. After paying, Stripe sends them back to `success.html`, and the script confirms the payment with Stripe before adding them to the Google Sheet.

---

## Values to Replace

The following values are placeholders and must be updated before going live.

**Files containing placeholders:**
- [apps-script/Code.gs](apps-script/Code.gs) (the `CONFIG` block at the top)

| Field | Current Value | What to Set |
|-------|--------------|-------------|
| mode (`CONFIG.MODE`) | `payment` | Leave as `payment`: the $9.99 reservation is a one-time charge. Use `subscription` only if you later switch to recurring billing. |
| success_url (`CONFIG.SUCCESS_URL`) | `https://ethankolakaluri.github.io/ShowUp-Waitlist/success.html?session_id={CHECKOUT_SESSION_ID}` | Done. Keep the `{CHECKOUT_SESSION_ID}` template exactly as written. |
| cancel_url (`CONFIG.CANCEL_URL`) | `https://ethankolakaluri.github.io/ShowUp-Waitlist/#reserve` | Done. Where people land if they back out of checkout. |
| line_items[].price (`CONFIG.STRIPE_PRICE_ID`) | `price_...` | Your Stripe Price ID for the $9.99 one-time reservation, from the Dashboard (https://dashboard.stripe.com/prices) or API. |

Until the price is a real value, the form shows "Checkout isn't set up yet" and nothing is sent to Stripe.

### Other empty fields

These aren't Stripe Checkout parameters, but the site needs them to work.

| Where | Field | What to Set |
|-------|-------|-------------|
| Apps Script → Project Settings → Script properties | `STRIPE_API_KEY` | Your Stripe secret key or restricted key (see Setup, step 1). A GitHub secret can't be used for this (see step 1). |
| [assets/js/config.js](assets/js/config.js) | `SHEETS_WEB_APP_URL` | Your Apps Script web app URL (see Setup, step 4). |
| [assets/js/config.js](assets/js/config.js) | `CONTACT_EMAIL` | Your support email. |
| [apps-script/Code.gs](apps-script/Code.gs) | `EXPECTED_AMOUNT_CENTS` | `999` for $9.99. Change it only if your Price amount changes (`1000` for $10.00). |
| [assets/js/config.js](assets/js/config.js) | `LEGAL_NAME` | Your business's legal name (or your full name if you haven't formed a company). Shown in the Terms, Privacy and Refund policy pages. |
| [assets/js/config.js](assets/js/config.js) | `GOVERNING_STATE` | The US state whose laws apply to the Terms, e.g. `California`. |
| [index.html](index.html) (line 12) | `og:image` | `https://ethankolakaluri.github.io/ShowUp-Waitlist/assets/img/og.png`, so shared links show the preview image. |

---

## Configured Parameters

These parameters were configured in Checkout Studio and are already set correctly.

**Files containing these parameters:**
- [apps-script/Code.gs](apps-script/Code.gs) (`CHECKOUT_STUDIO_PARAMS`, plus `mode`, `success_url`, `cancel_url` and `line_items` in `createCheckout_`)

| Parameter | Value |
|-----------|-------|
| mode | `payment` |
| ui_mode | `hosted_page` |
| line_items[].quantity | `1` |
| billing_address_collection | `auto` |
| allow_promotion_codes | `false` |
| submit_type | `auto` |
| integration_identifier | `hosted_mobile_app_0002` |
| origin_context | `mobile_app` |

**Two things to double-check:**

- **`ui_mode` and your API version.** The backend calls Stripe's REST API directly from Google Apps Script (there is no Stripe SDK), so no SDK version decides this. No `Stripe-Version` header is sent, so Stripe uses your account's default API version. `hosted_page` is the name in newer API versions; older versions call it `hosted`. If your first test checkout fails with an error mentioning `ui_mode`, change `ui_mode: 'hosted_page'` to `ui_mode: 'hosted'` in `CHECKOUT_STUDIO_PARAMS`.
- **`origin_context` is `mobile_app`.** That's what Checkout Studio exported, but this is a website. If you meant to pick web, change it in Checkout Studio and update the value in `Code.gs` to match.

**Added by the site (not from Checkout Studio):** `client_reference_id`, `customer_email`, `metadata[app]` and `metadata[ref]`. They pre-fill the buyer's email and link each payment back to their row in the Sheet. The backend only counts sessions tagged `metadata[app] = showup-waitlist`, so other payments on your Stripe account never show up as reservations.

---

## Setup and next steps

### 1. API keys

- Get your keys at https://dashboard.stripe.com/test/apikeys (test mode first).
- You only need the **secret key**. Hosted Checkout doesn't use a publishable key on the page.
- Safest option: create a **restricted key** with **Checkout Sessions: Write** and **Refunds: Write** (write includes read). It can create and look up checkout sessions and refunds, and nothing else.
- Put it in Google Apps Script, not in a file: **Project Settings → Script properties → Add script property**, name `STRIPE_API_KEY`. Script properties are the Apps Script equivalent of environment variables.
- **Why not a GitHub secret?** GitHub Pages only serves static files, and only GitHub Actions workflows can read repository secrets. Neither the website nor the Apps Script can read them, and the Stripe call runs in the Apps Script. Never inject the key into the site's files, because everything on Pages is public. You can keep or delete the `STRIPE_API_KEY` GitHub secret; nothing uses it.
- There's no `.env` file and nothing to install: the site is static and the backend is Apps Script.

### 2. Create the product

1. Dashboard → **Product catalog → Add product**: "ShowUp Founding 500 reservation".
2. Pricing: **One-off**, **$9.99 USD**.
3. Copy the Price ID (`price_…`) into `CONFIG.STRIPE_PRICE_ID` in `apps-script/Code.gs`.

### 3. Fill in the success and cancel URLs

Set `CONFIG.SUCCESS_URL` and `CONFIG.CANCEL_URL` in `apps-script/Code.gs` using the values in the table above.

### 4. Deploy the Apps Script

1. Create a Google Sheet, then **Extensions → Apps Script**.
2. Paste all of `apps-script/Code.gs` (with your values filled in) and save.
3. Add the `STRIPE_API_KEY` script property (step 1).
4. Select `setup` in the toolbar and click **Run**, then approve permissions. Tick **Select all**: spreadsheets, external service, run when you're not present, send email as you, see your email address (only used by `sendTestEmail`), and display prompts inside Google apps (the ShowUp menu's confirm boxes). This creates the **Checkout started**, **Reservations** and **Refunds** tabs, a secret for refund links (`REFUND_SECRET` in Script properties; don't share or change it, or existing refund links stop working) and a 15-minute sync.
   - Optional: select `sendTestEmail` and click **Run** to get the confirmation email in your own inbox.
5. **Deploy → New deployment → Web app**, Execute as **Me**, Who has access **Anyone**. Copy the URL into `SHEETS_WEB_APP_URL` in `assets/js/config.js` and commit it to the repo.
6. After any later change to `Code.gs`: run `setup` once (so Google can ask for any new permission), then **Deploy → Manage deployments → Edit → Version: New version**. The URL stays the same. If you skip the permission step after a change that needs a new one, the web app stops working until you approve it.

### 5. GitHub Pages

Repo **Settings → Pages → Deploy from a branch → `main` / `(root)`**. The site goes live at `https://ethankolakaluri.github.io/ShowUp-Waitlist/`.

### Files involved

```
apps-script/Code.gs      Creates Checkout Sessions (action "checkout"), confirms payments,
                         writes the Sheet, sends the emails, makes refunds (actions
                         "refund_status" and "refund", plus the ShowUp menu in the Sheet),
                         15-minute sync. All Stripe calls live here.
assets/js/config.js      SHEETS_WEB_APP_URL and site settings (no secrets)
assets/js/main.js        Form → calls the Apps Script → redirects to Stripe Checkout
assets/js/success.js     Confirms the payment on return and shows "You're in"
success.html             The page Stripe redirects to after payment (with the refund link)
refund.html + assets/js/refund.js   Self-serve refund page (link from the email / success page)
terms.html, privacy.html, refunds.html   Policy pages (fill-ins come from config.js)
STRIPE_INTEGRATION_TODO.md  This file
```

### How it works

1. A visitor fills in the form and clicks **Continue to secure checkout**.
2. `main.js` sends the form to the Apps Script (`action: "checkout"`).
3. The script logs them in **Checkout started**, then calls `POST /v1/checkout/sessions` with the Checkout Studio parameters, your Price, the success and cancel URLs, their email and a reference ID.
4. The browser is sent to the session's Stripe-hosted `url`, and the visitor pays.
5. Stripe redirects to `success.html?session_id=cs_…`. The page asks the script to confirm. The script fetches the session from Stripe, checks it's paid, tagged `showup-waitlist`, $9.99 USD, then adds a **Reservations** row, marks the **Checkout started** row **Paid**, and emails them a "You're in" confirmation.
6. If someone closes the tab before step 5, the 15-minute sync finds their paid session on Stripe, adds them and emails them anyway.

### Refunds

- **Self-serve, before launch.** The confirmation email and the success page carry a private link to `refund.html?ref=…&t=…`. The `t` part is a signature made with `REFUND_SECRET`, so a link only works for its own reservation. The page shows what they'll give up, then one click calls `POST /v1/refunds` for the payment (with an idempotency key, so it can't refund twice).
- **What a refund does:** marks the **Reservations** row (**Refunded at**, **Refunded by**), adds a row to the **Refunds** tab, marks **Checkout started** as **Refunded**, frees the founding spot in the counter (spot numbers are never reused), and emails them a refund confirmation.
- **You refunding someone** (for example a Show-Up Guarantee claim): open the Sheet, go to **Reservations**, click any cell in their row, then **ShowUp → Refund selected reservation**. The ShowUp menu appears a few seconds after the Sheet opens.
- **Refunds made in the Stripe Dashboard** are picked up by the 15-minute sync. A full refund frees the spot; a partial one is logged in **Refunds** and they keep their spot.
- **At launch:** set `SELF_SERVE_REFUNDS: false` in `Code.gs` and deploy a new version. Refund links then say refunds by link have closed; the Sheet menu still works.

### Testing (test mode)

Use your **test** secret key and a **test-mode** Price, then reserve on the live site with:

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0025 0000 3155` | Asks for 3D Secure authentication |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

Use any future expiry date, any 3-digit CVC and any ZIP. After a successful payment you should see "You're in", a new **Reservations** row with **Confirmation email** set to **Sent**, the confirmation in the inbox you paid with, and the **Checkout started** row marked **Paid**. Test payments show up at https://dashboard.stripe.com/test/payments.

### Next steps

- **Go live:** create the product and Price in live mode, then swap in the live Price ID and live secret key. Redeploy the Apps Script as a new version.
- **Receipts:** the script sends the "You're in" email. For Stripe's own payment receipt as well, turn on **Settings → Customer emails → Successful payments** (Stripe only sends these in live mode).
- **Confirmation emails:** they come from the Gmail account that owns the script, named "ShowUp". Free Gmail accounts can email 100 people a day; anyone past that shows **Waiting (daily email limit)** in the Sheet and is emailed automatically once the limit resets. To resend one, clear its **Confirmation email** cell and run `sendMissingConfirmationEmails`. Settings are in `CONFIRMATION_EMAIL` in `Code.gs`.
- **Show-Up Guarantee refunds:** use **ShowUp → Refund selected reservation** in the Sheet (see Refunds above).
- **Order tracking:** the **Reservations** tab is your list of paying founding members, numbered #1–500. Once 500 spots are held (refunds free a spot), checkout closes and the form says so. The Sheet reads and writes columns by their header names, so you can reorder or delete columns you don't need (like an old **City** column) without breaking anything.
- **Before taking real money:** fill in `LEGAL_NAME`, `GOVERNING_STATE` and `CONTACT_EMAIL` in `config.js` (the policy pages highlight them until you do), and have someone qualified review the Terms, Privacy Policy and Refund Policy.

### Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
