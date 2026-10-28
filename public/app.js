"use strict";

const POLL_INTERVAL_MS = 5000;
const KEY_STORAGE = "sentinelpay.operatorKey";
let permissions = new Set();
const can = (permission) => permissions.has(permission);

const STATUS_TONE = {
  COMPLETED: "ok",
  CAPTURE_PENDING: "warn",
  PENDING_APPROVAL: "warn",
  CAPTURING: "warn",
  RECONCILE_REQUIRED: "bad",
  PROCESSING: "",
  EXPIRED: "",
  CANCELLED: "",
  REFUNDED: "",
  BLOCKED: "bad",
  DECLINED: "bad",
  FAILED: "bad",
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Session + API
// ---------------------------------------------------------------------------

function getKey() {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function setKey(key) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage unavailable: the key lives only in memory for this page
  }
  memoryKey = key;
}

let memoryKey = getKey();

async function api(method, path, body, token = memoryKey) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token === memoryKey) signOut("Session rejected by the server. Sign in again.");
  return { ok: res.ok, status: res.status, body: data };
}

// ---------------------------------------------------------------------------
// Rendering helpers (DOM nodes + textContent only: never innerHTML with data)
// ---------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function badge(text, tone) {
  return el("span", { className: `badge ${tone ?? ""}`, textContent: text });
}

/** Only link out to PayPal-hosted approval pages. */
function isPayPalUrl(href) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

function detailText(tx) {
  if (tx.violations && tx.violations.length > 0) return tx.violations.map((v) => `${v.code}: ${v.message}`).join("; ");
  if (tx.error) return tx.error.debugId ? `${tx.error.message} [debug ${tx.error.debugId}]` : tx.error.message;
  return tx.message;
}

function setStatus(text) {
  $("status-line").textContent = text;
}

function button(label, className, onClick) {
  const b = el("button", { type: "button", className: `btn ${className}`, textContent: label });
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function capture(orderId) {
  const { status, body } = await api("POST", `/api/admin/orders/${encodeURIComponent(orderId)}/capture`);
  if (body.success === false && body.code === "ORDER_NOT_APPROVED") {
    setStatus(`Order ${orderId} is not approved yet. Use "Approve Sandbox Order" first, then capture.`);
  } else if (body.transaction) {
    setStatus(`Order ${orderId}: ${body.transaction.status}, ${detailText(body.transaction)}`);
  } else {
    setStatus(`Capture failed (${status}): ${body.message ?? body.error ?? "unknown error"}`);
  }
  await refreshAll();
}

async function cancelTx(tx) {
  const reason = window.prompt(`Cancel transaction ${tx.transactionId}? Reason:`, "Cancelled by operator");
  if (!reason) return;
  const { status, body } = await api("POST", `/api/admin/transactions/${tx.transactionId}/cancel`, { reason });
  setStatus(status === 200 ? `Cancelled; budget released.` : `Cancel failed: ${body.message ?? body.error}`);
  await refreshAll();
}

async function reconcileTx(tx) {
  let payload = {};
  if (!tx.orderId) {
    const choice = window.prompt(
      "No PayPal order id was recorded. Check the PayPal dashboard first.\nType RETRY_CREATE to resend the original request, or MARK_FAILED to release the budget:",
      "",
    );
    if (choice !== "RETRY_CREATE" && choice !== "MARK_FAILED") return;
    payload = { resolution: choice };
  }
  const { status, body } = await api("POST", `/api/admin/transactions/${tx.transactionId}/reconcile`, payload);
  setStatus(status === 200 ? `Reconciled: ${body.status}` : `Reconcile failed: ${body.message ?? body.error}`);
  await refreshAll();
}

async function setFrozen(agent, frozen) {
  let result;
  if (frozen) {
    const reason = window.prompt(`Freeze agent ${agent.agentId}? Reason:`, "Suspicious activity");
    if (!reason) return;
    result = await api("POST", `/api/admin/agents/${encodeURIComponent(agent.agentId)}/freeze`, { reason });
  } else {
    result = await api("POST", `/api/admin/agents/${encodeURIComponent(agent.agentId)}/unfreeze`);
  }
  // Reflect what the server persisted, not what was clicked.
  setStatus(result.ok ? `Agent ${agent.agentId} is now ${result.body.frozen ? "FROZEN" : "active"} (server-enforced).` : `Failed: ${result.body.message ?? result.body.error}`);
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

function txActions(params) {
  const tx = params.data;
  const wrap = el("div", { className: "actions" });
  if (!can("payments:operate")) return wrap;
  if (tx.status === "PENDING_APPROVAL") {
    if (tx.approvalUrl && isPayPalUrl(tx.approvalUrl)) {
      wrap.append(
        el("a", { className: "btn btn-approve", href: tx.approvalUrl, target: "_blank", rel: "noopener noreferrer", textContent: "Approve Sandbox Order" }),
      );
    }
    wrap.append(button("Capture", "btn-primary", () => capture(tx.orderId)));
    wrap.append(button("Cancel", "btn-ghost", () => cancelTx(tx)));
  } else if (tx.status === "RECONCILE_REQUIRED") {
    wrap.append(button("Reconcile", "btn-primary", () => reconcileTx(tx)));
    wrap.append(button("Cancel", "btn-ghost", () => cancelTx(tx)));
  }
  return wrap;
}

const txGrid = agGrid.createGrid($("tx-grid"), {
  rowData: [],
  getRowId: (p) => p.data.transactionId,
  defaultColDef: { sortable: true, resizable: true, filter: true },
  tooltipShowDelay: 300,
  columnDefs: [
    { headerName: "Created", field: "createdAt", width: 170, sort: "desc", valueFormatter: (p) => new Date(p.value).toLocaleString() },
    { headerName: "Agent", field: "agentId", width: 130 },
    { headerName: "Merchant", field: "merchantId", width: 130 },
    { headerName: "Category", field: "category", width: 120 },
    { headerName: "Description", field: "description", flex: 1, minWidth: 160 },
    { headerName: "Amount", field: "amount", width: 100, type: "rightAligned", comparator: (a, b) => Number(a) - Number(b), valueFormatter: (p) => `$${p.value}` },
    { headerName: "Status", field: "status", width: 180, cellRenderer: (p) => badge(p.value.replace(/_/g, " "), STATUS_TONE[p.value]) },
    { headerName: "Budget", field: "budgetState", width: 110 },
    { headerName: "Mode", field: "mode", width: 120, valueFormatter: (p) => p.value ?? "—" },
    // Wide enough for full 17-character PayPal ids, so they can be checked against PayPal.
    { headerName: "Order ID", field: "orderId", width: 200, valueFormatter: (p) => p.value ?? "—" },
    { headerName: "Capture ID", field: "captureId", width: 200, valueFormatter: (p) => p.value ?? "—" },
    { headerName: "Currency", field: "currency", width: 90 },
    { headerName: "Details / violations", colId: "details", flex: 1, minWidth: 240, valueGetter: (p) => detailText(p.data), tooltipValueGetter: (p) => detailText(p.data) },
    { headerName: "Actions", colId: "actions", width: 300, pinned: "right", sortable: false, filter: false, cellRenderer: txActions },
  ],
});

const agentGrid = agGrid.createGrid($("agent-grid"), {
  rowData: [],
  getRowId: (p) => p.data.agentId,
  defaultColDef: { sortable: true, resizable: true },
  columnDefs: [
    { headerName: "Agent", field: "agentId", width: 150 },
    { headerName: "Name", field: "displayName", width: 160 },
    { headerName: "Key prefix", field: "apiKeyPrefix", width: 140 },
    { headerName: "Per-tx cap", field: "perTransactionCap", width: 110, valueFormatter: (p) => `$${p.value}` },
    { headerName: "Daily cap", field: "dailyCap", width: 110, valueFormatter: (p) => `$${p.value}` },
    { headerName: "Autonomous ≤", field: "autonomousLimit", width: 130, valueFormatter: (p) => (Number(p.value) > 0 ? `$${p.value}` : "always ask") },
    { headerName: "Merchants", field: "allowedMerchants", flex: 1, minWidth: 140, valueFormatter: (p) => (p.value === null ? "any" : p.value.join(", ") || "none") },
    { headerName: "Categories", field: "allowedCategories", flex: 1, minWidth: 140, valueFormatter: (p) => (p.value === null ? "any" : p.value.join(", ") || "none") },
    {
      headerName: "State",
      field: "frozen",
      width: 220,
      cellRenderer: (p) => badge(p.value ? `FROZEN${p.data.frozenReason ? `: ${p.data.frozenReason}` : ""}` : "ACTIVE", p.value ? "bad" : "ok"),
    },
    {
      headerName: "Control",
      colId: "control",
      width: 130,
      pinned: "right",
      sortable: false,
      cellRenderer: (p) =>
        el(
          "div",
          { className: "actions" },
          p.data.frozen
            ? can("agents:unfreeze") ? [button("Unfreeze", "btn-ghost", () => setFrozen(p.data, false))] : []
            : can("agents:freeze") ? [button("Freeze", "btn-danger", () => setFrozen(p.data, true))] : [],
        ),
    },
  ],
});

const auditGrid = agGrid.createGrid($("audit-grid"), {
  rowData: [],
  getRowId: (p) => String(p.data.seq),
  defaultColDef: { sortable: true, resizable: true, filter: true },
  columnDefs: [
    { headerName: "#", field: "seq", width: 80, sort: "desc" },
    { headerName: "Time", field: "occurredAt", width: 170, valueFormatter: (p) => new Date(p.value).toLocaleString() },
    { headerName: "Actor", colId: "actor", width: 160, valueGetter: (p) => `${p.data.actorType}:${p.data.actorId}` },
    { headerName: "Action", field: "action", width: 220 },
    { headerName: "Agent", field: "agentId", width: 130 },
    { headerName: "Details", colId: "details", flex: 1, minWidth: 200, valueGetter: (p) => JSON.stringify(p.data.details) },
    { headerName: "Hash", field: "hash", width: 140, valueFormatter: (p) => `${p.value.slice(0, 12)}…` },
  ],
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refreshAll() {
  if (!memoryKey) return;
  const status = $("status-filter").value;
  const [tx, agents, audit] = await Promise.all([
    api("GET", `/api/admin/transactions${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    api("GET", "/api/admin/agents"),
    can("audit:read") ? api("GET", "/api/admin/audit?limit=200") : Promise.resolve({ ok: false }),
  ]);
  if (tx.ok) {
    const s = tx.body.summary;
    $("mode-badge").textContent = s.executionMode === "AUTONOMOUS" ? "Vault configured (per-agent limits)" : "Interactive (buyer approval)";
    $("mode-badge").className = `badge ${s.executionMode === "AUTONOMOUS" ? "ok" : "warn"}`;
    $("mode-badge").hidden = false;
    $("stat-per-tx").textContent = `$${s.globalPerTransactionCap}`;
    $("stat-daily").textContent = `$${s.globalDailyCap}`;
    $("stat-committed").textContent = `$${s.committedToday}`;
    $("stat-reserved").textContent = `$${s.reservedToday}`;
    $("stat-remaining").textContent = `$${s.remainingToday}`;
    txGrid.setGridOption("rowData", tx.body.transactions);
  }
  if (agents.ok) {
    agentGrid.setGridOption("rowData", agents.body.agents);
    populateAssistantAgents(agents.body.agents);
  }
  if (audit.ok) auditGrid.setGridOption("rowData", audit.body.events);
}

// ---------------------------------------------------------------------------
// AI assistant (server-side Gemini; this page only sends text and renders results)
// ---------------------------------------------------------------------------

let conversationId = null;

function decisionTone(decision) {
  if (decision === "COMPLETED") return "ok";
  if (decision === "PENDING_APPROVAL" || decision === "CAPTURE_PENDING") return "warn";
  return "bad";
}

function logMessage(kind, meta, children) {
  const node = el("div", { className: `msg msg-${kind}` }, [el("span", { className: "msg-meta", textContent: meta }), ...children]);
  $("assistant-log").append(node);
  node.scrollIntoView({ block: "nearest" });
  return node;
}

function renderToolCall(call) {
  const r = call.result ?? {};
  if (call.tool === "get_spending_policy") {
    return el("div", {
      className: "decision",
      textContent: `Checked policy: per-transaction $${r.perTransactionCap}, daily $${r.dailyCap}, autonomous ≤ $${r.autonomousLimit}, merchants ${r.allowedMerchants === null ? "any" : (r.allowedMerchants ?? []).join(", ")}`,
    });
  }
  if (call.tool !== "submit_purchase_intent") return null;
  const a = call.args ?? {};
  if (r.error === "SUBMISSION_LIMIT") return el("div", { className: "decision bad", textContent: `Not submitted: ${r.message}` });
  const box = el("div", { className: `decision ${decisionTone(r.decision)}` });
  box.append(el("div", { textContent: `Model's intent: ${a.merchantId} / ${a.category} / $${a.amountUsd}: ${a.description}` }));
  box.append(
    el("div", {}, [
      document.createTextNode("SentinelPay: "),
      badge(String(r.decision ?? "ERROR").replace(/_/g, " "), STATUS_TONE[r.decision]),
      document.createTextNode(
        ` HTTP ${r.httpStatus}${r.mode ? ` · ${r.mode}` : ""}${r.orderId ? ` · PayPal order ${r.orderId}` : ""}${r.captureId ? ` · capture ${r.captureId}` : ""}`,
      ),
    ]),
  );
  for (const v of r.violations ?? []) box.append(el("div", { textContent: `✗ ${v.code}: ${v.message}` }));
  if (r.validationIssues) box.append(el("div", { textContent: `✗ Invalid intent, rejected before policy: ${JSON.stringify(r.validationIssues)}` }));
  if (r.approvalRequired) box.append(el("div", { textContent: "Needs buyer approval: use Approve Sandbox Order in the Transactions grid, then Capture." }));
  return box;
}

function paymentSummary(reply) {
  if (reply.intentsSubmitted === 0) return "No payment was made.";
  const parts = [];
  if (reply.paymentsCaptured) parts.push(`${reply.paymentsCaptured} payment(s) captured`);
  if (reply.awaitingApproval) parts.push(`${reply.awaitingApproval} awaiting buyer approval (no money moved yet)`);
  const blocked = reply.intentsSubmitted - reply.paymentsCaptured - reply.awaitingApproval;
  if (blocked) parts.push(`${blocked} not paid (blocked or failed)`);
  return `${parts.join("; ")}.`;
}

function resetConversation() {
  conversationId = null;
  $("assistant-log").replaceChildren();
}

async function sendAssistantMessage(event) {
  event.preventDefault();
  const message = $("assistant-input").value.trim();
  const agentId = $("assistant-agent").value;
  if (!message || !agentId) return;
  const send = $("assistant-send");
  send.disabled = true;
  logMessage("user", `You → ${agentId}`, [document.createTextNode(message)]);
  $("assistant-input").value = "";
  const thinking = logMessage("agent", "Agent", [document.createTextNode("Thinking…")]);
  try {
    const { ok, body } = await api("POST", "/api/admin/assistant/messages", { agentId, message, ...(conversationId ? { conversationId } : {}) });
    thinking.remove();
    if (!ok && !body.status) {
      logMessage("error", "Assistant", [document.createTextNode(`${body.message ?? body.error ?? "Request failed"}. No payment was made.`)]);
      if (body.error === "CONVERSATION_NOT_FOUND" || body.error === "CONVERSATION_LIMIT") resetConversation();
      return;
    }
    conversationId = body.status === "MODEL_ERROR" ? null : body.conversationId;
    const steps = (body.toolCalls ?? []).map(renderToolCall).filter(Boolean);
    if (body.status === "QUESTION") {
      logMessage("question", `Agent asks (${body.model})`, [...steps, document.createTextNode(body.text)]);
    } else if (body.status === "MODEL_ERROR") {
      logMessage("error", `Agent (${body.model})`, [...steps, document.createTextNode(`${body.text} ${body.error?.message ?? ""}\n${paymentSummary(body)}`)]);
    } else {
      logMessage("agent", `Agent (${body.model})`, [...steps, document.createTextNode(`${body.text}\n\n${paymentSummary(body)}`)]);
    }
  } catch (error) {
    thinking.remove();
    logMessage("error", "Assistant", [document.createTextNode(`Request failed: ${error.message}`)]);
  } finally {
    send.disabled = false;
    await refreshAll();
  }
}

function populateAssistantAgents(agents) {
  const select = $("assistant-agent");
  const current = select.value;
  select.replaceChildren(
    ...agents.map((a) => el("option", { value: a.agentId, textContent: `${a.agentId}${a.frozen ? " (frozen)" : ""}` })),
  );
  if (agents.some((a) => a.agentId === current)) select.value = current;
}

async function initAssistant() {
  $("assistant-panel").hidden = !can("assistant:use");
  if (!can("assistant:use")) return;
  const { ok, body } = await api("GET", "/api/admin/assistant/status");
  const available = ok && body.available;
  $("assistant-model").textContent = available ? `Gemini · ${body.model}` : "AI unavailable (GEMINI_API_KEY not set)";
  $("assistant-model").className = `badge ${available ? "ok" : "bad"}`;
  $("assistant-send").disabled = !available;
}

$("assistant-form").addEventListener("submit", sendAssistantMessage);
$("assistant-reset").addEventListener("click", resetConversation);
$("assistant-agent").addEventListener("change", resetConversation);

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

let poller = null;

function showConsole(visible) {
  $("console").hidden = !visible;
  $("login-panel").hidden = visible;
  $("logout").hidden = !visible;
  if (!visible) {
    $("mode-badge").hidden = true;
    $("whoami").hidden = true;
  }
}

function signOut(message) {
  setKey(null);
  if (poller) clearInterval(poller);
  poller = null;
  showConsole(false);
  $("login-result").textContent = message ?? "";
}

async function signIn(key) {
  const probe = await api("GET", "/api/admin/me", undefined, key);
  if (!probe.ok) {
    $("login-result").textContent = probe.status === 429 ? "Too many attempts; wait a minute." : "Key rejected.";
    return false;
  }
  setKey(key);
  permissions = new Set(probe.body.permissions);
  $("whoami").textContent = `${probe.body.operatorId} · ${probe.body.role}`;
  $("whoami").hidden = false;
  $("audit-panel").hidden = !can("audit:read");
  $("create-agent").hidden = !can("agents:manage");
  await initAssistant();
  showConsole(true);
  await refreshAll();
  if (!poller) poller = setInterval(refreshAll, POLL_INTERVAL_MS);
  return true;
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.key;
  if (await signIn(input.value.trim())) input.value = "";
});
$("logout").addEventListener("click", () => signOut("Signed out."));
$("refresh").addEventListener("click", refreshAll);
$("status-filter").addEventListener("change", refreshAll);

$("verify-chain").addEventListener("click", async () => {
  const { ok, body } = await api("GET", "/api/admin/audit/verify");
  if (!ok) return;
  const cp = body.checkpoints ?? { configured: false, problems: [] };
  $("chain-status").textContent = body.valid
    ? `Verified: ${body.eventsChecked} events${cp.configured ? `, ${cp.checked} signed checkpoint(s)` : ", checkpoints not configured"}`
    : `TAMPERING DETECTED`;
  $("chain-status").className = `badge ${body.valid ? (cp.configured ? "ok" : "warn") : "bad"}`;
  $("chain-head").textContent = body.valid
    ? `Head #${body.headSeq ?? "–"}: ${body.headHash ?? "(empty)"}${cp.latestSeq !== null && cp.latestSeq !== undefined ? ` · last checkpoint #${cp.latestSeq}` : ""}`
    : [body.chain?.reason, ...(cp.problems ?? [])].filter(Boolean).join(" · ");
});

const csv = (value) => {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
};

$("agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const { status, body } = await api("POST", "/api/admin/agents", {
    agentId: data.get("agentId"),
    displayName: data.get("displayName"),
    perTransactionCap: data.get("perTransactionCap"),
    dailyCap: data.get("dailyCap"),
    autonomousLimit: data.get("autonomousLimit"),
    allowedMerchants: csv(String(data.get("allowedMerchants") ?? "")),
    allowedCategories: csv(String(data.get("allowedCategories") ?? "")),
  });
  if (status === 201) {
    $("new-key-value").textContent = body.apiKey;
    $("new-key").hidden = false;
    setStatus(`Agent ${body.agent.agentId} created. Copy its key now; it will not be shown again.`);
    event.currentTarget.reset();
  } else {
    setStatus(`Create failed: ${body.message ?? JSON.stringify(body.issues ?? body.error)}`);
  }
  await refreshAll();
});

$("simulate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const { status, body } = await api(
    "POST",
    "/api/agent/transactions",
    {
      requestId: `console-${crypto.randomUUID()}`,
      merchantId: data.get("merchantId"),
      category: data.get("category"),
      description: data.get("description"),
      amount: data.get("amount"),
    },
    String(data.get("agentKey")),
  );
  setStatus(status === 400 ? `Invalid request: ${JSON.stringify(body.issues)}` : `${status} ${body.status ?? body.error}: ${body.transactionId ? detailText(body) : (body.message ?? "")}`);
  await refreshAll();
});

/** PayPal redirects back with ?approval=returned&token=<orderId>&PayerID=… after buyer approval. */
function handleApprovalReturn() {
  const params = new URLSearchParams(window.location.search);
  const approval = params.get("approval");
  const orderId = params.get("token");
  history.replaceState(null, "", window.location.pathname);
  if (!approval || !orderId || !/^[A-Z0-9]{1,36}$/i.test(orderId)) return;

  const banner = $("approval-banner");
  const captureBtn = $("approval-banner-capture");
  if (approval === "returned") {
    $("approval-banner-text").textContent = `Sandbox order ${orderId} was approved by the buyer. Capture it to complete the payment.`;
    captureBtn.hidden = false;
    captureBtn.onclick = async () => {
      captureBtn.disabled = true;
      await capture(orderId);
      banner.hidden = true;
    };
  } else {
    $("approval-banner-text").textContent = `Buyer cancelled approval for sandbox order ${orderId}. Cancel the transaction to release its budget.`;
  }
  banner.hidden = false;
  $("approval-banner-dismiss").onclick = () => (banner.hidden = true);
}

handleApprovalReturn();
if (memoryKey) signIn(memoryKey).catch(() => signOut());
else showConsole(false);
