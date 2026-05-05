#!/usr/bin/env node

const { readFileSync } = require("node:fs");

const siteUrl = (process.env.PUBLIC_SITE_URL || "https://dentalmotiongraphic.com").replace(/\/+$/, "");
const token = process.env.EMAIL_ADMIN_TOKEN;

function usage() {
  console.log(`
Usage:
  node scripts/email-admin.js stats
  node scripts/email-admin.js import subscribers.json
  node scripts/email-admin.js send campaign.json
  node scripts/email-admin.js send-next <campaign_id>

Run through Railway so EMAIL_ADMIN_TOKEN is loaded:
  railway run --service dental-motion-atelier node scripts/email-admin.js stats
`);
}

function readJsonFile(path) {
  if (!path) {
    throw new Error("Missing JSON file path.");
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

async function request(path, options = {}) {
  if (!token) {
    throw new Error("EMAIL_ADMIN_TOKEN is not available. Run this with `railway run`.");
  }

  const response = await fetch(`${siteUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok || body.ok === false) {
    throw new Error(body.message || `Request failed with ${response.status}`);
  }

  return body;
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "stats") {
    console.log(JSON.stringify(await request("/api/admin/subscribers"), null, 2));
    return;
  }

  if (command === "import") {
    const payload = readJsonFile(arg);
    console.log(
      JSON.stringify(
        await request("/api/admin/subscribers", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
        null,
        2
      )
    );
    return;
  }

  if (command === "send") {
    const payload = readJsonFile(arg);
    let result = await request("/api/admin/campaigns", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(JSON.stringify(result, null, 2));

    while (payload.send !== false && result.delivery && result.delivery.remaining > 0) {
      result = await request(`/api/admin/campaigns/${result.campaign.campaignId}/send`, {
        method: "POST",
        body: JSON.stringify({ batch_size: payload.batch_size }),
      });
      console.log(JSON.stringify(result, null, 2));
    }

    return;
  }

  if (command === "send-next") {
    if (!arg) {
      throw new Error("Missing campaign id.");
    }

    console.log(
      JSON.stringify(
        await request(`/api/admin/campaigns/${encodeURIComponent(arg)}/send`, {
          method: "POST",
          body: "{}",
        }),
        null,
        2
      )
    );
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
