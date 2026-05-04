const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const html = readFileSync("index.html", "utf8");
const script = readFileSync("script.js", "utf8");

const expectedTargets = ["top", "services", "work", "process", "packages", "contact"];
const expectedButtons = [
  "Book a Private Call",
  "Request a custom concept",
  "See the luxury direction",
  "Ask for pricing",
  "Build my luxury package",
  "Book a strategy call",
  "Request my luxury concept",
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

  assert.ok(html.includes('aria-label="Preview the luxury motion direction"'));
});

test("form and play interactions are wired", () => {
  assert.ok(html.includes('class="form-status"'));
  assert.ok(script.includes('querySelector(".play-ring")'));
  assert.ok(script.includes('scrollIntoView({ behavior: "smooth" })'));
  assert.ok(script.includes("Request received"));
});
