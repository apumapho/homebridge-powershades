"use strict";

const {
  normalizeGatewayChannelName,
  parseChannelValues,
  parseGatewayChannelNames,
  parseGatewayJson,
  requestGateway,
} = require("../local-api");
const {
  batteryLevelFromMillivolts,
  normalizePowerSource,
  resolvePowerSource,
} = require("../power-source");

const DEFAULT_TIMEOUT_MS = 5000;

class PluginUiServer {
  constructor() {
    this.handlers = new Map();
    this.onRequest("/discover-gateway", (payload) => this.discoverGateway(payload));

    process.on("message", (request) => {
      if (request?.action === "request") {
        this.processRequest(request);
      }
    });

    this.ready();
  }

  ready() {
    process.send?.({
      action: "ready",
      payload: { server: true },
    });
  }

  onRequest(path, handler) {
    this.handlers.set(path, handler);
  }

  async processRequest(request) {
    const handler = this.handlers.get(request.path);
    if (!handler) {
      this.sendResponse(request, { message: "Not Found", path: request.path }, false);
      return;
    }

    try {
      const data = await handler(request.body || {});
      this.sendResponse(request, data, true);
    } catch (err) {
      this.sendResponse(request, { message: err.message || String(err) }, false);
    }
  }

  sendResponse(request, data, success) {
    process.send?.({
      action: "response",
      payload: {
        requestId: request.requestId,
        success,
        data,
      },
    });
  }

  async discoverGateway(payload) {
    const gateway = payload.gateway || {};
    const host = normalizeHost(payload.host || gateway.host);
    if (!host) {
      throw new Error("Gateway host is required.");
    }

    const timeoutMs = Math.max(Number(payload.timeoutMs || gateway.requestTimeoutMs) || DEFAULT_TIMEOUT_MS, 1000);
    const requestContext = {
      host,
      localAddress: gateway.localAddress,
    };

    const variableNames = ["percent", "battery", "rx", "rfdevs", "chnames1", "chnames2", "chnames3"];
    const [variableResults, metadata] = await Promise.all([
      Promise.allSettled(variableNames.map((variable) => getGatewayVariable(requestContext, variable, timeoutMs))),
      getGatewayMetadata(requestContext, timeoutMs),
    ]);
    const variables = Object.fromEntries(variableNames.map((variable, index) => {
      const result = variableResults[index];
      return [variable, result.status === "fulfilled" ? result.value : ""];
    }));
    const requiredFailures = ["percent", "battery", "rx", "rfdevs"]
      .filter((variable) => !variables[variable]);
    if (requiredFailures.length === 4) {
      throw new Error(`Gateway ${host} did not return status values.`);
    }
    const errors = Object.fromEntries(variableNames
      .map((variable, index) => [variable, variableResults[index]])
      .filter(([, result]) => result.status === "rejected")
      .map(([variable, result]) => [variable, result.reason?.message || String(result.reason)]));
    if (Object.keys(errors).length) {
      metadata.errors = errors;
    }

    const status = {
      percent: parseChannelValues(variables.percent, Number),
      battery: parseChannelValues(variables.battery, Number),
      rx: parseChannelValues(variables.rx, Number),
      rfdevs: parseChannelValues(variables.rfdevs, String),
      names: parseGatewayChannelNames(variables.chnames1, variables.chnames2, variables.chnames3),
    };
    const configuredByChannel = new Map((gateway.shades || [])
      .filter((shade) => shade && shade.channel)
      .map((shade) => [Number(shade.channel), shade]));

    return {
      host,
      serial: gateway.serial,
      metadata,
      channels: buildChannelRows(status, configuredByChannel),
    };
  }
}

function buildChannelRows(status, configuredByChannel) {
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    const channel = index + 1;
    const configured = configuredByChannel.get(channel) || {};
    const discoveredName = normalizeGatewayChannelName(status.names[index], channel);
    const rfDeviceId = status.rfdevs[index] && status.rfdevs[index] !== "0" ? status.rfdevs[index] : null;
    const batteryMillivolts = Number.isFinite(status.battery[index]) && status.battery[index] > 0
      ? status.battery[index]
      : null;
    const currentPosition = Number.isFinite(status.percent[index]) && status.percent[index] >= 0
      ? Math.max(0, Math.min(100, status.percent[index]))
      : null;
    const rx = Number.isFinite(status.rx[index]) && status.rx[index] !== 0
      ? status.rx[index]
      : null;
    const powerSource = normalizePowerSource(configured.powerSource);
    const effectivePowerSource = resolvePowerSource(powerSource, batteryMillivolts);
    const batteryMinMillivolts = normalizeMaybeNumber(configured.batteryMinMillivolts);
    const batteryMaxMillivolts = normalizeMaybeNumber(configured.batteryMaxMillivolts);
    const lowBatteryMillivolts = normalizeMaybeNumber(configured.lowBatteryMillivolts);
    const useful = Boolean(discoveredName || rfDeviceId || batteryMillivolts !== null || currentPosition !== null);
    const hasConfig = Object.keys(configured).length > 0;

    rows.push({
      id: configured.id,
      channel,
      enabled: configured.enabled !== undefined ? configured.enabled !== false : useful,
      useful,
      hasConfig,
      name: configured.name || discoveredName || `Channel ${channel}`,
      discoveredName,
      currentPosition,
      batteryMillivolts,
      batteryLevel: effectivePowerSource === "battery"
        ? batteryLevelFromMillivolts(batteryMillivolts, { minMillivolts: batteryMinMillivolts, maxMillivolts: batteryMaxMillivolts })
        : null,
      rx,
      rfDeviceId,
      powerSource,
      effectivePowerSource,
      assumePosition: configured.assumePosition,
      batteryMinMillivolts,
      batteryMaxMillivolts,
      lowBatteryMillivolts,
    });
  }
  return rows;
}

async function getGatewayVariable(gateway, variable, timeoutMs) {
  const response = await requestGateway(gateway, `var=${encodeURIComponent(variable)}`, timeoutMs);
  const parsed = parseGatewayJson(response);
  if (parsed.length !== 1) {
    throw new Error(`Unexpected ${variable} response length from ${gateway.host}.`);
  }
  return parsed[0];
}

async function getGatewayMetadata(gateway, timeoutMs) {
  try {
    const response = await requestGateway(gateway, "var=version,curfwpg,netsts,rfsts,rssi", timeoutMs);
    const [version, firmwarePage, networkStatus, rfStatus, rssi] = parseGatewayJson(response);
    return {
      version: version || null,
      firmwarePage: firmwarePage || null,
      networkStatus: networkStatus || null,
      rfStatus: rfStatus || null,
      rssi: Number.isFinite(Number(rssi)) ? Number(rssi) : null,
    };
  } catch (err) {
    return {
      error: err.message || String(err),
    };
  }
}

function normalizeHost(host) {
  return String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function normalizeMaybeNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

if (require.main === module) {
  new PluginUiServer();
}

module.exports = {
  PluginUiServer,
  buildChannelRows,
};
