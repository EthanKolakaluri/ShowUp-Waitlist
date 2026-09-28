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
| success_url (`CONFIG.SUCCESS_URL`) | `https://example.com/success.html?session_id={CHECKOUT_SESSION_ID}` | Your live success page. For this repo: `https://ethankolakaluri.github.io/ShowUp-Waitlist/success.html?session_id={CHECKOUT_SESSION_ID}`. Keep the `{CHECKOUT_SESSION_ID}` template exactly as written. |
| cancel_url (`CONFIG.CANCEL_URL`) | `https://example.com/#reserve` | Where people land if they back out of checkout. For this repo: `https://ethankolakaluri.github.io/ShowUp-Waitlist/#reserve` |
| line_items[].price (`CONFIG.STRIPE_PRICE_ID`) | `price_...` | Your Stripe Price ID for the $9.99 one-time reservation, from the Dashboard (https://dashboard.stripe.com/prices) or API. |

Until all four are real values, the form shows "Checkout isn't set up yet" and nothing is sent to Stripe.

### Other empty fields

These aren't Stripe Checkout parameters, but the site needs them to work.

| Where | Field | What to Set |
|-------|-------|-------------|
| Apps Script → Project Settings → Script properties | `STRIPE_API_KEY` | Your Stripe secret key or restricted key (see Setup, step 1). A GitHub secret can't be used for this (see step 1). |
| [assets/js/config.js](assets/js/config.js) | `SHEETS_WEB_APP_URL` | Your Apps Script web app URL (see Setup, step 4). |
| [assets/js/config.js](assets/js/config.js) | `CONTACT_EMAIL` | Your support email. |
| [assets/js/config.js](assets/js/config.js) | `CITIES` | Your launch cities, with `"Other"` last. |
| [apps-script/Code.gs](apps-script/Code.gs) | `EXPECTED_AMOUNT_CENTS` | `999` for $9.99. Change it only if your Price amount changes (`1000` for $10.00). |
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
- Safest option: create a **restricted key** with **Checkout Sessions: Write** permission (write includes read). It can create and look up checkout sessions and nothing else.
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
4. Select `setup` in the toolbar and click **Run**, then approve permissions. This creates the **Checkout started** and **Reservations** tabs and a 15-minute payment sync.
5. **Deploy → New deployment → Web app**, Execute as **Me**, Who has access **Anyone**. Copy the URL into `SHEETS_WEB_APP_URL` in `assets/js/config.js` and commit it to the repo.
6. After any later change to `Code.gs`: **Deploy → Manage deployments → Edit → Version: New version**. The URL stays the same.

### 5. GitHub Pages

Repo **Settings → Pages → Deploy from a branch → `main` / `(root)`**. The site goes live at `https://ethankolakaluri.github.io/ShowUp-Waitlist/`.

### Files involved

```
apps-script/Code.gs      Creates Checkout Sessions (action "checkout"), confirms payments,
                         writes the Sheet, 15-minute sync. All Stripe calls live here.
assets/js/config.js      SHEETS_WEB_APP_URL and site settings (no secrets)
assets/js/main.js        Form → calls the Apps Script → redirects to Stripe Checkout
assets/js/success.js     Confirms the payment on return and shows "You're in"
success.html             The page Stripe redirects to after payment
STRIPE_INTEGRATION_TODO.md  This file
```

### How it works

1. A visitor fills in the form and clicks **Continue to secure checkout**.
2. `main.js` sends the form to the Apps Script (`action: "checkout"`).
3. The script logs them in **Checkout started**, then calls `POST /v1/checkout/sessions` with the Checkout Studio parameters, your Price, the success and cancel URLs, their email and a reference ID.
4. The browser is sent to the session's Stripe-hosted `url`, and the visitor pays.
5. Stripe redirects to `success.html?session_id=cs_…`. The page asks the script to confirm. The script fetches the session from Stripe, checks it's paid, tagged `showup-waitlist`, $9.99 USD, then adds a **Reservations** row and marks the **Checkout started** row **Paid**.
6. If someone closes the tab before step 5, the 15-minute sync finds their paid session on Stripe and adds them anyway.

### Testing (test mode)

Use your **test** secret key and a **test-mode** Price, then reserve on the live site with:

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0025 0000 3155` | Asks for 3D Secure authentication |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

Use any future expiry date, any 3-digit CVC and any ZIP. After a successful payment you should see "You're in", a new **Reservations** row, and the **Checkout started** row marked **Paid**. Test payments show up at https://dashboard.stripe.com/test/payments.

### Next steps

- **Go live:** create the product and Price in live mode, then swap in the live Price ID and live secret key. Redeploy the Apps Script as a new version.
- **Receipts:** turn on emailed receipts under **Settings → Customer emails → Successful payments**.
- **Show-Up Guarantee refunds:** refund the $9.99 from the payment in the Stripe Dashboard. You can find it via the Stripe session ID in the Sheet.
- **Order tracking:** the **Reservations** tab is your list of paying founding members, with city spot numbers for the Founding 500 cap.
- **Before taking real money:** add terms, privacy and refund policy pages and link them in the site footer.

### Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
