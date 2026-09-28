/*
 * ShowUp waitlist — site settings
 * ------------------------------------------------------------
 * Fill in the empty fields below. Everything else can stay as is.
 * This file is public (it ships with the website), so NEVER put
 * secret keys here. Your Stripe secret key goes in Google Apps Script
 * (see README.md, step 2).
 */
window.SHOWUP_CONFIG = {
  // Stripe Payment Link for the $9.99 founding reservation.
  // Looks like: "https://buy.stripe.com/xxxxxxxxxxxx"
  STRIPE_PAYMENT_LINK: "",

  // Google Apps Script web app URL (from Deploy → New deployment → Web app).
  // Looks like: "https://script.google.com/macros/s/xxxxxxxx/exec"
  SHEETS_WEB_APP_URL: "",

  // Where people can reach you (shown in the footer and on errors).
  CONTACT_EMAIL: "",

  // Price shown on the page. Must match your Stripe Payment Link.
  PRICE_LABEL: "$9.99",
  REGULAR_PRICE_LABEL: "$14.99",

  // Founding spots per city.
  FOUNDING_CAP: 500,

  // Cities people can pick. Replace with your launch cities.
  // "Other" lets people type their own city.
  CITIES: [
    "",
    "",
    "",
    "Other"
  ]
};
