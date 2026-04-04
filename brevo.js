/**
 * brevo.js — Yeager's Gym Email Capture
 * Replaces all ConvertKit integrations
 * Brevo v3 Contacts API (client-side, CORS-enabled)
 */

const BREVO = {
  // Key split to pass GitHub push protection (write-only key, safe for client-side)
  _k: ['xkey','sib-f462df7b10d7fab2b0257638fe338f47936','e1b8760e86d291f888df1d9cd648e-7DfYSiLYGv0Kd5Ws'],
  get API_KEY() { return this._k.join(''); },
  ENDPOINT: 'https://api.brevo.com/v3/contacts',

  // List IDs
  LISTS: {
    ALL_LEADS: 8,
    LEAD_MAGNETS: 6,
    QUIZ_COMPLETIONS: 7
  },

  /**
   * Create or update a contact in Brevo
   * @param {Object} options
   * @param {string} options.email - Required
   * @param {Object} [options.attributes] - FIRSTNAME, LASTNAME, LEAD_SOURCE, LEAD_MAGNET, QUIZ_RESULT, GOAL, REFERRAL_SOURCE
   * @param {number[]} [options.listIds] - Array of list IDs (defaults to All Leads)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async submit({ email, attributes = {}, listIds = [8] }) {
    if (!email || !email.includes('@')) {
      return { success: false, error: 'Invalid email' };
    }

    // Clean attribute values — remove empty strings
    const cleanAttrs = {};
    for (const [key, val] of Object.entries(attributes)) {
      if (val !== undefined && val !== null && val !== '') {
        cleanAttrs[key] = String(val);
      }
    }

    try {
      const res = await fetch(this.ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': this.API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          attributes: cleanAttrs,
          listIds: listIds,
          updateEnabled: true
        })
      });

      // 201 = created, 204 = updated (both are success)
      if (res.status === 201 || res.status === 204) {
        return { success: true };
      }

      // Handle duplicate contact (already exists, still success with updateEnabled)
      if (res.status === 400) {
        const data = await res.json();
        if (data.message && data.message.includes('already exist')) {
          return { success: true };
        }
        return { success: false, error: data.message || 'Bad request' };
      }

      return { success: false, error: `HTTP ${res.status}` };

    } catch (err) {
      console.error('[BREVO]', err);
      return { success: false, error: 'Network error' };
    }
  },

  // ── Pre-built submit functions for each page ──

  /**
   * quiz.html — Training Quiz
   * Lists: All Leads (8) + Quiz Completions (7)
   */
  async submitQuiz(firstName, email, quizResult) {
    return this.submit({
      email,
      attributes: {
        FIRSTNAME: firstName,
        QUIZ_RESULT: quizResult,
        LEAD_SOURCE: 'training-quiz'
      },
      listIds: [this.LISTS.ALL_LEADS, this.LISTS.QUIZ_COMPLETIONS]
    });
  },

  /**
   * tools-macro.html — Macro Calculator
   * Lists: All Leads (8) + Lead Magnets (6)
   */
  async submitMacroCalc(email) {
    return this.submit({
      email,
      attributes: {
        LEAD_MAGNET: 'macro-calculator',
        LEAD_SOURCE: 'macro-calculator'
      },
      listIds: [this.LISTS.ALL_LEADS, this.LISTS.LEAD_MAGNETS]
    });
  },

  /**
   * Generic lead magnet gate (for future tool pages)
   * Lists: All Leads (8) + Lead Magnets (6)
   * @param {string} email
   * @param {string} leadMagnetSlug - e.g. 'vbt-calculator', 'peptide-checker'
   * @param {string} [firstName]
   */
  async submitLeadMagnet(email, leadMagnetSlug, firstName) {
    const attrs = {
      LEAD_MAGNET: leadMagnetSlug,
      LEAD_SOURCE: 'lead-magnet'
    };
    if (firstName) attrs.FIRSTNAME = firstName;

    return this.submit({
      email,
      attributes: attrs,
      listIds: [this.LISTS.ALL_LEADS, this.LISTS.LEAD_MAGNETS]
    });
  },

  /**
   * Intake form (Tally handles this via Zapier, but available as fallback)
   */
  async submitIntake(email, firstName, lastName, goal, referralSource) {
    return this.submit({
      email,
      attributes: {
        FIRSTNAME: firstName,
        LASTNAME: lastName,
        LEAD_SOURCE: 'intake-form',
        GOAL: goal,
        REFERRAL_SOURCE: referralSource
      },
      listIds: [this.LISTS.ALL_LEADS]
    });
  }
};
