const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const test = require("node:test");
const { handleRequest, saveContactSubmission, updateContactEmailStatus } = require("../server");

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
