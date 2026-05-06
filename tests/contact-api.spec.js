const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const test = require("node:test");
const {
  campaignEmailContent,
  contactEmailContent,
  dailyCampaignConfig,
  defaultDentalOutreachCampaign,
  handleRequest,
  leadLocationFromCommand,
  localDateTimeParts,
  normalizeEmail,
  overpassDentistQuery,
  parseDailyTime,
  personalizeTemplate,
  resendConfig,
  requireMarketingAdmin,
  sendMarketingEmail,
  saveContactSubmission,
  updateContactEmailStatus,
  validateCampaignPayload,
  validateMarketingSubscriber,
} = require("../server");

function startTestServer() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: error.message }));
      });
    });

    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function postContact(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    body: await response.json(),
    status: response.status,
  };
}

function fakeJsonResponse() {
  return {
    body: null,
    status: null,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}

test("contact endpoint accepts a valid dry-run submission", async () => {
  process.env.CONTACT_DRY_RUN = "true";
  const { server, url } = await startTestServer();

  try {
    const response = await postContact(url, {
      name: "Atelier Dental",
      email: "hello@example.com",
      offer: "Premium veneer launch campaign",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.match(response.body.message, /team@dentalmotiongraphic\.com/);
  } finally {
    delete process.env.CONTACT_DRY_RUN;
    server.close();
  }
});

test("contact endpoint is honest when database is not configured", async () => {
  delete process.env.CONTACT_DRY_RUN;
  delete process.env.DATABASE_URL;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  const { server, url } = await startTestServer();

  try {
    const response = await postContact(url, {
      name: "Atelier Dental",
      email: "hello@example.com",
      offer: "Premium veneer launch campaign",
    });

    assert.equal(response.status, 503);
    assert.equal(response.body.ok, false);
    assert.match(response.body.message, /Database is not connected yet/);
  } finally {
    server.close();
  }
});

test("contact submissions are written with email status updates", async () => {
  const calls = [];
  const fakeDatabase = {
    async query(sql, params = []) {
      calls.push({ params, sql });
      if (sql.includes("RETURNING id")) {
        return { rows: [{ id: "42" }] };
      }
      return { rows: [] };
    },
  };

  const saved = await saveContactSubmission(
    {
      name: "Atelier Dental",
      email: "hello@example.com",
      offer: "Premium veneer launch campaign",
    },
    fakeDatabase
  );
  await updateContactEmailStatus(saved.id, true, null, fakeDatabase);

  assert.deepEqual(saved, { id: "42", saved: true });
  assert.ok(calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS contact_submissions")));
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO contact_submissions")));
  assert.ok(calls.some((call) => call.sql.includes("UPDATE contact_submissions")));
  assert.deepEqual(calls.find((call) => call.sql.includes("INSERT INTO contact_submissions")).params, [
    "Atelier Dental",
    "hello@example.com",
    "Premium veneer launch campaign",
  ]);
});

test("resend configuration is selected when an API key is present", () => {
  process.env.RESEND_KEY = "re_test_key";
  process.env.RESEND_FROM_EMAIL = "Dental Motion <hello@dentalmotiongraphic.com>";

  assert.deepEqual(resendConfig(), {
    apiKey: "re_test_key",
    fromEmail: "Dental Motion <hello@dentalmotiongraphic.com>",
  });

  delete process.env.RESEND_KEY;
  delete process.env.RESEND_FROM_EMAIL;
});

test("contact email content escapes user text", () => {
  const content = contactEmailContent({
    name: "<Clinic>",
    email: "hello@example.com",
    offer: "Veneers & implants",
  });

  assert.match(content.subject, /<Clinic>/);
  assert.match(content.text, /Veneers & implants/);
  assert.match(content.html, /&lt;Clinic&gt;/);
  assert.match(content.html, /Veneers &amp; implants/);
});

test("marketing admin routes require a configured bearer token", () => {
  delete process.env.EMAIL_ADMIN_TOKEN;
  const missingConfigResponse = fakeJsonResponse();

  assert.equal(requireMarketingAdmin({ headers: {} }, missingConfigResponse), false);
  assert.equal(missingConfigResponse.status, 503);
  assert.match(missingConfigResponse.body.message, /EMAIL_ADMIN_TOKEN/);

  process.env.EMAIL_ADMIN_TOKEN = "secret-token";
  const missingTokenResponse = fakeJsonResponse();

  assert.equal(requireMarketingAdmin({ headers: {} }, missingTokenResponse), false);
  assert.equal(missingTokenResponse.status, 401);

  const validResponse = fakeJsonResponse();
  assert.equal(
    requireMarketingAdmin(
      {
        headers: {
          authorization: "Bearer secret-token",
        },
      },
      validResponse
    ),
    true
  );

  delete process.env.EMAIL_ADMIN_TOKEN;
});

test("marketing subscribers must include consent evidence", () => {
  const missingConsent = validateMarketingSubscriber({
    email: "owner@example.com",
    name: "Clinic Owner",
  });

  assert.match(missingConsent.error, /consent_note/);

  const valid = validateMarketingSubscriber({
    email: "OWNER@EXAMPLE.COM",
    name: "Clinic Owner",
    clinic: "Example Dental",
    consent_note: "They opted in through the clinic owner list.",
  });

  assert.deepEqual(valid.data, {
    email: "owner@example.com",
    name: "Clinic Owner",
    clinic: "Example Dental",
    website: null,
    phone: null,
    address: null,
    source: "manual import",
    consentNote: "They opted in through the clinic owner list.",
  });
});

test("campaign payload creates text fallback and caps recipient limit", () => {
  process.env.EMAIL_CAMPAIGN_MAX_RECIPIENTS = "25";

  const valid = validateCampaignPayload({
    subject: "Dental video offer",
    html: "<h1>Dental videos</h1><p>Show implant treatment steps clearly.</p>",
    limit: 999,
  });

  assert.equal(valid.data.limit, 25);
  assert.match(valid.data.text, /Dental videos/);
  assert.match(valid.data.text, /implant treatment/);

  delete process.env.EMAIL_CAMPAIGN_MAX_RECIPIENTS;
});

test("campaign email content includes unsubscribe compliance footer", () => {
  process.env.PUBLIC_SITE_URL = "https://dentalmotiongraphic.com/";
  process.env.EMAIL_FOOTER_ADDRESS = "Dental Motion, 123 Clinic Street";

  const content = campaignEmailContent(
    {
      html: "<p>Hello doctor.</p>",
      text: "Hello doctor.",
    },
    {
      email: "owner@example.com",
      unsubscribe_token: "abc123",
    }
  );

  assert.match(content.html, /Unsubscribe/);
  assert.match(content.html, /Dental Motion, 123 Clinic Street/);
  assert.match(content.text, /https:\/\/dentalmotiongraphic\.com\/unsubscribe\?token=abc123/);

  delete process.env.PUBLIC_SITE_URL;
  delete process.env.EMAIL_FOOTER_ADDRESS;
});

test("marketing email sends through Resend with domain sender and list unsubscribe", async () => {
  process.env.RESEND_KEY = "re_test_key";
  process.env.EMAIL_CAMPAIGN_FROM_EMAIL = "Dental Motion <team@dentalmotiongraphic.com>";
  process.env.PUBLIC_SITE_URL = "https://dentalmotiongraphic.com";

  let capturedRequest;
  const result = await sendMarketingEmail(
    {
      subject: "Dental video offer",
      html: "<p>Hello doctor.</p>",
      text: "Hello doctor.",
    },
    {
      email: "owner@example.com",
      unsubscribe_token: "abc123",
    },
    async (url, request) => {
      capturedRequest = { url, request };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ id: "email_123" });
        },
      };
    }
  );

  const body = JSON.parse(capturedRequest.request.body);

  assert.deepEqual(result, { id: "email_123", provider: "resend", dryRun: false });
  assert.equal(capturedRequest.url, "https://api.resend.com/emails");
  assert.equal(capturedRequest.request.headers.Authorization, "Bearer re_test_key");
  assert.equal(body.from, "Dental Motion <team@dentalmotiongraphic.com>");
  assert.deepEqual(body.to, ["owner@example.com"]);
  assert.match(body.headers["List-Unsubscribe"], /\/unsubscribe\?token=abc123/);

  delete process.env.RESEND_KEY;
  delete process.env.EMAIL_CAMPAIGN_FROM_EMAIL;
  delete process.env.PUBLIC_SITE_URL;
});

test("lead commands understand SF and outreach template personalizes clinic names", () => {
  assert.deepEqual(leadLocationFromCommand("fetch sf dental clinics"), {
    bbox: [37.62, -122.56, 37.91, -122.22],
    label: "San Francisco area, CA",
  });
  assert.equal(leadLocationFromCommand("fetch paris dental clinics"), null);

  const campaign = defaultDentalOutreachCampaign(15);
  assert.equal(campaign.only_unsent, true);
  assert.equal(campaign.limit, 15);
  assert.match(campaign.subject, /{{clinic}}/);
  assert.match(
    personalizeTemplate(campaign.subject, {
      clinic: "Marina Dental",
      email: "hello@example.com",
    }),
    /Marina Dental/
  );
});

test("lead fetch helpers cover broader dentist data and normalize emails", () => {
  assert.equal(normalizeEmail("mailto:Info@Clinic.com?subject=Hello"), "info@clinic.com");
  assert.equal(normalizeEmail("not-an-email"), null);

  const query = overpassDentistQuery({
    bbox: [37.62, -122.56, 37.91, -122.22],
    maxLeads: 120,
  });

  assert.match(query, /node\["amenity"="dentist"\]/);
  assert.match(query, /way\["healthcare"="dentist"\]/);
  assert.match(query, /healthcare:speciality/);
  assert.match(query, /out center tags 120/);
});

test("daily campaign config is explicit and limited", () => {
  delete process.env.EMAIL_DAILY_ENABLED;
  assert.deepEqual(dailyCampaignConfig(), {
    enabled: false,
    reason: "EMAIL_DAILY_ENABLED is not true.",
  });

  process.env.EMAIL_DAILY_ENABLED = "true";
  process.env.EMAIL_DAILY_CAMPAIGN_ID = "12";
  process.env.EMAIL_DAILY_LIMIT = "999";
  process.env.EMAIL_DAILY_TIME = "09:30";
  process.env.EMAIL_DAILY_TIME_ZONE = "America/Los_Angeles";

  const config = dailyCampaignConfig();

  assert.equal(config.enabled, true);
  assert.equal(config.campaignId, "12");
  assert.equal(config.limit, 500);
  assert.deepEqual(config.sendTime, { hour: 9, minute: 30, minutes: 570 });
  assert.equal(config.timeZone, "America/Los_Angeles");

  delete process.env.EMAIL_DAILY_ENABLED;
  delete process.env.EMAIL_DAILY_CAMPAIGN_ID;
  delete process.env.EMAIL_DAILY_LIMIT;
  delete process.env.EMAIL_DAILY_TIME;
  delete process.env.EMAIL_DAILY_TIME_ZONE;
});

test("daily campaign time helpers understand local schedule", () => {
  assert.deepEqual(parseDailyTime("08:05"), { hour: 8, minute: 5, minutes: 485 });
  assert.equal(parseDailyTime("25:00"), null);

  const parts = localDateTimeParts(
    new Date("2026-05-05T16:15:00.000Z"),
    "America/Los_Angeles"
  );

  assert.equal(parts.date, "2026-05-05");
  assert.equal(parts.minutes, 555);
});
