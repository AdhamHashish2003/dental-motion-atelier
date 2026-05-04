const { createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize, relative, resolve } = require("node:path");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const root = resolve(__dirname);
const port = Number(process.env.PORT || 4173);
const contactRecipient = process.env.CONTACT_TO_EMAIL || "team@dentalmotiongraphic.com";
const maxBodyBytes = 20 * 1024;
let databasePool;
let contactTableReady = false;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function resolveRequestPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath.split("?")[0] || "/");
  } catch {
    return null;
  }

  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
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

async function handleRequest(request, response) {
  if ((request.url || "").split("?")[0] === "/api/contact") {
    await handleContact(request, response);
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
  });
}

module.exports = {
  contactEmailContent,
  databaseConfig,
  handleRequest,
  resendConfig,
  sendContactEmail,
  saveContactSubmission,
  smtpConfig,
  updateContactEmailStatus,
  validateContact,
};
