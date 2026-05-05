const tokenInput = document.querySelector("#tokenInput");
const saveTokenButton = document.querySelector("#saveTokenButton");
const clearTokenButton = document.querySelector("#clearTokenButton");
const commandInput = document.querySelector("#commandInput");
const runCommandButton = document.querySelector("#runCommandButton");
const fetchButton = document.querySelector("#fetchButton");
const sendButton = document.querySelector("#sendButton");
const statsButton = document.querySelector("#statsButton");
const output = document.querySelector("#output");
const leadList = document.querySelector("#leadList");
const totalMetric = document.querySelector("#totalMetric");
const pendingMetric = document.querySelector("#pendingMetric");
const sentMetric = document.querySelector("#sentMetric");

const tokenKey = "dentalMotionAdminToken";

function token() {
  return localStorage.getItem(tokenKey) || "";
}

function setBusy(isBusy) {
  for (const button of [runCommandButton, fetchButton, sendButton, statsButton]) {
    button.disabled = isBusy;
  }
}

function show(value) {
  output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderStats(stats = {}) {
  totalMetric.textContent = stats.total ?? "-";
  pendingMetric.textContent = stats.pending_unsent ?? "-";
  sentMetric.textContent = stats.already_sent ?? "-";
}

function renderLeads(leads = []) {
  if (!leads.length) {
    leadList.innerHTML = '<p class="hint">No leads yet. Run fetch sf dental clinics.</p>';
    return;
  }

  leadList.innerHTML = leads
    .map((lead) => {
      const status = lead.last_sent_at ? "Sent" : "Ready";
      const website = lead.website ? `<span>${lead.website}</span>` : "";
      const address = lead.address ? `<span>${lead.address}</span>` : "";

      return `
        <article class="lead">
          <strong>${escapeHtml(lead.clinic || lead.name || lead.email)}</strong>
          <span>${escapeHtml(lead.email)}</span>
          ${website ? escapeHtmlToHtml(website) : ""}
          ${address ? escapeHtmlToHtml(address) : ""}
          <span class="${lead.last_sent_at ? "sent" : ""}">${status}</span>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlToHtml(value) {
  return String(value)
    .replace(/<span>([\s\S]*?)<\/span>/g, (_, text) => `<span>${escapeHtml(text)}</span>`);
}

async function adminRequest(path, options = {}) {
  if (!token()) {
    throw new Error("Paste and save your Railway EMAIL_ADMIN_TOKEN first.");
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();

  if (!response.ok || body.ok === false) {
    throw new Error(body.message || `Request failed with ${response.status}`);
  }

  return body;
}

async function refreshStats() {
  const result = await adminRequest("/api/admin/subscribers");
  renderStats(result.stats);
  renderLeads(result.recent || []);
  return result;
}

async function run(label, action) {
  setBusy(true);
  show(`${label}...`);

  try {
    const result = await action();
    const latestStats = result.leads?.stats || result.stats;
    if (latestStats) {
      renderStats(latestStats);
    }

    if (!result.recent) {
      await refreshStats();
    } else {
      renderLeads(result.recent);
    }

    show(result);
  } catch (error) {
    show(error.message);
  } finally {
    setBusy(false);
  }
}

saveTokenButton.addEventListener("click", () => {
  localStorage.setItem(tokenKey, tokenInput.value.trim());
  tokenInput.value = "";
  show("Token saved in this browser.");
  run("Loading stats", refreshStats);
});

clearTokenButton.addEventListener("click", () => {
  localStorage.removeItem(tokenKey);
  show("Token cleared.");
});

runCommandButton.addEventListener("click", () => {
  const command = commandInput.value.trim();
  run(`Running ${command}`, () =>
    adminRequest("/api/admin/command", {
      method: "POST",
      body: JSON.stringify({ command }),
    })
  );
});

fetchButton.addEventListener("click", () => {
  commandInput.value = "fetch sf dental clinics";
  run("Fetching SF dental clinics", () =>
    adminRequest("/api/admin/leads/fetch", {
      method: "POST",
      body: JSON.stringify({ command: "fetch sf dental clinics" }),
    })
  );
});

sendButton.addEventListener("click", () => {
  commandInput.value = "send 15";
  run("Sending next 15", () =>
    adminRequest("/api/admin/leads/send-15", {
      method: "POST",
      body: JSON.stringify({ limit: 15 }),
    })
  );
});

statsButton.addEventListener("click", () => {
  run("Loading stats", refreshStats);
});

if (token()) {
  run("Loading stats", refreshStats);
}
