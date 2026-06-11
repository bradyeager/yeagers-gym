/**
 * brevo.js — Yeager's Gym Email Capture Utility
 * Shared across all pages with email capture forms.
 *
 * SECURITY: This file contains NO API key. It posts to a server-side middleman
 * (Supabase Edge Function "brevo-proxy") which holds the Brevo key in a private
 * env var and forwards to the Brevo Contacts API. The key never reaches the browser.
 *
 * Public interface is unchanged — pages keep calling brevoSubmit({...}) exactly as before:
 *   brevoSubmit({
 *     email: 'user@example.com',
 *     firstName: 'John',          // optional
 *     listIds: [8, 6],
 *     attributes: { LEAD_SOURCE: 'macro-calculator', LEAD_MAGNET: 'macro-calculator' }
 *   }).then(ok => { ... });
 */

(function () {
  'use strict';

  // Server-side middleman endpoint (no secret here — safe for client-side).
  var PROXY_URL = 'https://qfprpepqzckymbijeexw.supabase.co/functions/v1/brevo-proxy';

  // List IDs (unchanged — pages reference these).
  window.BREVO_LISTS = {
    ALL_LEADS: 8,
    LEAD_MAGNETS: 6,
    QUIZ_COMPLETIONS: 7
  };

  /**
   * Submit a contact via the middleman.
   * @param {Object} opts
   * @param {string} opts.email - Required.
   * @param {string} [opts.firstName] - Optional first name.
   * @param {number[]} [opts.listIds] - Array of Brevo list IDs (server enforces allowed set).
   * @param {Object} [opts.attributes] - Key/value contact attributes.
   * @returns {Promise<boolean>} - Resolves true on success, false on error.
   */
  window.brevoSubmit = function (opts) {
    if (!opts || !opts.email) {
      console.error('[Brevo] Email is required.');
      return Promise.resolve(false);
    }

    var body = {
      email: opts.email.trim().toLowerCase(),
      firstName: opts.firstName || undefined,
      listIds: opts.listIds || [window.BREVO_LISTS.ALL_LEADS],
      attributes: opts.attributes || {}
    };

    return fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json()
          .then(function (data) { return !!(data && data.ok); })
          .catch(function () { return res.ok; });
      })
      .catch(function (err) {
        console.error('[Brevo] Network error:', err);
        return false;
      });
  };

  /**
   * Simple email validation.
   */
  window.brevoValidateEmail = function (email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  // ── Toast notification on successful signup ──
  var toastLines = [
    'Thank you! Your m/s just went up.',
    'Thank you! That signup had elite bar speed.',
    'Thank you! Faster than a competition deadlift.',
    'Thank you! 0.2 seconds — PR signup velocity.',
    'Thank you! You just auto-regulated your inbox.'
  ];

  window.brevoToast = function () {
    var msg = toastLines[Math.floor(Math.random() * toastLines.length)];
    var el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);' +
      'background:rgba(10,14,23,0.92);border:1px solid rgba(30,200,176,0.35);' +
      'border-radius:10px;padding:14px 24px;z-index:9999;' +
      'font-family:inherit;font-size:0.85rem;color:#e8eaed;text-align:center;' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.4);' +
      'opacity:0;transition:opacity 0.4s ease,transform 0.4s ease;max-width:90vw;';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.style.opacity = '1';
      el.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(function () { el.remove(); }, 400);
    }, 3500);
  };

})();
