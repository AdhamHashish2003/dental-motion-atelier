const { createReadStream, existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { basename, extname, join, normalize, relative, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const root = resolve(__dirname);
const port = Number(process.env.PORT || 4173);
const contactRecipient = process.env.CONTACT_TO_EMAIL || "team@dentalmotiongraphic.com";
const maxBodyBytes = 1024 * 1024;
let databasePool;
let contactTableReady = false;
let marketingTablesReady = false;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function resolveRequestPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath.split("?")[0] || "/");
  } catch {
    return null;
  }

  const requested = decodedPath === "/" ? "/index.html" : decodedPath === "/admin" ? "/admin.html" : decodedPath;
  const filePath = normalize(join(root, requested));
  const relativePath = relative(root, filePath);

  if (relativePath.startsWith("..") || relativePath.includes(":")) {
    return null;
  }

  return filePath;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodyBytes) {
        request.destroy();
        rejectBody(new Error("Request body is too large."));
      }
    });

    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}"));
      } catch {
        rejectBody(new Error("Please send valid JSON."));
      }
    });

    request.on("error", rejectBody);
  });
}

function clean(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function validateContact(payload) {
  const name = clean(payload.name);
  const email = clean(payload.email).toLowerCase();
  const offer = String(payload.offer || "").trim();

  if (name.length < 2 || name.length > 120) {
    return { error: "Please enter a valid clinic or brand name." };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return { error: "Please enter a valid email address." };
  }

  if (offer.length < 8 || offer.length > 2000) {
    return { error: "Please describe the treatment offer in a little more detail." };
  }

  return { data: { name, email, offer } };
}

function smtpConfig() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  const portValue = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true") !== "false";

  return {
    host,
    port: portValue,
    secure,
    auth: { user, pass },
  };
}

function resendConfig() {
  const apiKey = process.env.RESEND_API_KEY || process.env.RESEND_KEY;

  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    fromEmail:
      process.env.RESEND_FROM_EMAIL ||
      process.env.SMTP_FROM_EMAIL ||
      "Dental Motion Website <onboarding@resend.dev>",
  };
}

function contactEmailContent(contact) {
  const lines = [
    "New lead from dentalmotiongraphic.com",
    "",
    `Clinic or brand: ${contact.name}`,
    `Email: ${contact.email}`,
    "",
    "Offer:",
    contact.offer,
  ];

  return {
    subject: `New dental motion video lead from ${contact.name}`,
    text: lines.join("\n"),
    html: `
      <h2>New dental motion video lead</h2>
      <p><strong>Clinic or brand:</strong> ${escapeHtml(contact.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(contact.email)}</p>
      <p><strong>Offer:</strong></p>
      <p>${escapeHtml(contact.offer).replaceAll("\n", "<br>")}</p>
    `,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function databaseConfig() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const config = {
    connectionString: process.env.DATABASE_URL,
  };

  if (process.env.DATABASE_SSL === "true") {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function getDatabasePool() {
  const config = databaseConfig();

  if (!config) {
    return null;
  }

  if (!databasePool) {
    databasePool = new Pool(config);
  }

  return databasePool;
}

async function ensureContactTable(queryable) {
  if (contactTableReady) {
    return;
  }

  await queryable.query(`
    CREATE TABLE IF NOT EXISTS contact_submissions (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      offer TEXT NOT NULL,
      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
      email_sent_at TIMESTAMPTZ,
      email_error TEXT
    )
  `);

  contactTableReady = true;
}

async function saveContactSubmission(contact, queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureContactTable(queryable);

  const result = await queryable.query(
    `
      INSERT INTO contact_submissions (name, email, offer)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [contact.name, contact.email, contact.offer]
  );

  return { id: result.rows[0].id, saved: true };
}

async function updateContactEmailStatus(id, emailSent, emailError, queryable = getDatabasePool()) {
  if (!id || !queryable) {
    return;
  }

  await queryable.query(
    `
      UPDATE contact_submissions
      SET email_sent = $1,
          email_sent_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
          email_error = $2
      WHERE id = $3
    `,
    [emailSent, emailError ? String(emailError).slice(0, 1000) : null, id]
  );
}

function isDatabaseRequired() {
  return process.env.CONTACT_DRY_RUN !== "true" && process.env.CONTACT_DATABASE_REQUIRED !== "false";
}

function publicSiteUrl() {
  return (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || "https://dentalmotiongraphic.com").replace(/\/+$/, "");
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function publicVideoFiles() {
  const videoDir = join(root, "videos");
  const allowedExtensions = new Set([".mov", ".mp4", ".webm"]);

  if (!existsSync(videoDir)) {
    return [];
  }

  return readdirSync(videoDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && allowedExtensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function defaultPublicVideoUrls() {
  return publicVideoFiles()
    .slice(0, 6)
    .map((filename) => `${publicSiteUrl()}/videos/${encodeURIComponent(filename)}`);
}

function campaignVideoAttachments(options = {}) {
  const shouldAttach = booleanOption(
    options.attach_video ?? options.attachVideo ?? process.env.EMAIL_ATTACH_VIDEO,
    false
  );

  if (!shouldAttach) {
    return [];
  }

  return publicVideoFiles()
    .slice(0, 1)
    .map((filename) => ({
      contentType: types[extname(filename).toLowerCase()] || "application/octet-stream",
      filename,
      path: join(root, "videos", filename),
    }));
}

function resendAttachmentPayload(attachments = []) {
  const videoDir = join(root, "videos");

  return attachments
    .map((attachment) => {
      const filePath = resolve(String(attachment.path || ""));
      const relativePath = relative(videoDir, filePath);

      if (relativePath.startsWith("..") || relativePath.includes(":")) {
        return null;
      }

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        return null;
      }

      return {
        content: readFileSync(filePath).toString("base64"),
        content_type: attachment.contentType || types[extname(filePath).toLowerCase()] || "application/octet-stream",
        filename: attachment.filename || basename(filePath),
      };
    })
    .filter(Boolean);
}

function marketingAdminToken() {
  return process.env.EMAIL_ADMIN_TOKEN || "";
}

function bearerToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeEqualString(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireMarketingAdmin(request, response) {
  const expected = marketingAdminToken();

  if (!expected) {
    sendJson(response, 503, {
      ok: false,
      message: "Email admin is not configured yet. Set EMAIL_ADMIN_TOKEN in Railway first.",
    });
    return false;
  }

  if (!bearerToken(request)) {
    sendJson(response, 401, {
      ok: false,
      message: "Missing admin token.",
    });
    return false;
  }

  if (!safeEqualString(bearerToken(request), expected)) {
    sendJson(response, 403, {
      ok: false,
      message: "Invalid admin token.",
    });
    return false;
  }

  return true;
}

function campaignFromEmail() {
  const configured =
    process.env.EMAIL_CAMPAIGN_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.SMTP_FROM_EMAIL ||
    "team@dentalmotiongraphic.com";

  return configured.includes("<") ? configured : `Dental Motion <${configured}>`;
}

function campaignConfig() {
  const resend = resendConfig();

  if (!resend) {
    return null;
  }

  return {
    apiKey: resend.apiKey,
    fromEmail: campaignFromEmail(),
  };
}

function campaignFooterAddress() {
  return process.env.EMAIL_FOOTER_ADDRESS || "Dental Motion, dentalmotiongraphic.com";
}

function parseEmailList(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    .slice(0, 10);
}

function campaignBccEmails(subscriberEmail = "") {
  const configured = process.env.EMAIL_CAMPAIGN_BCC_EMAIL || contactRecipient;
  const subscriber = String(subscriberEmail || "").trim().toLowerCase();

  return parseEmailList(configured).filter((email) => email !== subscriber);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function boundedPositiveInteger(value, fallback, max) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), max);
}

function validateMarketingSubscriber(raw, fallbackConsentNote = "") {
  const email = clean(raw.email).toLowerCase();
  const name = clean(raw.name);
  const clinic = clean(raw.clinic);
  const source = clean(raw.source || "manual import");
  const website = clean(raw.website);
  const phone = clean(raw.phone);
  const address = clean(raw.address);
  const consentNote = String(raw.consent_note || fallbackConsentNote || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return { error: "Each subscriber needs a valid email address." };
  }

  if (
    name.length > 120 ||
    clinic.length > 160 ||
    source.length > 160 ||
    website.length > 300 ||
    phone.length > 80 ||
    address.length > 300
  ) {
    return { error: `Subscriber metadata is too long for ${email}.` };
  }

  if (consentNote.length < 8 || consentNote.length > 500) {
    return {
      error:
        "Each subscriber import needs a consent_note explaining why these people agreed to receive email.",
    };
  }

  return {
    data: {
      email,
      name: name || null,
      clinic: clinic || null,
      source: source || "manual import",
      website: website || null,
      phone: phone || null,
      address: address || null,
      consentNote,
    },
  };
}

function validateCampaignPayload(payload) {
  const subject = clean(payload.subject);
  const previewText = clean(payload.preview_text || payload.previewText || "");
  const html = String(payload.html || "").trim();
  const text = String(payload.text || stripHtml(html)).trim();
  const maxRecipients = Math.max(1, Number(process.env.EMAIL_CAMPAIGN_MAX_RECIPIENTS || 500));
  const limit = boundedPositiveInteger(payload.limit, maxRecipients, maxRecipients);
  const onlyUnsent = payload.only_unsent === true || payload.onlyUnsent === true;

  if (subject.length < 4 || subject.length > 180) {
    return { error: "Campaign subject must be between 4 and 180 characters." };
  }

  if (previewText.length > 180) {
    return { error: "Preview text must be 180 characters or less." };
  }

  if (html.length < 20 || html.length > 60000) {
    return { error: "Campaign html must be between 20 and 60,000 characters." };
  }

  if (text.length < 10 || text.length > 60000) {
    return { error: "Campaign text must be between 10 and 60,000 characters." };
  }

  return { data: { subject, previewText, html, text, limit, onlyUnsent } };
}

async function ensureMarketingTables(queryable) {
  if (marketingTablesReady) {
    return;
  }

  await queryable.query(`
    CREATE TABLE IF NOT EXISTS email_subscribers (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      clinic TEXT,
      website TEXT,
      phone TEXT,
      address TEXT,
      source TEXT NOT NULL DEFAULT 'manual import',
      consent_note TEXT NOT NULL,
      unsubscribe_token TEXT NOT NULL UNIQUE,
      unsubscribed_at TIMESTAMPTZ,
      last_sent_at TIMESTAMPTZ
    )
  `);

  await queryable.query("ALTER TABLE email_subscribers ADD COLUMN IF NOT EXISTS website TEXT");
  await queryable.query("ALTER TABLE email_subscribers ADD COLUMN IF NOT EXISTS phone TEXT");
  await queryable.query("ALTER TABLE email_subscribers ADD COLUMN IF NOT EXISTS address TEXT");

  await queryable.query(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      subject TEXT NOT NULL,
      preview_text TEXT,
      html TEXT NOT NULL,
      text TEXT NOT NULL,
      from_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      total_recipients INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  await queryable.query(`
    CREATE TABLE IF NOT EXISTS email_campaign_recipients (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
      subscriber_id BIGINT NOT NULL REFERENCES email_subscribers(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resend_id TEXT,
      error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (campaign_id, subscriber_id)
    )
  `);

  await queryable.query(`
    CREATE TABLE IF NOT EXISTS email_daily_runs (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
      run_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      attempted INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      remaining INTEGER,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      UNIQUE (campaign_id, run_date)
    )
  `);

  await queryable.query(`
    CREATE TABLE IF NOT EXISTS clinic_research_leads (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_key TEXT NOT NULL UNIQUE,
      location TEXT NOT NULL,
      clinic TEXT NOT NULL,
      email TEXT,
      website TEXT,
      phone TEXT,
      address TEXT,
      source_url TEXT,
      has_email BOOLEAN NOT NULL DEFAULT FALSE,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  marketingTablesReady = true;
}

async function upsertMarketingSubscribers(payload, queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  const subscribers = Array.isArray(payload.subscribers) ? payload.subscribers : [];
  const maxImport = Math.max(1, Number(process.env.EMAIL_IMPORT_MAX_SUBSCRIBERS || 1000));

  if (subscribers.length < 1) {
    throw new Error("Add at least one subscriber.");
  }

  if (subscribers.length > maxImport) {
    throw new Error(`Import is too large. Send ${maxImport} subscribers or fewer at a time.`);
  }

  await ensureMarketingTables(queryable);

  const results = [];
  const resubscribe = payload.resubscribe === true;

  for (const rawSubscriber of subscribers) {
    const validation = validateMarketingSubscriber(rawSubscriber, payload.consent_note);

    if (validation.error) {
      throw new Error(validation.error);
    }

    const subscriber = validation.data;
    const token = randomBytes(24).toString("hex");
    const result = await queryable.query(
      `
        INSERT INTO email_subscribers (
          email,
          name,
          clinic,
          website,
          phone,
          address,
          source,
          consent_note,
          unsubscribe_token,
          unsubscribed_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NOW())
        ON CONFLICT (email) DO UPDATE
        SET name = COALESCE(EXCLUDED.name, email_subscribers.name),
            clinic = COALESCE(EXCLUDED.clinic, email_subscribers.clinic),
            website = COALESCE(EXCLUDED.website, email_subscribers.website),
            phone = COALESCE(EXCLUDED.phone, email_subscribers.phone),
            address = COALESCE(EXCLUDED.address, email_subscribers.address),
            source = EXCLUDED.source,
            consent_note = EXCLUDED.consent_note,
            updated_at = NOW(),
            unsubscribed_at = CASE WHEN $10::boolean THEN NULL ELSE email_subscribers.unsubscribed_at END
        RETURNING id, email, unsubscribed_at
      `,
      [
        subscriber.email,
        subscriber.name,
        subscriber.clinic,
        subscriber.website,
        subscriber.phone,
        subscriber.address,
        subscriber.source,
        subscriber.consentNote,
        token,
        resubscribe,
      ]
    );

    results.push(result.rows[0]);
  }

  return {
    saved: true,
    imported: results.length,
    active: results.filter((subscriber) => !subscriber.unsubscribed_at).length,
    unsubscribed: results.filter((subscriber) => subscriber.unsubscribed_at).length,
  };
}

async function marketingSubscriberStats(queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const result = await queryable.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE unsubscribed_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
      COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND last_sent_at IS NULL)::int AS pending_unsent,
      COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND last_sent_at IS NOT NULL)::int AS already_sent
    FROM email_subscribers
  `);

  return { saved: true, ...result.rows[0] };
}

async function clinicResearchStats(queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const result = await queryable.query(`
    SELECT
      COUNT(*)::int AS researched_total,
      COUNT(*) FILTER (WHERE has_email)::int AS researched_with_email,
      COUNT(*) FILTER (WHERE NOT has_email)::int AS researched_without_email
    FROM clinic_research_leads
  `);

  return { saved: true, ...result.rows[0] };
}

async function marketingSubscribersOverview(queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const stats = await marketingSubscriberStats(queryable);
  const recent = await queryable.query(`
    SELECT email, name, clinic, website, phone, address, source, last_sent_at, created_at
    FROM email_subscribers
    WHERE unsubscribed_at IS NULL
    ORDER BY COALESCE(last_sent_at, '1970-01-01'::timestamptz) ASC, created_at DESC
    LIMIT 50
  `);

  const research = await clinicResearchStats(queryable);

  return {
    saved: true,
    stats: {
      ...stats,
      researched_total: research.researched_total || 0,
      researched_with_email: research.researched_with_email || 0,
      researched_without_email: research.researched_without_email || 0,
    },
    recent: recent.rows,
  };
}

async function createMarketingCampaign(payload, queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  const validation = validateCampaignPayload(payload);

  if (validation.error) {
    throw new Error(validation.error);
  }

  await ensureMarketingTables(queryable);

  const campaign = validation.data;
  const created = await queryable.query(
    `
      INSERT INTO email_campaigns (subject, preview_text, html, text, from_email, status)
      VALUES ($1, $2, $3, $4, $5, 'queued')
      RETURNING id, subject
    `,
    [campaign.subject, campaign.previewText || null, campaign.html, campaign.text, campaignFromEmail()]
  );
  const campaignId = created.rows[0].id;

  const recipients = await queryable.query(
    `
      WITH selected AS (
        SELECT id, email
        FROM email_subscribers
        WHERE unsubscribed_at IS NULL
          AND ($3::boolean = false OR last_sent_at IS NULL)
        ORDER BY created_at ASC
        LIMIT $2
      )
      INSERT INTO email_campaign_recipients (campaign_id, subscriber_id, email)
      SELECT $1, selected.id, selected.email
      FROM selected
      ON CONFLICT (campaign_id, subscriber_id) DO NOTHING
      RETURNING id
    `,
    [campaignId, campaign.limit, campaign.onlyUnsent]
  );

  const status = recipients.rowCount > 0 ? "queued" : "empty";
  await queryable.query(
    `
      UPDATE email_campaigns
      SET total_recipients = $1,
          status = $2
      WHERE id = $3
    `,
    [recipients.rowCount, status, campaignId]
  );

  return {
    saved: true,
    campaignId,
    subject: created.rows[0].subject,
    queued: recipients.rowCount,
  };
}

function campaignEmailContent(campaign, subscriber) {
  const unsubscribeUrl = `${publicSiteUrl()}/unsubscribe?token=${encodeURIComponent(
    subscriber.unsubscribe_token
  )}`;
  const address = campaignFooterAddress();
  const safeUnsubscribeUrl = escapeHtml(unsubscribeUrl);
  const safeAddress = escapeHtml(address);
  const htmlBody = personalizeTemplate(campaign.html, subscriber);
  const textBody = personalizeTemplate(campaign.text, subscriber);
  const html = `
    ${htmlBody}
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0 18px;">
    <p style="color:#667085;font-size:13px;line-height:1.5;">
      You are receiving this as a Dental Motion business outreach email about dental motion graphic videos.
      <br>
      ${safeAddress}
      <br>
      <a href="${safeUnsubscribeUrl}">Unsubscribe</a>
    </p>
  `;
  const text = `${textBody}\n\n---\nYou are receiving this as a Dental Motion business outreach email about dental motion graphic videos.\n${address}\nUnsubscribe: ${unsubscribeUrl}`;

  return { html, text, unsubscribeUrl };
}

function personalizeTemplate(value, subscriber) {
  const clinic = subscriber.clinic || subscriber.name || "your clinic";
  const name = subscriber.name || clinic;

  return String(value || "")
    .replaceAll("{{clinic}}", clinic)
    .replaceAll("{{name}}", name)
    .replaceAll("{{email}}", subscriber.email || "");
}

function parseUrlList(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => /^https?:\/\//i.test(item))
    .slice(0, 6);
}

function outreachShowcaseConfig(options = {}) {
  const websiteUrl = normalizeWebsite(
    options.website_url ||
      options.websiteUrl ||
      process.env.EMAIL_SHOWCASE_URL ||
      publicSiteUrl()
  );
  const configuredVideoUrls = parseUrlList(
    options.video_urls ||
      options.videoUrls ||
      process.env.EMAIL_VIDEO_URLS ||
      ""
  );
  const videoUrls = configuredVideoUrls.length ? configuredVideoUrls : defaultPublicVideoUrls();

  return { websiteUrl, videoUrls };
}

function videoLinksHtml(videoUrls) {
  if (!videoUrls.length) {
    return "";
  }

  const links = videoUrls
    .map(
      (url, index) =>
        `<li style="margin:8px 0;"><a href="${escapeHtml(url)}" style="color:#0f766e;font-weight:700;">Dental motion video example ${index + 1}</a></li>`
    )
    .join("");

  return `<p style="margin:0 0 8px;">A short example is also attached, and you can watch it here:</p><ul style="margin:0 0 22px 20px;padding:0;">${links}</ul>`;
}

function videoLinksText(videoUrls) {
  if (!videoUrls.length) {
    return "";
  }

  return `\n\nVideo examples:\n${videoUrls
    .map((url, index) => `${index + 1}. ${url}`)
    .join("\n")}`;
}

async function sendMarketingEmail(campaign, subscriber, fetchImpl = fetch) {
  const config = campaignConfig();

  if (!config) {
    const error = new Error("Resend is not configured yet.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  if (process.env.EMAIL_CAMPAIGN_DRY_RUN === "true") {
    return { id: "dry-run", provider: "resend", dryRun: true };
  }

  const content = campaignEmailContent(campaign, subscriber);
  const attachments = resendAttachmentPayload(campaign.attachments);
  const emailPayload = {
    bcc: campaignBccEmails(subscriber.email),
    from: config.fromEmail,
    to: [subscriber.email],
    reply_to: contactRecipient,
    subject: personalizeTemplate(campaign.subject, subscriber),
    html: content.html,
    text: content.text,
    headers: {
      "List-Unsubscribe": `<${content.unsubscribeUrl}>`,
    },
  };

  if (attachments.length) {
    emailPayload.attachments = attachments;
  }

  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(emailPayload),
  });

  const detail = await response.text();

  if (!response.ok) {
    const error = new Error(`Resend campaign email failed with ${response.status}: ${detail}`);
    error.code = "EMAIL_SEND_FAILED";
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(detail);
  } catch {
    parsed = {};
  }

  return { id: parsed.id || null, provider: "resend", dryRun: false };
}

async function sendMarketingCampaign(campaignId, options = {}, queryable = getDatabasePool()) {
  if (!queryable) {
    return { sent: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const campaignResult = await queryable.query(
    `
      SELECT id, subject, html, text, status
      FROM email_campaigns
      WHERE id = $1
    `,
    [campaignId]
  );

  if (campaignResult.rowCount === 0) {
    throw new Error("Campaign not found.");
  }

  const maxBatch = Math.max(1, Number(process.env.EMAIL_CAMPAIGN_BATCH_SIZE || 100));
  const limit = boundedPositiveInteger(options.limit, maxBatch, maxBatch);
  const pending = await queryable.query(
    `
      SELECT
        recipients.id AS recipient_id,
        recipients.email,
        subscribers.name,
        subscribers.clinic,
        subscribers.unsubscribe_token
      FROM email_campaign_recipients recipients
      JOIN email_subscribers subscribers ON subscribers.id = recipients.subscriber_id
      WHERE recipients.campaign_id = $1
        AND recipients.status = 'pending'
        AND subscribers.unsubscribed_at IS NULL
      ORDER BY recipients.id ASC
      LIMIT $2
    `,
    [campaignId, limit]
  );

  if (pending.rowCount === 0) {
    await queryable.query("UPDATE email_campaigns SET status = 'sent' WHERE id = $1", [campaignId]);
    return { sent: true, campaignId, attempted: 0, sentCount: 0, failedCount: 0 };
  }

  await queryable.query("UPDATE email_campaigns SET status = 'sending' WHERE id = $1", [campaignId]);

  let sentCount = 0;
  let failedCount = 0;
  const campaign = {
    ...campaignResult.rows[0],
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
  };
  const waitMs = Math.min(Math.max(0, Number(process.env.EMAIL_CAMPAIGN_DELAY_MS || 250)), 5000);

  for (const recipient of pending.rows) {
    try {
      const delivery = await sendMarketingEmail(campaign, recipient, options.fetchImpl || fetch);
      await queryable.query(
        `
          UPDATE email_campaign_recipients
          SET status = 'sent',
              resend_id = $1,
              error = NULL,
              sent_at = NOW()
          WHERE id = $2
        `,
        [delivery.id, recipient.recipient_id]
      );
      await queryable.query(
        `
          UPDATE email_subscribers
          SET last_sent_at = NOW(),
              updated_at = NOW()
          WHERE email = $1
        `,
        [recipient.email]
      );
      sentCount += 1;
    } catch (error) {
      await queryable.query(
        `
          UPDATE email_campaign_recipients
          SET status = 'failed',
              error = $1
          WHERE id = $2
        `,
        [String(error.message || error).slice(0, 1000), recipient.recipient_id]
      );
      failedCount += 1;
    }

    if (waitMs > 0) {
      await delay(waitMs);
    }
  }

  const remaining = await queryable.query(
    `
      SELECT COUNT(*)::int AS count
      FROM email_campaign_recipients
      WHERE campaign_id = $1
        AND status = 'pending'
    `,
    [campaignId]
  );
  const finalStatus = remaining.rows[0].count === 0 ? "sent" : "queued";

  await queryable.query(
    `
      UPDATE email_campaigns
      SET sent_count = (
            SELECT COUNT(*)::int
            FROM email_campaign_recipients
            WHERE campaign_id = $1 AND status = 'sent'
          ),
          failed_count = (
            SELECT COUNT(*)::int
            FROM email_campaign_recipients
            WHERE campaign_id = $1 AND status = 'failed'
          ),
          status = $2
      WHERE id = $1
    `,
    [campaignId, finalStatus]
  );

  return {
    sent: true,
    campaignId,
    attempted: pending.rowCount,
    sentCount,
    failedCount,
    remaining: remaining.rows[0].count,
    status: finalStatus,
  };
}

function parseDailyTime(value = "09:00") {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute, minutes: hour * 60 + minute };
}

function localDateTimeParts(date = new Date(), timeZone = "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: hour * 60 + minute,
  };
}

function dailyCampaignConfig() {
  if (process.env.EMAIL_DAILY_ENABLED !== "true") {
    return { enabled: false, reason: "EMAIL_DAILY_ENABLED is not true." };
  }

  const campaignId = clean(process.env.EMAIL_DAILY_CAMPAIGN_ID);

  if (!/^\d+$/.test(campaignId)) {
    return { enabled: false, reason: "EMAIL_DAILY_CAMPAIGN_ID is missing or invalid." };
  }

  const sendTime = parseDailyTime(process.env.EMAIL_DAILY_TIME || "09:00");

  if (!sendTime) {
    return { enabled: false, reason: "EMAIL_DAILY_TIME must be HH:MM in 24-hour format." };
  }

  return {
    campaignId,
    enabled: true,
    limit: boundedPositiveInteger(process.env.EMAIL_DAILY_LIMIT, 15, 500),
    sendTime,
    timeZone: process.env.EMAIL_DAILY_TIME_ZONE || "America/Los_Angeles",
  };
}

async function runDailyMarketingCampaign(now = new Date(), queryable = getDatabasePool()) {
  const config = dailyCampaignConfig();

  if (!config.enabled) {
    return { ran: false, reason: config.reason };
  }

  if (!queryable) {
    return { ran: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const local = localDateTimeParts(now, config.timeZone);

  if (local.minutes < config.sendTime.minutes) {
    return {
      ran: false,
      reason: "TOO_EARLY",
      date: local.date,
      timeZone: config.timeZone,
    };
  }

  const run = await queryable.query(
    `
      INSERT INTO email_daily_runs (campaign_id, run_date, status)
      VALUES ($1, $2, 'running')
      ON CONFLICT (campaign_id, run_date) DO NOTHING
      RETURNING id
    `,
    [config.campaignId, local.date]
  );

  if (run.rowCount === 0) {
    return {
      ran: false,
      reason: "ALREADY_RAN",
      campaignId: config.campaignId,
      date: local.date,
    };
  }

  const runId = run.rows[0].id;

  try {
    const delivery = await sendMarketingCampaign(
      config.campaignId,
      { limit: config.limit },
      queryable
    );
    await queryable.query(
      `
        UPDATE email_daily_runs
        SET status = $1,
            attempted = $2,
            sent_count = $3,
            failed_count = $4,
            remaining = $5,
            error = NULL,
            finished_at = NOW()
        WHERE id = $6
      `,
      [
        delivery.failedCount > 0 ? "completed_with_errors" : "completed",
        delivery.attempted || 0,
        delivery.sentCount || 0,
        delivery.failedCount || 0,
        delivery.remaining || 0,
        runId,
      ]
    );

    return {
      ran: true,
      campaignId: config.campaignId,
      date: local.date,
      delivery,
    };
  } catch (error) {
    await queryable.query(
      `
        UPDATE email_daily_runs
        SET status = 'failed',
            error = $1,
            finished_at = NOW()
        WHERE id = $2
      `,
      [String(error.message || error).slice(0, 1000), runId]
    );

    throw error;
  }
}

function startDailyCampaignScheduler() {
  const config = dailyCampaignConfig();

  if (!config.enabled) {
    if (process.env.EMAIL_DAILY_ENABLED === "true") {
      console.warn(`Daily email sender is not active: ${config.reason}`);
    }
    return null;
  }

  const intervalMs = boundedPositiveInteger(
    process.env.EMAIL_DAILY_CHECK_INTERVAL_MS,
    15 * 60 * 1000,
    6 * 60 * 60 * 1000
  );
  const check = async () => {
    try {
      const result = await runDailyMarketingCampaign();
      if (result.ran) {
        console.log(
          `Daily email sender sent ${result.delivery.sentCount} emails for campaign ${result.campaignId}.`
        );
      }
    } catch (error) {
      console.error("Daily email sender failed:", error);
    }
  };

  console.log(
    `Daily email sender armed for campaign ${config.campaignId}: ${config.limit} emails at ${process.env.EMAIL_DAILY_TIME || "09:00"} ${config.timeZone}.`
  );
  setTimeout(check, 5000);
  return setInterval(check, intervalMs);
}

const leadLocations = {
  sf: {
    bbox: [37.62, -122.56, 37.91, -122.22],
    label: "San Francisco area, CA",
  },
  "san francisco": {
    bbox: [37.62, -122.56, 37.91, -122.22],
    label: "San Francisco area, CA",
  },
};

function leadLocationFromCommand(command) {
  const normalized = String(command || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const compact = normalized.replace(/\s+/g, " ").trim();

  if (/\bsf\b/.test(compact) || compact.includes("san francisco")) {
    return leadLocations.sf;
  }

  return null;
}

function normalizeWebsite(value) {
  const raw = clean(value);

  if (!raw) {
    return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw.replace(/^\/+/, "")}`;
}

function normalizeEmail(value) {
  const email = clean(value)
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
}

function addressFromTags(tags = {}) {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:city"],
    tags["addr:state"],
    tags["addr:postcode"],
  ].filter(Boolean);

  return clean(parts.join(", "));
}

function leadFromOsmElement(element) {
  const tags = element.tags || {};
  const name = clean(tags.name || tags.operator || "Dental clinic");
  const website = normalizeWebsite(
    tags.website || tags["contact:website"] || tags.url || tags["contact:url"]
  );
  const email = normalizeEmail(tags.email || tags["contact:email"]);

  return {
    address: addressFromTags(tags) || null,
    clinic: name,
    email,
    phone: clean(tags.phone || tags["contact:phone"]) || null,
    source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    website,
  };
}

function uniqueLeads(leads) {
  const seen = new Set();
  const unique = [];

  for (const lead of leads) {
    const key = [lead.email || "", lead.website || "", lead.clinic, lead.address || ""]
      .join("|")
      .toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(lead);
    }
  }

  return unique;
}

function clinicLeadSourceKey(lead) {
  return [
    lead.source_url || "",
    lead.website || "",
    lead.email || "",
    lead.clinic || "",
    lead.address || "",
  ]
    .join("|")
    .toLowerCase();
}

function extractEmails(text) {
  const emails = new Set();
  const source = String(text || "")
    .replace(/%40/g, "@")
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
  const matches = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];

  for (const match of matches) {
    const email = normalizeEmail(match);
    if (isUsableLeadEmail(email)) {
      emails.add(email);
    }
  }

  return [...emails];
}

function isUsableLeadEmail(email) {
  if (!email) {
    return false;
  }

  const [localPart, domain] = email.split("@");
  const blockedDomains = new Set([
    "domain.com",
    "example.com",
    "example.org",
    "example.net",
    "yourdomain.com",
    "sentry.io",
    "schema.org",
    "wixpress.com",
    "wordpress.com",
  ]);
  const blockedLocals = new Set(["user", "username", "name", "yourname", "test", "email"]);

  return (
    !blockedDomains.has(domain) &&
    !blockedLocals.has(localPart) &&
    !email.includes("example.") &&
    !email.match(/\.(png|jpg|jpeg|gif|webp|svg)$/)
  );
}

async function fetchTextWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "DentalMotionLeadFetcher/1.0 (+https://dentalmotiongraphic.com)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return "";
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return "";
    }

    return (await response.text()).slice(0, 250000);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function findWebsiteEmail(website) {
  if (!website) {
    return null;
  }

  const base = normalizeWebsite(website);
  let urls;

  try {
    urls = [
      base,
      new URL("/contact", base).toString(),
      new URL("/contact-us", base).toString(),
      new URL("/about", base).toString(),
      new URL("/about-us", base).toString(),
      new URL("/appointments", base).toString(),
      new URL("/request-appointment", base).toString(),
      new URL("/new-patients", base).toString(),
      new URL("/patient-info", base).toString(),
      new URL("/locations", base).toString(),
    ];
  } catch {
    return null;
  }

  const pages = await Promise.all(urls.map((url) => fetchTextWithTimeout(url)));

  for (const html of pages) {
    const [email] = extractEmails(html);
    if (email) {
      return email;
    }
  }

  return null;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function saveClinicResearchLeads(leads, locationLabel, queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  let saved = 0;
  let withEmail = 0;
  let withoutEmail = 0;

  for (const lead of leads) {
    const sourceKey = clinicLeadSourceKey(lead);
    if (!sourceKey.trim()) {
      continue;
    }

    const hasEmail = Boolean(lead.email);
    if (hasEmail) {
      withEmail += 1;
    } else {
      withoutEmail += 1;
    }

    await queryable.query(
      `
        INSERT INTO clinic_research_leads (
          source_key,
          location,
          clinic,
          email,
          website,
          phone,
          address,
          source_url,
          has_email,
          raw,
          updated_at,
          last_seen_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())
        ON CONFLICT (source_key) DO UPDATE
        SET location = EXCLUDED.location,
            clinic = EXCLUDED.clinic,
            email = COALESCE(EXCLUDED.email, clinic_research_leads.email),
            website = COALESCE(EXCLUDED.website, clinic_research_leads.website),
            phone = COALESCE(EXCLUDED.phone, clinic_research_leads.phone),
            address = COALESCE(EXCLUDED.address, clinic_research_leads.address),
            source_url = COALESCE(EXCLUDED.source_url, clinic_research_leads.source_url),
            has_email = EXCLUDED.has_email OR clinic_research_leads.has_email,
            raw = EXCLUDED.raw,
            updated_at = NOW(),
            last_seen_at = NOW()
      `,
      [
        sourceKey,
        locationLabel,
        lead.clinic || "Dental clinic",
        lead.email || null,
        lead.website || null,
        lead.phone || null,
        lead.address || null,
        lead.source_url || null,
        hasEmail,
        JSON.stringify(lead),
      ]
    );
    saved += 1;
  }

  return { saved: true, raw_saved: saved, raw_with_email: withEmail, raw_without_email: withoutEmail };
}

function overpassDentistQuery({ bbox, maxLeads }) {
  const [south, west, north, east] = bbox;

  return `[out:json][timeout:40];(
    node["amenity"="dentist"](${south},${west},${north},${east});
    way["amenity"="dentist"](${south},${west},${north},${east});
    relation["amenity"="dentist"](${south},${west},${north},${east});
    node["healthcare"="dentist"](${south},${west},${north},${east});
    way["healthcare"="dentist"](${south},${west},${north},${east});
    relation["healthcare"="dentist"](${south},${west},${north},${east});
    node["healthcare:speciality"~"dentistry|orthodontics|oral_surgery",i](${south},${west},${north},${east});
    way["healthcare:speciality"~"dentistry|orthodontics|oral_surgery",i](${south},${west},${north},${east});
    relation["healthcare:speciality"~"dentistry|orthodontics|oral_surgery",i](${south},${west},${north},${east});
  );out center tags;`;
}

function leadScore(lead) {
  let score = 0;
  if (lead.email) score += 100;
  if (lead.website) score += 30;
  if (lead.phone) score += 10;
  if (lead.address) score += 10;
  if (!/^dent(al|ist) (clinic|office)$/i.test(lead.clinic)) score += 5;
  return score;
}

async function fetchDentalClinicLeads(command, queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  const location = leadLocationFromCommand(command);
  if (!location) {
    throw new Error("I can fetch SF dental clinics right now. Try: fetch sf dental clinics");
  }

  await ensureMarketingTables(queryable);

  const maxLeads = boundedPositiveInteger(process.env.LEAD_FETCH_LIMIT, 120, 250);
  const websiteScanLimit = boundedPositiveInteger(process.env.LEAD_FETCH_WEBSITE_SCAN_LIMIT, 80, 150);
  const websiteScanConcurrency = boundedPositiveInteger(process.env.LEAD_FETCH_CONCURRENCY, 6, 12);
  const overpassQuery = overpassDentistQuery({ bbox: location.bbox, maxLeads });
  const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
  const response = await fetch(overpassUrl, {
    headers: {
      "User-Agent": "DentalMotionLeadFetcher/1.0 (+https://dentalmotiongraphic.com)",
    },
  });

  if (!response.ok) {
    throw new Error(`Lead fetch failed with ${response.status}. Try again in a few minutes.`);
  }

  const data = await response.json();
  const leads = uniqueLeads((data.elements || []).map(leadFromOsmElement))
    .sort((a, b) => leadScore(b) - leadScore(a))
    .slice(0, maxLeads);
  let scannedWebsites = 0;
  const scanTargets = leads
    .filter((lead) => !lead.email && lead.website)
    .slice(0, websiteScanLimit);

  await mapWithConcurrency(scanTargets, websiteScanConcurrency, async (lead) => {
    scannedWebsites += 1;
    lead.email = await findWebsiteEmail(lead.website);
  });

  const rawSaved = await saveClinicResearchLeads(leads, location.label, queryable);
  const withEmail = leads.filter((lead) => lead.email);
  const withoutEmail = leads.filter((lead) => !lead.email);
  let imported = { imported: 0, active: 0, unsubscribed: 0 };

  if (withEmail.length > 0) {
    imported = await upsertMarketingSubscribers(
      {
        consent_note: `Public business contact found while researching dental clinics in ${location.label}. Send compliant outreach with unsubscribe.`,
        resubscribe: false,
        subscribers: withEmail.map((lead) => ({
          address: lead.address,
          clinic: lead.clinic,
          email: lead.email,
          name: lead.clinic,
          phone: lead.phone,
          source: `lead fetch: ${location.label}`,
          website: lead.website || lead.source_url,
        })),
      },
      queryable
    );
  }

  const overview = await marketingSubscribersOverview(queryable);

  return {
    saved: true,
    location: location.label,
    found: leads.length,
    imported: imported.imported || 0,
    raw_saved: rawSaved.raw_saved || 0,
    raw_with_email: rawSaved.raw_with_email || 0,
    raw_without_email: rawSaved.raw_without_email || 0,
    skipped_without_email: withoutEmail.length,
    scanned_websites: scannedWebsites,
    source_records: data.elements?.length || 0,
    samples: withEmail.slice(0, 10).map((lead) => ({
      clinic: lead.clinic,
      email: lead.email,
      website: lead.website,
    })),
    stats: overview.stats,
  };
}

function defaultDentalOutreachCampaign(limit = 15, options = {}) {
  const showcase = outreachShowcaseConfig(options);
  const safeWebsiteUrl = escapeHtml(showcase.websiteUrl);
  const videosHtml = videoLinksHtml(showcase.videoUrls);
  const videosText = videoLinksText(showcase.videoUrls);
  const allowResend = booleanOption(options.resend_sent ?? options.resendSent, false);
  const attachments = campaignVideoAttachments(options);

  return {
    html: `
      <div style="margin:0 auto;max-width:620px;border:1px solid #e6d8bf;border-radius:28px;overflow:hidden;background:#fffaf0;color:#10242f;font-family:Georgia,'Times New Roman',serif;">
        <div style="padding:28px 30px;background:linear-gradient(135deg,#10242f,#0f766e);color:#fffaf0;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#f8d089;">Dental Motion</p>
          <h1 style="margin:0;font-size:30px;line-height:1.08;">Patient-friendly dental motion graphic videos</h1>
        </div>
        <div style="padding:30px;">
          <p style="margin:0 0 16px;">Hi {{clinic}},</p>
          <p style="margin:0 0 16px;line-height:1.65;">I create short dental motion graphic videos that help patients understand treatments like implants, veneers, aligners, whitening, and smile transformations before they book.</p>
          <p style="margin:0 0 16px;line-height:1.65;">The goal is simple: give your clinic a polished visual asset for your website, social media, ads, and consultation follow-ups.</p>
          ${videosHtml || "<p style=\"margin:0 0 16px;line-height:1.65;\">I attached a short example video so you can see the style right away.</p>"}
          <p style="margin:0 0 24px;line-height:1.65;">You can also see the site here: <a href="${safeWebsiteUrl}" style="color:#0f766e;font-weight:700;">${safeWebsiteUrl}</a></p>
          <p style="margin:0 0 22px;line-height:1.65;">If a custom video could help your clinic explain one treatment more clearly, reply with the treatment you want animated and I will send a simple quote.</p>
          <p style="margin:0;line-height:1.65;">Best,<br>Dental Motion<br><a href="${safeWebsiteUrl}" style="color:#0f766e;">${safeWebsiteUrl}</a></p>
        </div>
      </div>
    `,
    attachments,
    limit,
    only_unsent: !allowResend,
    preview_text: "A short custom dental animation your patients can understand fast.",
    send: false,
    subject: "A short dental motion graphic video for {{clinic}}",
    text:
      `Hi {{clinic}},\n\nI create short dental motion graphic videos that help patients understand treatments like implants, veneers, aligners, whitening, and smile transformations before they book.\n\nThe goal is simple: give your clinic a polished visual asset for your website, social media, ads, and consultation follow-ups.\n\nWebsite: ${showcase.websiteUrl}${videosText || "\n\nI attached a short example video so you can see the style right away."}\n\nIf a custom video could help your clinic explain one treatment more clearly, reply with the treatment you want animated and I will send a simple quote.\n\nBest,\nDental Motion\n${showcase.websiteUrl}`,
  };
}

async function sendNextLeadBatch(limit = 15, options = {}, queryable = getDatabasePool()) {
  if (options && typeof options.query === "function") {
    queryable = options;
    options = {};
  }

  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const batchLimit = boundedPositiveInteger(limit, 15, 50);
  const campaignPayload = defaultDentalOutreachCampaign(batchLimit, options);
  const campaign = await createMarketingCampaign(campaignPayload, queryable);

  if (!campaign.saved || campaign.queued === 0) {
    const overview = await marketingSubscribersOverview(queryable);
    const allowResend = booleanOption(options.resend_sent ?? options.resendSent, false);
    return {
      saved: true,
      campaign,
      delivery: null,
      message: allowResend
        ? "No active leads are available to resend."
        : "No unsent leads are ready. Fetch clinics first, import a list, or choose resend if you intentionally want to email already-sent leads again.",
      stats: overview.stats,
    };
  }

  const delivery = await sendMarketingCampaign(
    campaign.campaignId,
    { attachments: campaignPayload.attachments, limit: batchLimit },
    queryable
  );
  const overview = await marketingSubscribersOverview(queryable);
  const allowResend = booleanOption(options.resend_sent ?? options.resendSent, false);

  return {
    saved: true,
    campaign,
    delivery,
    message: allowResend
      ? `Resent ${delivery.sentCount} emails by request.`
      : `Sent ${delivery.sentCount} emails. Sent leads are removed from the pending queue.`,
    stats: overview.stats,
  };
}

async function sendLeadTestEmail(options = {}) {
  const campaign = defaultDentalOutreachCampaign(1, {
    ...options,
    attach_video: options.attach_video ?? options.attachVideo ?? true,
    resend_sent: true,
  });
  const subscriber = {
    clinic: "Bright Smile Dental Studio",
    email: contactRecipient,
    name: "Bright Smile Dental Studio",
    unsubscribe_token: "test-preview",
  };
  const delivery = await sendMarketingEmail(campaign, subscriber);

  return {
    attached: (campaign.attachments || []).map((attachment) => attachment.filename),
    delivery,
    sent: true,
    subject: personalizeTemplate(campaign.subject, subscriber),
    to: contactRecipient,
    video_urls: outreachShowcaseConfig(options).videoUrls,
  };
}

async function unsubscribeMarketingSubscriber(token, queryable = getDatabasePool()) {
  if (!queryable) {
    return { saved: false, reason: "DATABASE_NOT_CONFIGURED" };
  }

  await ensureMarketingTables(queryable);

  const result = await queryable.query(
    `
      UPDATE email_subscribers
      SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
          updated_at = NOW()
      WHERE unsubscribe_token = $1
      RETURNING email
    `,
    [token]
  );

  if (result.rowCount === 0) {
    return { saved: true, unsubscribed: false };
  }

  return { saved: true, unsubscribed: true, email: result.rows[0].email };
}

async function sendContactEmail(contact, transportFactory = nodemailer.createTransport) {
  if (process.env.CONTACT_DRY_RUN === "true") {
    return { dryRun: true };
  }

  const resend = resendConfig();
  const content = contactEmailContent(contact);

  if (resend) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resend.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resend.fromEmail,
        to: [contactRecipient],
        reply_to: contact.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Resend email failed with ${response.status}: ${detail}`);
      error.code = "EMAIL_SEND_FAILED";
      throw error;
    }

    return { dryRun: false, provider: "resend" };
  }

  const config = smtpConfig();

  if (!config) {
    const error = new Error("Email delivery is not configured yet.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  const fromEmail = process.env.SMTP_FROM_EMAIL || config.auth.user;
  const transporter = transportFactory(config);

  await transporter.sendMail({
    from: `"Dental Motion Website" <${fromEmail}>`,
    to: contactRecipient,
    replyTo: contact.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });

  return { dryRun: false, provider: "smtp" };
}

async function handleContact(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  const validation = validateContact(payload);
  if (validation.error) {
    sendJson(response, 400, { ok: false, message: validation.error });
    return;
  }

  let savedSubmission = { saved: false };

  try {
    savedSubmission = await saveContactSubmission(validation.data);
  } catch (error) {
    console.error("Contact database save failed:", error);
    sendJson(response, 503, {
      ok: false,
      message: "The message could not be saved right now. Please try again soon.",
    });
    return;
  }

  if (!savedSubmission.saved && isDatabaseRequired()) {
    sendJson(response, 503, {
      ok: false,
      message: `Database is not connected yet. Please email ${contactRecipient} directly for now.`,
    });
    return;
  }

  try {
    await sendContactEmail(validation.data);
    await updateContactEmailStatus(savedSubmission.id, true, null);
    sendJson(response, 200, {
      ok: true,
      message: `Thanks. Your concept request was sent to ${contactRecipient}.`,
    });
  } catch (error) {
    await updateContactEmailStatus(savedSubmission.id, false, error.message);

    if (error.code === "EMAIL_NOT_CONFIGURED") {
      sendJson(response, 503, {
        ok: false,
        message: `Your request was saved, but email is not connected yet. Please email ${contactRecipient} directly for now.`,
      });
      return;
    }

    console.error("Contact email failed:", error);
    sendJson(response, 502, {
      ok: false,
      message: "The message could not be sent right now. Please try again soon.",
    });
  }
}

async function handleAdminSubscribers(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method === "GET") {
    const overview = await marketingSubscribersOverview();

    if (!overview.saved) {
      sendJson(response, 503, {
        ok: false,
        message: "Database is not connected yet.",
      });
      return;
    }

    sendJson(response, 200, { ok: true, stats: overview.stats, recent: overview.recent });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  try {
    const result = await upsertMarketingSubscribers(payload);

    if (!result.saved) {
      sendJson(response, 503, {
        ok: false,
        message: "Database is not connected yet.",
      });
      return;
    }

    sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
  }
}

async function handleAdminCampaigns(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  try {
    const created = await createMarketingCampaign(payload);

    if (!created.saved) {
      sendJson(response, 503, {
        ok: false,
        message: "Database is not connected yet.",
      });
      return;
    }

    let delivery = null;
    if (payload.send !== false && created.queued > 0) {
      delivery = await sendMarketingCampaign(created.campaignId, { limit: payload.batch_size });
    }

    sendJson(response, 200, { ok: true, campaign: created, delivery });
  } catch (error) {
    const statusCode = error.code === "EMAIL_NOT_CONFIGURED" ? 503 : 400;
    sendJson(response, statusCode, { ok: false, message: error.message });
  }
}

async function handleAdminCampaignSend(request, response, campaignId) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  try {
    const delivery = await sendMarketingCampaign(campaignId, { limit: payload.batch_size });

    if (!delivery.sent) {
      sendJson(response, 503, {
        ok: false,
        message: "Database is not connected yet.",
      });
      return;
    }

    sendJson(response, 200, { ok: true, delivery });
  } catch (error) {
    const statusCode = error.code === "EMAIL_NOT_CONFIGURED" ? 503 : 400;
    sendJson(response, statusCode, { ok: false, message: error.message });
  }
}

async function handleAdminDailySend(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  try {
    const result = await runDailyMarketingCampaign();

    if (result.reason === "DATABASE_NOT_CONFIGURED") {
      sendJson(response, 503, {
        ok: false,
        message: "Database is not connected yet.",
      });
      return;
    }

    sendJson(response, 200, { ok: true, daily: result });
  } catch (error) {
    const statusCode = error.code === "EMAIL_NOT_CONFIGURED" ? 503 : 400;
    sendJson(response, statusCode, { ok: false, message: error.message });
  }
}

async function handleAdminLeadFetch(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  try {
    const result = await fetchDentalClinicLeads(payload.command || payload.query || "fetch sf dental clinics");

    if (!result.saved) {
      sendJson(response, 503, { ok: false, message: "Database is not connected yet." });
      return;
    }

    sendJson(response, 200, { ok: true, leads: result });
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
  }
}

async function handleAdminLeadSend(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  try {
    const result = await sendNextLeadBatch(payload.limit || 15, payload);

    if (!result.saved) {
      sendJson(response, 503, { ok: false, message: "Database is not connected yet." });
      return;
    }

    sendJson(response, 200, { ok: true, leads: result });
  } catch (error) {
    const statusCode = error.code === "EMAIL_NOT_CONFIGURED" ? 503 : 400;
    sendJson(response, statusCode, { ok: false, message: error.message });
  }
}

async function handleAdminLeadTestEmail(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  try {
    const result = await sendLeadTestEmail(payload);
    sendJson(response, 200, { ok: true, test_email: result });
  } catch (error) {
    const statusCode = error.code === "EMAIL_NOT_CONFIGURED" ? 503 : 400;
    sendJson(response, statusCode, { ok: false, message: error.message });
  }
}

async function handleAdminCommand(request, response) {
  if (!requireMarketingAdmin(request, response)) {
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "Method not allowed." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message });
    return;
  }

  const command = clean(payload.command).toLowerCase();

  if (command.startsWith("fetch")) {
    try {
      const result = await fetchDentalClinicLeads(command);
      if (!result.saved) {
        sendJson(response, 503, { ok: false, message: "Database is not connected yet." });
        return;
      }
      sendJson(response, 200, { ok: true, type: "fetch", leads: result });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: error.message });
    }
    return;
  }

  if (command.includes("send")) {
    const match = command.match(/\b(\d{1,2})\b/);
    const limit = match ? Number(match[1]) : 15;
    const options = {
      ...payload,
      resend_sent: Boolean(payload.resend_sent) || /\b(again|resend|resent|already sent)\b/.test(command),
    };

    try {
      const result = await sendNextLeadBatch(limit, options);
      if (!result.saved) {
        sendJson(response, 503, { ok: false, message: "Database is not connected yet." });
        return;
      }
      sendJson(response, 200, { ok: true, type: "send", leads: result });
    } catch (error) {
      const statusCode = error.code === "EMAIL_NOT_CONFIGURED" ? 503 : 400;
      sendJson(response, statusCode, { ok: false, message: error.message });
    }
    return;
  }

  if (command === "stats" || command === "status") {
    const overview = await marketingSubscribersOverview();
    if (!overview.saved) {
      sendJson(response, 503, { ok: false, message: "Database is not connected yet." });
      return;
    }
    sendJson(response, 200, { ok: true, type: "stats", stats: overview.stats, recent: overview.recent });
    return;
  }

  sendJson(response, 400, {
    ok: false,
    message: "Try: fetch sf dental clinics, send 15, or stats.",
  });
}

async function handleUnsubscribe(request, response, url) {
  if (request.method !== "GET" && request.method !== "POST") {
    sendHtml(response, 405, "<h1>Method not allowed</h1>");
    return;
  }

  const token = clean(url.searchParams.get("token"));

  if (!token) {
    sendHtml(response, 400, "<h1>Missing unsubscribe token</h1>");
    return;
  }

  const result = await unsubscribeMarketingSubscriber(token);

  if (!result.saved) {
    sendHtml(response, 503, "<h1>Unsubscribe is not available right now</h1>");
    return;
  }

  if (!result.unsubscribed) {
    sendHtml(response, 404, "<h1>Unsubscribe link not found</h1>");
    return;
  }

  sendHtml(
    response,
    200,
    `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Unsubscribed | Dental Motion</title>
          <style>
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Georgia, serif; color: #10242f; background: #fff8ed; }
            main { max-width: 520px; padding: 40px; text-align: center; }
            a { color: #0f766e; }
          </style>
        </head>
        <body>
          <main>
            <h1>You are unsubscribed</h1>
            <p>${escapeHtml(result.email)} will no longer receive Dental Motion emails.</p>
            <p><a href="/">Return to Dental Motion</a></p>
          </main>
        </body>
      </html>
    `
  );
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const path = url.pathname;
  const campaignSendMatch = path.match(/^\/api\/admin\/campaigns\/(\d+)\/send$/);

  if (path === "/api/contact") {
    await handleContact(request, response);
    return;
  }

  if (path === "/api/admin/subscribers") {
    await handleAdminSubscribers(request, response);
    return;
  }

  if (path === "/api/admin/campaigns") {
    await handleAdminCampaigns(request, response);
    return;
  }

  if (campaignSendMatch) {
    await handleAdminCampaignSend(request, response, campaignSendMatch[1]);
    return;
  }

  if (path === "/api/admin/daily/send") {
    await handleAdminDailySend(request, response);
    return;
  }

  if (path === "/api/admin/leads/fetch") {
    await handleAdminLeadFetch(request, response);
    return;
  }

  if (path === "/api/admin/leads/send-15") {
    await handleAdminLeadSend(request, response);
    return;
  }

  if (path === "/api/admin/leads/test-email") {
    await handleAdminLeadTestEmail(request, response);
    return;
  }

  if (path === "/api/admin/command") {
    await handleAdminCommand(request, response);
    return;
  }

  if (path === "/unsubscribe") {
    await handleUnsubscribe(request, response, url);
    return;
  }

  const filePath = resolveRequestPath(request.url || "/");

  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": types[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

if (require.main === module) {
  createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("Unhandled request error:", error);
      sendJson(response, 500, { ok: false, message: "Unexpected server error." });
    });
  }).listen(port, () => {
  console.log(`Dental Motion Atelier is running on port ${port}`);
  startDailyCampaignScheduler();
  });
}

module.exports = {
  campaignEmailContent,
  createMarketingCampaign,
  contactEmailContent,
  clinicResearchStats,
  dailyCampaignConfig,
  databaseConfig,
  defaultDentalOutreachCampaign,
  ensureMarketingTables,
  fetchDentalClinicLeads,
  handleRequest,
  leadLocationFromCommand,
  localDateTimeParts,
  marketingSubscribersOverview,
  normalizeEmail,
  overpassDentistQuery,
  outreachShowcaseConfig,
  parseDailyTime,
  parseUrlList,
  personalizeTemplate,
  requireMarketingAdmin,
  runDailyMarketingCampaign,
  resendConfig,
  sendNextLeadBatch,
  sendLeadTestEmail,
  sendMarketingCampaign,
  sendContactEmail,
  sendMarketingEmail,
  startDailyCampaignScheduler,
  saveContactSubmission,
  saveClinicResearchLeads,
  smtpConfig,
  unsubscribeMarketingSubscriber,
  updateContactEmailStatus,
  upsertMarketingSubscribers,
  validateContact,
  validateCampaignPayload,
  validateMarketingSubscriber,
};
