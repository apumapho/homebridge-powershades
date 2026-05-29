"use strict";

const POWER_SOURCE_OPTIONS = [
  ["auto", "Auto"],
  ["battery", "Battery"],
  ["hardwired", "Hardwired"],
  ["unknown", "Unknown"],
];

const COLUMN_HELP = {
  Use: "Expose this channel to HomeKit. Disabled rows are saved as hidden when they already have discovery or config data.",
  Ch: "The RF channel number on this local gateway.",
  Name: "The HomeKit accessory name. Discovered gateway names are used as defaults.",
  Position: "Latest percent value reported by the gateway. 0 is closed in HomeKit, 100 is open. Unknown means the gateway did not report a usable value.",
  Voltage: "Latest raw shade power reading from the gateway, shown as volts. Battery shades are usually around 7-8V; hardwired shades are usually around 12V.",
  Power: "Manual power-source override saved to config. Auto infers battery vs hardwired from voltage when possible.",
  Effective: "Power source the plugin will actually use after applying the override or voltage inference. Battery exposes a HomeKit battery service.",
  "RF Device": "Linked RF device ID reported by the gateway. None means the gateway did not report a linked device for this channel.",
  RX: "Latest RF receive signal value reported by the gateway. More negative values generally mean weaker feedback.",
};

let configList = [];
let config = {};
let gateways = [];

if (typeof window !== "undefined" && window.homebridge) {
  window.homebridge.addEventListener("ready", async () => {
    window.homebridge.hideSchemaForm();
    await loadConfig();
    await applyLightingMode();
    bindControls();
    render();
    window.homebridge.hideSpinner();
    if (gateways.length) refreshAllGateways();
  });
}

async function applyLightingMode() {
  let mode = "";
  try {
    mode = await window.homebridge.userCurrentLightingMode();
  } catch (err) {
    mode = window.homebridge.serverEnv?.env?.lightingMode || window.homebridge.serverEnv?.lightingMode || "";
  }
  const normalized = String(mode || "").toLowerCase();
  const isDark = normalized.includes("dark") || normalized.includes("night");
  document.documentElement.dataset.psLightingMode = isDark ? "dark" : "light";
  document.body.classList.toggle("ps-dark-mode", isDark);
}

async function loadConfig() {
  configList = await window.homebridge.getPluginConfig();
  config = configList[0] || { name: "PowerShades", platform: "PowerShades" };
  config.name ||= "PowerShades";
  config.platform ||= "PowerShades";
  config.controlMode ||= "local-udp";
  config.localStatusCacheTTL ||= 30;
  config.localRequestTimeoutMs ||= 5000;
  gateways = (config.localGateways || []).map(prepareGateway);
  syncGlobalControls();
}

function bindControls() {
  document.getElementById("saveConfig").addEventListener("click", saveConfig);
  document.getElementById("refreshAll").addEventListener("click", refreshAllGateways);
  document.getElementById("addGateway").addEventListener("click", addGatewayFromInput);
  document.getElementById("newGatewayHost").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addGatewayFromInput();
  });

  for (const id of ["controlMode", "email", "password", "apiToken", "localStatusCacheTTL", "localRequestTimeoutMs"]) {
    document.getElementById(id).addEventListener("input", syncConfigFromControls);
    document.getElementById(id).addEventListener("change", syncConfigFromControls);
  }
}

function syncGlobalControls() {
  setValue("controlMode", config.controlMode);
  setValue("email", config.email || "");
  setValue("password", config.password || "");
  setValue("apiToken", config.apiToken || "");
  setValue("localStatusCacheTTL", config.localStatusCacheTTL || 30);
  setValue("localRequestTimeoutMs", config.localRequestTimeoutMs || 5000);
}

function syncConfigFromControls() {
  config.controlMode = value("controlMode") || "local-udp";
  config.email = value("email") || undefined;
  config.password = value("password") || undefined;
  config.apiToken = value("apiToken") || undefined;
  config.localStatusCacheTTL = numberValue("localStatusCacheTTL", 30);
  config.localRequestTimeoutMs = numberValue("localRequestTimeoutMs", 5000);
}

function prepareGateway(gateway) {
  return {
    ...gateway,
    host: normalizeHost(gateway.host),
    discoverChannels: gateway.discoverChannels !== false,
    udpTimeoutMs: Number(gateway.udpTimeoutMs) || 1200,
    waitForUdpResponse: gateway.waitForUdpResponse !== false,
    channels: (gateway.shades || []).map((shade) => ({
      ...shade,
      channel: Number(shade.channel),
      enabled: shade.enabled !== false,
      powerSource: shade.powerSource || "auto",
      effectivePowerSource: shade.powerSource && shade.powerSource !== "auto" ? shade.powerSource : "unknown",
      hasConfig: true,
    })),
    metadata: null,
    error: null,
    loading: false,
  };
}

async function addGatewayFromInput() {
  const input = document.getElementById("newGatewayHost");
  const host = normalizeHost(input.value);
  if (!host) return;
  if (gateways.some((gateway) => gateway.host === host)) {
    showMessage(`Gateway ${host} is already configured.`, "error");
    return;
  }
  const gateway = prepareGateway({ host, discoverChannels: true, shades: [] });
  gateways.push(gateway);
  input.value = "";
  render();
  await discoverGateway(gateway);
}

async function refreshAllGateways() {
  for (const gateway of gateways) {
    await discoverGateway(gateway);
  }
}

async function discoverGateway(gateway) {
  gateway.loading = true;
  gateway.error = null;
  render();
  try {
    const result = await window.homebridge.request("/discover-gateway", {
      host: gateway.host,
      gateway: serializeGateway(gateway),
      timeoutMs: config.localRequestTimeoutMs || 5000,
    });
    gateway.metadata = result.metadata;
    gateway.channels = result.channels.map((row) => ({
      ...row,
      powerSource: row.powerSource || "auto",
    }));
    showMessage(`Discovered ${gateway.host}.`, "info");
  } catch (err) {
    gateway.error = err?.message || String(err);
    showMessage(`Discovery failed for ${gateway.host}: ${gateway.error}`, "error");
  } finally {
    gateway.loading = false;
    render();
  }
}

function render() {
  const root = document.getElementById("gateways");
  root.innerHTML = "";

  if (!gateways.length) {
    const empty = document.createElement("div");
    empty.className = "ps-panel ps-empty";
    empty.textContent = "No local gateways configured. Add a gateway host to begin.";
    root.appendChild(empty);
    window.homebridge.fixScrollHeight();
    return;
  }

  gateways.forEach((gateway, gatewayIndex) => {
    root.appendChild(renderGateway(gateway, gatewayIndex));
  });
  window.homebridge.fixScrollHeight();
}

function renderGateway(gateway, gatewayIndex) {
  const panel = document.createElement("section");
  panel.className = "ps-panel";

  const head = document.createElement("div");
  head.className = "ps-gateway-head";
  head.innerHTML = `
    <div>
      <h5>${escapeHtml(gateway.host || "Gateway")}</h5>
      <p>${gateway.loading ? "Discovering..." : gateway.error ? escapeHtml(gateway.error) : "RF Gateway V2"}</p>
    </div>
  `;

  const actions = document.createElement("div");
  actions.className = "ps-actions";
  actions.appendChild(button("Discover", "btn btn-primary", () => discoverGateway(gateway)));
  actions.appendChild(button("Remove", "btn btn-elegant", () => {
    gateways.splice(gatewayIndex, 1);
    render();
  }));
  head.appendChild(actions);
  panel.appendChild(head);

  panel.appendChild(renderGatewayInputs(gateway));
  panel.appendChild(renderGatewayMeta(gateway));
  panel.appendChild(renderChannelTable(gateway));
  return panel;
}

function renderGatewayInputs(gateway) {
  const wrapper = document.createElement("div");
  wrapper.className = "ps-inline";
  wrapper.innerHTML = `
    <label>Host <input class="form-control" data-field="host" value="${escapeAttr(gateway.host || "")}"></label>
    <label>Serial <input class="form-control" data-field="serial" value="${escapeAttr(gateway.serial || "")}"></label>
    <label>UDP timeout <input class="form-control" type="number" min="250" max="10000" data-field="udpTimeoutMs" value="${escapeAttr(gateway.udpTimeoutMs || 1200)}"></label>
  `;
  wrapper.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const field = input.dataset.field;
      gateway[field] = field === "udpTimeoutMs" ? Number(input.value) || 1200 : input.value;
    });
  });
  return wrapper;
}

function renderGatewayMeta(gateway) {
  const meta = document.createElement("div");
  meta.className = "ps-gateway-meta";
  const metadata = gateway.metadata || {};
  const parts = [
    metadata.version ? `Firmware ${metadata.version}` : null,
    metadata.firmwarePage ? `Page ${metadata.firmwarePage}` : null,
    metadata.networkStatus || null,
    metadata.rfStatus ? `RF ${metadata.rfStatus}` : null,
    Number.isFinite(metadata.rssi) ? `RSSI ${metadata.rssi}` : null,
  ].filter(Boolean);
  if (metadata.errors && Object.keys(metadata.errors).length) {
    parts.push("Partial status");
  }
  meta.textContent = parts.length ? parts.join(" / ") : "Not discovered in this session.";
  return meta;
}

function renderChannelTable(gateway) {
  const wrapper = document.createElement("div");
  wrapper.className = "ps-table-wrap";
  const table = document.createElement("table");
  table.className = "table table-sm ps-table";
  table.innerHTML = `
    <thead>
      <tr></tr>
    </thead>
    <tbody></tbody>
  `;
  const header = table.querySelector("thead tr");
  for (const label of Object.keys(COLUMN_HELP)) {
    header.appendChild(renderHeaderCell(label));
  }
  const tbody = table.querySelector("tbody");
  const rows = (gateway.channels || []).slice().sort((a, b) => Number(a.channel) - Number(b.channel));
  for (const row of rows) {
    tbody.appendChild(renderChannelRow(row));
  }
  wrapper.appendChild(table);
  return wrapper;
}

function renderHeaderCell(label) {
  const th = document.createElement("th");
  th.scope = "col";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  th.appendChild(labelNode);
  if (COLUMN_HELP[label]) {
    const help = document.createElement("span");
    help.className = "ps-help";
    help.textContent = "?";
    help.dataset.tooltip = COLUMN_HELP[label];
    help.setAttribute("aria-label", COLUMN_HELP[label]);
    help.tabIndex = 0;
    help.addEventListener("mouseenter", () => showTooltip(help, COLUMN_HELP[label]));
    help.addEventListener("focus", () => showTooltip(help, COLUMN_HELP[label]));
    help.addEventListener("mouseleave", hideTooltip);
    help.addEventListener("blur", hideTooltip);
    th.appendChild(help);
  }
  return th;
}

function showTooltip(anchor, message) {
  hideTooltip();
  const tip = document.createElement("div");
  tip.className = "ps-tooltip";
  tip.textContent = message;
  document.body.appendChild(tip);

  const rect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.left + (rect.width / 2) - (tipRect.width / 2), window.innerWidth - tipRect.width - margin));
  const top = rect.bottom + margin;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTooltip() {
  document.querySelectorAll(".ps-tooltip").forEach((node) => node.remove());
}

function renderChannelRow(row) {
  const tr = document.createElement("tr");
  tr.className = row.useful || row.hasConfig ? "" : "ps-muted";

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = row.enabled !== false;
  enabled.addEventListener("change", () => {
    row.enabled = enabled.checked;
  });

  const name = document.createElement("input");
  name.type = "text";
  name.className = "form-control";
  name.value = row.name || `Channel ${row.channel}`;
  name.addEventListener("input", () => {
    row.name = name.value;
  });

  const power = document.createElement("select");
  power.className = "form-control";
  for (const [value, label] of POWER_SOURCE_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = (row.powerSource || "auto") === value;
    power.appendChild(option);
  }
  power.addEventListener("change", () => {
    row.powerSource = power.value;
  });

  appendCell(tr, enabled);
  appendCell(tr, text(row.channel, "ps-number"));
  appendCell(tr, name);
  appendCell(tr, text(row.currentPosition === null || row.currentPosition === undefined ? "Unknown" : `${row.currentPosition}%`, "ps-number"));
  appendCell(tr, text(row.batteryMillivolts ? `${(row.batteryMillivolts / 1000).toFixed(2)}V` : "Unknown", "ps-number"));
  appendCell(tr, power);
  appendCell(tr, text(row.effectivePowerSource || "unknown"));
  appendCell(tr, text(row.rfDeviceId || "None", "ps-number"));
  appendCell(tr, text(row.rx === null || row.rx === undefined ? "Unknown" : row.rx, "ps-number"));

  return tr;
}

async function saveConfig() {
  syncConfigFromControls();
  config.localGateways = gateways.map(serializeGateway);
  configList[0] = config;
  try {
    await window.homebridge.updatePluginConfig(configList);
    await window.homebridge.savePluginConfig();
    window.homebridge.toast.success("PowerShades configuration saved.", "PowerShades");
  } catch (err) {
    showMessage(`Save failed: ${err?.message || err}`, "error");
  }
}

function serializeGateway(gateway) {
  const output = {
    host: normalizeHost(gateway.host),
    discoverChannels: gateway.discoverChannels !== false,
    udpTimeoutMs: Number(gateway.udpTimeoutMs) || 1200,
    waitForUdpResponse: gateway.waitForUdpResponse !== false,
    shades: serializeShades(gateway.channels || []),
  };
  if (gateway.serial) output.serial = gateway.serial;
  if (gateway.localAddress) output.localAddress = gateway.localAddress;
  if (gateway.udpPort) output.udpPort = Number(gateway.udpPort);
  if (gateway.localUdpPort) output.localUdpPort = Number(gateway.localUdpPort);
  const includeChannels = normalizeChannelList(gateway.includeChannels);
  const excludeChannels = normalizeChannelList(gateway.excludeChannels);
  if (includeChannels.length) output.includeChannels = includeChannels;
  if (excludeChannels.length) output.excludeChannels = excludeChannels;
  return output;
}

function serializeShades(channels) {
  return channels
    .filter((row) => shouldPersistRow(row))
    .map((row) => {
      const shade = {
        channel: Number(row.channel),
        name: row.name || `Channel ${row.channel}`,
      };
      if (row.id !== undefined) shade.id = row.id;
      if (row.enabled === false) shade.enabled = false;
      if (row.powerSource && row.powerSource !== "auto") shade.powerSource = row.powerSource;
      if (row.assumePosition !== undefined && row.assumePosition !== "") shade.assumePosition = Number(row.assumePosition);
      for (const key of ["batteryMinMillivolts", "batteryMaxMillivolts", "lowBatteryMillivolts"]) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== "") shade[key] = Number(row[key]);
      }
      return shade;
    });
}

function shouldPersistRow(row) {
  if (!row || !row.channel) return false;
  if (row.enabled !== false) return true;
  return row.hasConfig || row.useful;
}

function showMessage(message, type = "info") {
  const root = document.getElementById("messages");
  const item = document.createElement("div");
  item.className = `ps-message ${type}`;
  item.textContent = message;
  root.appendChild(item);
  setTimeout(() => item.remove(), 7000);
}

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function appendCell(row, child) {
  const td = document.createElement("td");
  td.appendChild(child);
  row.appendChild(td);
}

function text(value, className = "") {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = String(value);
  return span;
}

function setValue(id, inputValue) {
  document.getElementById(id).value = inputValue;
}

function value(id) {
  return document.getElementById(id).value.trim();
}

function numberValue(id, fallback) {
  const number = Number(value(id));
  return Number.isFinite(number) ? number : fallback;
}

function normalizeHost(host) {
  return String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function normalizeChannelList(channels) {
  if (!Array.isArray(channels)) return [];
  return channels
    .map(Number)
    .filter((channel) => Number.isInteger(channel) && channel >= 1 && channel <= 30);
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeChannelList,
    normalizeHost,
    serializeGateway,
    serializeShades,
    shouldPersistRow,
  };
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(input) {
  return escapeHtml(input).replace(/'/g, "&#39;");
}
