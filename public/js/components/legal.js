// components/legal.js — Privacy Policy + Account Deletion, shown IN-APP as a modal
// (2026-08-19, Barat: "make it privacy policy as part of web app that's not another
// page"). Previously these only existed as standalone pages (public/privacy.html,
// public/accountdeletion.html) reached via a full navigation/new tab — this component
// renders the SAME wording directly inside the dashboard shell instead.
//
// The standalone pages are NOT removed: Google Play requires a publicly reachable
// privacy-policy URL that works without signing in (see privacy.html's own "Public
// URL for Google Play and users" line), so /privacypolicy and /accountdeletion stay
// as the compliance-facing copies. This component is the everyday in-app path from
// Settings — same wording, kept in sync by hand (legal text changes rarely; when it
// does, update both this file and the two standalone .html files together).
//
// Content is static/trusted (authored by us, never user input), so building it with
// real <a> elements alongside Escape.setText is safe — the SOP's "never trust
// innerHTML" rule is about USER-supplied data, not this hardcoded legal text.
//
// UMD shim: window.Legal in the browser; require()-able in Node for the pure
// content-building helpers (buildSection etc. are unit-tested without a DOM).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../i18n'));
  } else {
    root.Legal = factory(root.Escape, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var CONTACT_EMAIL = 'jeevank1811@gmail.com';

  // ---- content (English — legal text is not translated, matches the standalone
  // pages and the Google Play submission, which must show one authoritative wording) --

  var PRIVACY_UPDATED = 'Last updated: August 13, 2026';
  var PRIVACY_INTRO = 'This Privacy Policy explains how SnapReceipt AI collects, uses, stores, shares, protects, exports, and deletes information when you use our website, dashboard, Telegram bot, Android app, and related receipt automation services.';

  var PRIVACY_SECTIONS = [
    { h2: '1. Who We Are', blocks: [
      { p: ['SnapReceipt AI is operated by Friction SDN BHD in Malaysia. In this policy, "SnapReceipt AI", "we", "us", and "our" refer to the team that provides and operates the SnapReceipt AI service. "You" means the person using the service, including account owners, administrators, branch staff, invited users, and internal testers.'] },
      { p: ['Contact for privacy requests: ', { mailto: CONTACT_EMAIL }, '.'] },
    ] },
    { h2: '2. Scope of This Policy', blocks: [
      { p: ['This policy applies to SnapReceipt AI at snapreceiptai.friction.com.my, the SnapReceipt AI Android app, the SnapReceipt Telegram bot, account onboarding, dashboard use, manual uploads, exports, review tools, support communications, and internal testing releases distributed through Google Play.'] },
      { p: ['If SnapReceipt AI is customised for a business customer, that customer may also have its own internal policies for staff expense submission, reimbursement, accounting, and record retention. Those business policies are separate from this Privacy Policy.'] },
    ] },
    { h2: '3. Information We Collect', blocks: [
      { p: ['We collect information that is needed to provide receipt capture, expense review, and export features.'] },
      { ul: [
        'Account information, such as name, email address, login credentials, role, company, branch, and account settings.',
        'Receipt images, uploaded files, Telegram images, and documents you submit for OCR or expense extraction.',
        'Expense records, such as merchant, amount, currency, tax, date, category, notes, payment status, reviewer status, and export history.',
        'Telegram information, such as Telegram chat identifiers, sender identifiers, message identifiers, file identifiers, and bot binding tokens needed to connect a Telegram chat to an account or branch.',
        'Google sign-in information, if enabled and used, such as your Google account email address, display name, and sign-in token response needed to create or access your SnapReceipt AI account.',
        'Usage and security information, such as device/browser type, IP address, request time, route, authentication failures, rate-limit events, and error diagnostics.',
        'Support and feedback information, such as messages you send to us and related contact details.',
      ] },
    ] },
    { h2: '4. Sensitive Receipt and Financial Data', blocks: [
      { p: ['Receipts can contain personal, financial, tax, location, employee, customer, merchant, and business information. You should only upload receipts and documents that you are authorised to submit. You should avoid uploading documents containing unnecessary sensitive information unless it is required for expense processing.'] },
      { p: ['SnapReceipt AI is designed for receipt and expense workflows. It is not intended for storing passwords, identity documents, medical records, full payment card numbers, or unrelated confidential files.'] },
    ] },
    { h2: '5. How We Use Information', blocks: [
      { ul: [
        'To receive receipt images and files from Telegram, the Android app, and the web dashboard.',
        'To extract receipt details using OCR and AI-assisted parsing.',
        'To create, display, edit, review, categorise, export, and delete expense records.',
        'To provide account login, branch access, administrator access, audit trails, and security controls.',
        'To detect duplicate receipts, suspicious entries, abuse, unauthorised access, and service errors.',
        'To provide customer support, respond to privacy requests, and improve reliability and usability.',
        'To comply with legal, tax, accounting, platform, security, and dispute-resolution obligations.',
      ] },
    ] },
    { h2: '6. Legal Bases and Consent', blocks: [
      { p: ['We process personal data where it is necessary to provide the service, perform an agreement with you or your organisation, comply with legal obligations, protect legitimate business and security interests, or where consent is required by applicable law. Where consent is required, you may withdraw it by contacting us, but this may limit or stop features that depend on the relevant data.'] },
    ] },
    { h2: '7. AI and OCR Processing', blocks: [
      { p: ['SnapReceipt AI may send receipt images, document text, and related context to OCR or AI service providers, including Groq or another provider configured for a specific deployment, so that receipt fields can be extracted and categorised. We use these providers to process your requests and return structured expense data.'] },
      { p: ['We do not sell receipt images or expense data. We do not use receipt images or expense data for advertising. Where provider settings and terms allow, we configure processing to limit retention and prevent training use. Provider terms, security controls, and data-processing arrangements may vary by deployment and customer requirements.'] },
    ] },
    { h2: '8. Storage and Service Providers', blocks: [
      { p: ['We use trusted service providers to operate SnapReceipt AI. These may include hosting providers, Supabase for database and storage services, Telegram for bot messaging and receipt delivery, Google for Google Play distribution and optional Google sign-in, email providers for account and support messages, and OCR or AI providers for document processing.'] },
      { p: ['These providers process data only as needed to provide their services to us, subject to their own security controls, terms, and data-processing commitments.'] },
    ] },
    { h2: '9. Sharing and Disclosure', blocks: [
      { p: ['We may share information only in the following situations:'] },
      { ul: [
        'With service providers that help us operate, secure, host, process, support, or improve SnapReceipt AI.',
        'With the account owner, administrator, or business customer that controls the workspace where a receipt is submitted.',
        'When required by law, regulation, court order, tax authority, law-enforcement request, or platform policy.',
        'To protect rights, safety, security, prevent fraud, enforce terms, or investigate abuse.',
        'In connection with a merger, acquisition, restructuring, sale of assets, financing, or transfer of the service, subject to appropriate safeguards.',
      ] },
      { p: ['We do not sell personal data. We do not share personal data with third parties for cross-context behavioural advertising.'] },
    ] },
    { h2: '10. Data Safety for Google Play', blocks: [
      { p: ['The Android app is a wrapper for SnapReceipt AI and uses internet access to connect to the SnapReceipt AI service. Data handled by the app may include account information, receipt images, uploaded files, expense records, user-generated notes, identifiers, diagnostics, and support communications. The app does not need camera, microphone, contacts, location, SMS, or background tracking permissions for the current release.'] },
      { p: ['Google Play may require us to complete a Data Safety form. The answers in that form should match this policy and the actual features enabled in the live app.'] },
    ] },
    { h2: '11. Cookies, Local Storage, and Session Storage', blocks: [
      { p: ['SnapReceipt AI may use browser storage to keep session tokens, theme preferences, account mode, and user-interface preferences. Session tokens are used to keep you signed in during the current session. We do not use third-party advertising cookies in the current release.'] },
    ] },
    { h2: '12. Retention', blocks: [
      { p: ['We keep personal data, receipt images, expense records, exports, logs, and account records for as long as needed to provide the service, support accounting and audit workflows, comply with legal obligations, resolve disputes, maintain security, and enforce agreements. Retention periods may differ by customer configuration, feature, backup cycle, and legal requirement.'] },
      { p: ['Deleted expense records may be soft-deleted first so that mistakes can be reviewed or restored during a limited period. Backups and logs may retain copies for a further limited period before they expire according to operational schedules.'] },
    ] },
    { h2: '13. Your Choices and Rights', blocks: [
      { p: ['Depending on applicable law and your relationship with SnapReceipt AI or a business customer, you may request access, correction, export, restriction, objection, portability, deletion, or withdrawal of consent for personal data. To make a request, contact us at ', { mailto: CONTACT_EMAIL }, '.'] },
      { p: ['If your account is managed by an employer, branch, or business customer, we may need to direct the request to that organisation or coordinate with them before acting.'] },
    ] },
    { h2: '14. Account Deletion and Data Export', blocks: [
      { p: ['SnapReceipt AI supports data export for expense records and related reports. Account deletion may remove or deactivate access, sessions, account records, Telegram bindings, and associated data, subject to legal, accounting, backup, fraud-prevention, and legitimate business retention needs.'] },
      { p: ['To request account deletion or a data export, use the available in-app controls where provided or contact us by email. We may verify your identity and authority before fulfilling the request.'] },
    ] },
    { h2: '15. Security', blocks: [
      { p: ['We use reasonable technical and organisational measures designed to protect information, including HTTPS in production, authentication controls, server-side database access, restricted secrets, security headers, rate limits, logging that avoids receipt images and unnecessary personal data, and access controls for administrator and branch roles.'] },
      { p: ['No internet service can guarantee perfect security. You are responsible for keeping your account, device, email, Telegram account, and login credentials secure, and for promptly telling us if you believe your account or data has been compromised.'] },
    ] },
    { h2: '16. International Transfers', blocks: [
      { p: ['SnapReceipt AI and its service providers may process and store information in Malaysia or other countries where our providers operate. Where required, we use contractual, technical, and organisational safeguards designed to protect personal data during cross-border processing.'] },
    ] },
    { h2: '17. Children', blocks: [
      { p: ['SnapReceipt AI is not intended for children and is not directed to users under 13 years old. We do not knowingly collect personal data from children. If you believe a child has provided personal data to SnapReceipt AI, contact us so we can review and take appropriate action.'] },
    ] },
    { h2: '18. Changes to This Policy', blocks: [
      { p: ['We may update this Privacy Policy when our service, providers, legal obligations, or data practices change. The updated version will be posted on this page with a new "Last updated" date. Material changes may also be communicated through the app, website, email, or another appropriate channel.'] },
    ] },
    { h2: '19. Contact', blocks: [
      { p: ['For privacy questions, data requests, account deletion, data export, or security concerns, contact: ', { mailto: CONTACT_EMAIL }, '. For account deletion instructions, open the Account Deletion page from Settings.'] },
      { p: ['This policy is intended to be clear and accurate for users and platform review. It is not a substitute for legal advice, and users retain any rights available under applicable law.'] },
    ] },
  ];

  var DELETION_UPDATED = 'Last updated: August 13, 2026';
  var DELETION_INTRO = 'This page explains how SnapReceipt AI users can delete their account or request deletion of specific data without deleting the whole account.';

  var DELETION_SECTIONS = [
    { h2: 'Delete Your Account In The App', blocks: [
      { p: ['If you can sign in to SnapReceipt AI, use the in-app deletion flow:'] },
      { ol: [
        'Open SnapReceipt AI and sign in.',
        'Go to Settings.',
        'Open Privacy & data.',
        'Select Delete account.',
        'Enter your password and type DELETE to confirm.',
      ] },
      { p: ['Account deletion removes or deactivates account access, sessions, account records, Telegram bindings, and related owner data, subject to legal, accounting, security, backup, fraud-prevention, and legitimate business retention requirements.'] },
    ] },
    { h2: 'Request Account Deletion By Email', blocks: [
      { p: ['If you cannot access the app, or if you already uninstalled the Android app, email us at ', { mailto: CONTACT_EMAIL }, ' from the email address used for your SnapReceipt AI account.'] },
      { p: ['Use the subject line "SnapReceipt AI account deletion request" and include the account email you want deleted. We may ask for additional verification before processing the request.'] },
    ] },
    { h2: 'Delete Specific Data Without Deleting Your Account', blocks: [
      { p: ['You can delete specific receipts or expense records from inside the app where deletion controls are available. You can also request that we delete specific receipts, uploaded files, support messages, or other account data without deleting your whole account by emailing ', { mailto: CONTACT_EMAIL }, '.'] },
      { p: ['Tell us what data you want deleted, such as receipt records from a date range, a particular upload, or support messages. We may need to verify your identity and account ownership before acting.'] },
    ] },
    { h2: 'What May Be Retained', blocks: [
      { p: ['Some information may be retained where required or permitted for legal, tax, accounting, audit, security, fraud-prevention, dispute-resolution, backup, or compliance reasons. Backup copies and operational logs may take additional time to expire from all systems.'] },
    ] },
  ];

  // ---- pure content-building helpers (unit-testable without a DOM) --------

  // Splits a paragraph-parts array into { text, mailtos } — mailtos records where
  // an email placeholder sits so the DOM renderer knows to insert a real <a>.
  // Not itself rendering anything; kept pure so tests can assert on structure
  // without needing document/createElement.
  function paragraphPlainText(parts) {
    if (typeof parts === 'string') return parts;
    return (parts || []).map(function (part) {
      if (typeof part === 'string') return part;
      if (part && part.mailto) return part.mailto;
      if (part && part.href) return part.text || part.href;
      return '';
    }).join('');
  }

  // ---- DOM rendering (browser only) ----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }

  // Builds a <p> from a plain string or an array of [string | {mailto} | {href,text}]
  // parts — real anchor elements for the mailto/https pieces, textContent for
  // everything else. Content is static/trusted (see file header), so this is safe.
  function buildParagraph(parts) {
    var p = el('p');
    var list = typeof parts === 'string' ? [parts] : (parts || []);
    list.forEach(function (part) {
      if (typeof part === 'string') {
        p.appendChild(document.createTextNode(part));
      } else if (part && part.mailto) {
        var a = el('a');
        a.href = 'mailto:' + part.mailto;
        Escape.setText(a, part.mailto);
        p.appendChild(a);
      } else if (part && part.href) {
        var link = el('a');
        link.href = part.href;
        Escape.setText(link, part.text || part.href);
        p.appendChild(link);
      }
    });
    return p;
  }

  function buildList(tag, items) {
    var listEl = el(tag);
    (items || []).forEach(function (item) {
      var li = el('li');
      Escape.setText(li, item);
      listEl.appendChild(li);
    });
    return listEl;
  }

  function buildSection(section) {
    var wrap = el('section');
    var h2 = el('h2');
    Escape.setText(h2, section.h2);
    wrap.appendChild(h2);
    (section.blocks || []).forEach(function (block) {
      if (block.p) wrap.appendChild(buildParagraph(block.p));
      else if (block.ul) wrap.appendChild(buildList('ul', block.ul));
      else if (block.ol) wrap.appendChild(buildList('ol', block.ol));
    });
    return wrap;
  }

  // Builds the full document body (hero + numbered sections) — reuses the same
  // .privacy-* classes/CSS as the standalone pages (public/privacy.html,
  // accountdeletion.html) so the two stay visually identical. The outer
  // .legal-modal-body wrapper strips .privacy-doc's own card chrome (see app.css
  // ".legal-modal-body .privacy-doc" rule) since the modal shell already
  // provides the card/scroll/padding.
  function buildDoc(updated, intro, sections) {
    var doc = el('article', 'privacy-doc');
    var hero = el('header', 'privacy-hero');
    var kicker = el('p', 'privacy-kicker');
    Escape.setText(kicker, 'SnapReceipt AI');
    hero.appendChild(kicker);
    var updatedEl = el('p', 'privacy-updated');
    Escape.setText(updatedEl, updated);
    hero.appendChild(updatedEl);
    hero.appendChild(buildParagraph(intro));
    doc.appendChild(hero);
    sections.forEach(function (s) { doc.appendChild(buildSection(s)); });
    return doc;
  }

  // openModal(title, docBuilder, opts) -> the shared modal shell (overlay + card +
  // header with close button + scrollable body). `opts.onLinkClick` lets the
  // Account Deletion modal's "Privacy Policy" cross-reference switch straight to
  // the Privacy modal instead of navigating away (2026-08-19 — the whole point of
  // this component is staying inside the app).
  function openModal(title, docBuilder) {
    if (!hasDom()) return null;
    var overlay = el('div', 'legal-modal-overlay');
    var modal = el('div', 'legal-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', title);

    var head = el('div', 'legal-modal-head');
    var titleEl = el('div', 'legal-modal-title');
    Escape.setText(titleEl, title);
    var closeBtn = el('button', 'legal-modal-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('legal.close'));
    Escape.setText(closeBtn, '×');
    head.appendChild(titleEl);
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = el('div', 'legal-modal-body');
    body.appendChild(docBuilder());
    modal.appendChild(body);

    overlay.appendChild(modal);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    closeBtn.addEventListener('click', close);
    document.body.appendChild(overlay);
    closeBtn.focus();
    return { overlay: overlay, close: close };
  }

  function openPrivacyModal() {
    return openModal(t('legal.privacy_policy'), function () {
      return buildDoc(PRIVACY_UPDATED, PRIVACY_INTRO, PRIVACY_SECTIONS);
    });
  }

  function openAccountDeletionModal() {
    return openModal(t('legal.account_deletion'), function () {
      return buildDoc(DELETION_UPDATED, DELETION_INTRO, DELETION_SECTIONS);
    });
  }

  return {
    // pure
    paragraphPlainText: paragraphPlainText,
    PRIVACY_SECTIONS: PRIVACY_SECTIONS,
    DELETION_SECTIONS: DELETION_SECTIONS,
    // DOM
    openPrivacyModal: openPrivacyModal,
    openAccountDeletionModal: openAccountDeletionModal,
  };
});
