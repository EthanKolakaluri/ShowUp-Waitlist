/*
 * ShowUp waitlist — site settings
 * ------------------------------------------------------------
 * Fill in the empty fields below. Everything else can stay as is.
 * This file is public (it ships with the website), so NEVER put
 * secret keys here. Your Stripe secret key goes in Google Apps Script
 * (see README.md, step 2).
 */
window.SHOWUP_CONFIG = {
  // Google Apps Script web app URL (from Deploy → New deployment → Web app).
  // This one URL creates the Stripe Checkout, confirms payments and writes
  // to your Google Sheet.
  // Looks like: "https://script.google.com/macros/s/xxxxxxxx/exec"
  SHEETS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycbxguxZi3bknVVr6KeDVV8QBTxEiAopRP3J3dk9AaJ8ivSBafdfVF1J5OxmwMN8bd03T/exec",

  // Where people can reach you (shown in the footer and on errors).
  CONTACT_EMAIL: "",

  // Price shown on the page. Must match your Stripe Price.
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
