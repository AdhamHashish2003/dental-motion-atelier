const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const html = readFileSync("index.html", "utf8");
const adminHtml = readFileSync("admin.html", "utf8");
const adminScript = readFileSync("admin.js", "utf8");
const script = readFileSync("script.js", "utf8");
const server = readFileSync("server.js", "utf8");

const expectedTargets = ["top", "services", "work", "process", "packages", "contact"];
const expectedButtons = [
  "Book a Call",
  "Get a video quote",
  "See the video style",
  "Ask for pricing",
  "Start my video",
  "Book a video call",
  "Request my video",
];

test("all in-page link targets exist", () => {
  for (const target of expectedTargets) {
    assert.match(html, new RegExp(`id="${target}"`));
  }

  const hrefTargets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  for (const target of hrefTargets) {
    assert.ok(expectedTargets.includes(target), `Missing expected target for #${target}`);
  }
});

test("all visible button labels are present", () => {
  for (const label of expectedButtons) {
    assert.ok(html.includes(label), `Missing button label: ${label}`);
  }

  assert.ok(html.includes('aria-label="Preview the colorful motion direction"'));
});

test("form and play interactions are wired", () => {
  assert.ok(html.includes('class="form-status"'));
  assert.ok(html.includes('name="name"'));
  assert.ok(html.includes('name="email"'));
  assert.ok(html.includes('name="offer"'));
  assert.ok(script.includes('querySelector(".play-ring")'));
  assert.ok(script.includes('fetch("/api/contact"'));
  assert.ok(script.includes('scrollIntoView({ behavior: "smooth" })'));
  assert.ok(script.includes("Request sent"));
  assert.ok(server.includes("team@dentalmotiongraphic.com"));
});

test("admin dashboard is wired to protected lead commands", () => {
  assert.ok(adminHtml.includes("Dental Motion outreach"));
  assert.ok(adminHtml.includes("fetch sf dental clinics"));
  assert.ok(adminHtml.includes("Video example links"));
  assert.ok(adminScript.includes("dentalMotionVideoUrls"));
  assert.ok(adminScript.includes("researched_total"));
  assert.ok(adminScript.includes("/api/admin/command"));
  assert.ok(adminScript.includes("/api/admin/leads/fetch"));
  assert.ok(adminScript.includes("/api/admin/leads/send-15"));
  assert.ok(adminScript.includes("dentalMotionAdminToken"));
  assert.ok(server.includes('decodedPath === "/admin"'));
});
