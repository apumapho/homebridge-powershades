// Local-only PowerShades RF Gateway V2 client.

const http = require("http");
const {
  DEFAULT_UDP_PORT,
  buildCommandPacket,
  buildSetPositionPacket,
  sendUdpPacket,
} = require("./local-udp-protocol");

class LocalPowerShadesApiError extends Error {}

class LocalPowerShadesApi {
  constructor({
    gateways = [],
    logger = console,
    requestTimeoutMs = 5000,
    statusCacheTTL = 30000,
    requestFn,
    sendUdpFn,
  } = {}) {
    this.logger = logger;
    this.requestTimeoutMs = Math.max(Number(requestTimeoutMs) || 5000, 1000);
    this.statusCacheTTL = Math.max(Number(statusCacheTTL) || 30000, 1000);
    this.requestFn = requestFn || ((gateway, query) => requestGateway(gateway, query, this.requestTimeoutMs));
    this.sendUdpFn = sendUdpFn || sendUdpPacket;
    this.gatewayQueues = new Map();
    this.stateById = new Map();
    this.gateways = normalizeGateways(gateways);
    this.shades = flattenShades(this.gateways);

    for (const shade of this.shades) {
      this.ensureShadeState(shade);
    }

    this.logger.info?.(`[PowerShades] Using local RF gateway UDP control for ${this.gateways.length} gateway(s)`);
  }

  async getShades() {
    await this.refreshShadeStates();
    this.refreshDiscoveredShades();
    for (const gateway of this.gateways) {
      if (gateway.lastStatus) this.applyGatewayStatus(gateway, gateway.lastStatus);
    }
    return this.shades.map((shade) => this.decorateShade(shade));
  }

  async getGroups() {
    return [];
  }

  async moveGroup() {
    throw new LocalPowerShadesApiError("Groups are not supported in local control mode");
  }

  async moveShade(shadeOrName, percentage) {
    const shade = this.findShade(shadeOrName);
    if (!shade) {
      throw new LocalPowerShadesApiError(`Unknown local shade: ${typeof shadeOrName === "string" ? shadeOrName : shadeOrName?.name}`);
    }

    const target = clampPosition(percentage);
    const state = this.getState(shade);

    this.logger.info?.(`[PowerShades] Local UDP move "${shade.name}" channel ${shade.channel} to ${target}%`);
    await this.sendSetPosition(shade.gateway, shade.channel, target);
    state.current_position = target;
    state.target_position = target;
    state.moving = false;
    state.direction = null;
    state.lastUpdated = Date.now();
    shade.gateway.lastStatusRefresh = 0;
  }

  async stopShade(shadeOrName) {
    const shade = this.findShade(shadeOrName);
    if (!shade) return;
    await this.sendCommand(shade.gateway, "stop", shade.channel);
    const state = this.getState(shade);
    state.moving = false;
    state.direction = null;
  }

  isShadeMoving(shadeOrName) {
    const shade = this.findShade(shadeOrName);
    if (!shade) return false;
    return Boolean(this.getState(shade).moving);
  }

  getShadeDirection(shadeOrName) {
    const shade = this.findShade(shadeOrName);
    if (!shade) return null;
    return this.getState(shade).direction;
  }

  async refreshShadeStates() {
    const now = Date.now();
    const gatewaysToRefresh = this.gateways.filter((gateway) => {
      return !gateway.lastStatusRefresh || (now - gateway.lastStatusRefresh) >= this.statusCacheTTL;
    });

    for (const gateway of gatewaysToRefresh) {
      try {
        const status = await this.getGatewayStatus(gateway);
        gateway.lastStatusRefresh = Date.now();
        this.applyGatewayStatus(gateway, status);
      } catch (err) {
        this.logger.warn?.(`[PowerShades] Local status refresh failed for ${gateway.host}: ${err.message || err}`);
      }
    }
  }

  async getGatewayStatus(gateway) {
    const [percent, battery, rx, rfdevs] = await Promise.all([
      this.getGatewayVariable(gateway, "percent"),
      this.getGatewayVariable(gateway, "battery"),
      this.getGatewayVariable(gateway, "rx"),
      this.getGatewayVariable(gateway, "rfdevs"),
    ]);
    const names = gateway.discoverChannels
      ? await this.getGatewayChannelNames(gateway)
      : [];

    return {
      percent: parseChannelValues(percent, Number),
      battery: parseChannelValues(battery, Number),
      rx: parseChannelValues(rx, Number),
      rfdevs: parseChannelValues(rfdevs, String),
      names,
    };
  }

  async getGatewayChannelNames(gateway) {
    const [chnames1, chnames2, chnames3] = await Promise.all([
      this.getGatewayVariable(gateway, "chnames1"),
      this.getGatewayVariable(gateway, "chnames2"),
      this.getGatewayVariable(gateway, "chnames3"),
    ]);
    return parseGatewayChannelNames(chnames1, chnames2, chnames3);
  }

  async getGatewayVariable(gateway, variable) {
    const data = await this.enqueue(gateway, () => this.requestFn(gateway, `var=${encodeURIComponent(variable)}`));
    const parsed = parseGatewayJson(data);
    if (parsed.length !== 1) {
      throw new LocalPowerShadesApiError(`Unexpected ${variable} response length from ${gateway.host}`);
    }
    return parsed[0];
  }

  async sendCommand(gateway, command, channel) {
    const ch = Number(channel);
    if (!Number.isInteger(ch) || ch < 1 || ch > 30) {
      throw new LocalPowerShadesApiError(`Invalid local RF channel: ${channel}`);
    }

    const packet = buildCommandPacket({ command, channel: ch });
    await this.enqueue(gateway, () => this.sendUdp(gateway, packet));
  }

  async sendSetPosition(gateway, channel, percent) {
    const packet = buildSetPositionPacket({ channel, percent });
    await this.enqueue(gateway, () => this.sendUdp(gateway, packet));
  }

  async sendUdp(gateway, packet) {
    return this.sendUdpFn({
      host: gateway.host,
      packet,
      port: gateway.udpPort,
      localPort: gateway.localUdpPort,
      timeoutMs: gateway.udpTimeoutMs,
      waitForResponse: gateway.waitForUdpResponse,
    });
  }

  async enqueue(gateway, task) {
    const key = gateway.id;
    const previous = this.gatewayQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.gatewayQueues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.gatewayQueues.get(key) === next) {
        this.gatewayQueues.delete(key);
      }
    }
  }

  applyGatewayStatus(gateway, status) {
    gateway.lastStatus = status;
    for (const shade of this.shades.filter((s) => s.gateway.id === gateway.id)) {
      const idx = shade.channel - 1;
      const state = this.getState(shade);
      const percent = status.percent[idx];
      const battery = status.battery[idx];
      const rx = status.rx[idx];
      const rfDeviceId = status.rfdevs[idx];

      if (Number.isFinite(percent) && percent >= 0) {
        state.current_position = clampPosition(percent);
        if (!state.moving) {
          state.target_position = state.current_position;
        }
      }
      state.batteryMillivolts = Number.isFinite(battery) && battery > 0 ? battery : null;
      state.rx = Number.isFinite(rx) && rx !== 0 ? rx : null;
      state.rfDeviceId = rfDeviceId && rfDeviceId !== "0" ? rfDeviceId : null;
      state.lastUpdated = Date.now();
    }
  }

  refreshDiscoveredShades() {
    for (const gateway of this.gateways) {
      if (!gateway.discoverChannels || !gateway.lastStatus) continue;
      const explicitByChannel = new Map(gateway.configuredShades.map((shade) => [shade.channel, shade]));
      const channels = discoverChannels(gateway, gateway.lastStatus, explicitByChannel);

      for (const discovered of channels) {
        const existing = this.shades.find((shade) => shade.gateway.id === gateway.id && shade.channel === discovered.channel);
        if (existing) {
          existing.name = discovered.name;
          existing.disabled = discovered.disabled;
          existing.rfDeviceId = discovered.rfDeviceId;
          continue;
        }
        this.shades.push(discovered);
        this.ensureShadeState(discovered);
      }

      this.shades = this.shades.filter((shade) => {
        if (shade.gateway.id !== gateway.id) return true;
        const explicit = explicitByChannel.get(shade.channel);
        if (explicit?.enabled === false) return false;
        if (gateway.excludeChannels.has(shade.channel)) return false;
        return true;
      });
    }
  }

  decorateShade(shade) {
    const state = this.getState(shade);
    const current = normalizeMaybePosition(state.current_position);
    const target = normalizeMaybePosition(state.target_position);
    return {
      ...shade,
      current_position: current ?? 0,
      percentage: current ?? 0,
      target_position: target ?? current ?? 0,
      batteryMillivolts: state.batteryMillivolts,
      rx: state.rx,
      rfDeviceId: state.rfDeviceId,
      local: true,
    };
  }

  getState(shade) {
    if (!this.stateById.has(shade.id)) {
      this.ensureShadeState(shade);
    }
    return this.stateById.get(shade.id);
  }

  ensureShadeState(shade) {
    if (this.stateById.has(shade.id)) return this.stateById.get(shade.id);
    const assumed = normalizeMaybePosition(shade.assumePosition);
    const state = {
      current_position: assumed,
      target_position: assumed,
      batteryMillivolts: null,
      rx: null,
      rfDeviceId: null,
      moving: false,
      direction: null,
      lastUpdated: 0,
    };
    this.stateById.set(shade.id, state);
    return state;
  }

  findShade(shadeOrName) {
    if (!shadeOrName) return null;
    if (typeof shadeOrName === "object" && shadeOrName.id) {
      return this.shades.find((shade) => shade.id === shadeOrName.id) || shadeOrName;
    }
    return this.shades.find((shade) => shade.name === shadeOrName);
  }

}

function normalizeGateways(gateways) {
  if (!Array.isArray(gateways)) return [];
  return gateways
    .filter((gateway) => gateway && gateway.host)
    .map((gateway, index) => {
      const configuredShades = normalizeConfiguredShades(gateway.shades);
      return {
        id: gateway.id || gateway.serial || gateway.host || `gateway-${index}`,
        host: String(gateway.host).replace(/^https?:\/\//, "").replace(/\/+$/, ""),
        serial: gateway.serial,
        localAddress: gateway.localAddress,
        configuredShades,
        shades: configuredShades,
        discoverChannels: gateway.discoverChannels !== undefined
          ? Boolean(gateway.discoverChannels)
          : true,
        includeChannels: new Set(normalizeChannelList(gateway.includeChannels)),
        excludeChannels: new Set(normalizeChannelList(gateway.excludeChannels)),
        udpPort: Number(gateway.udpPort) || DEFAULT_UDP_PORT,
        localUdpPort: gateway.localUdpPort,
        udpTimeoutMs: Math.max(Number(gateway.udpTimeoutMs) || 1200, 250),
        waitForUdpResponse: gateway.waitForUdpResponse !== false,
        lastStatusRefresh: 0,
        lastStatus: null,
      };
    });
}

function flattenShades(gateways) {
  const shades = [];
  for (const gateway of gateways) {
    for (const rawShade of gateway.shades) {
      if (rawShade.enabled === false) continue;
      if (!rawShade || !rawShade.name || !rawShade.channel) continue;
      const channel = Number(rawShade.channel);
      if (!Number.isInteger(channel) || channel < 1 || channel > 30) continue;
      shades.push({
        ...rawShade,
        id: rawShade.id || `local-${gateway.id}-${channel}`,
        name: rawShade.name,
        channel,
        gateway,
        assumePosition: normalizeMaybePosition(rawShade.assumePosition),
      });
    }
  }
  return shades;
}

function normalizeConfiguredShades(shades) {
  if (!Array.isArray(shades)) return [];
  return shades
    .filter((shade) => shade && shade.channel)
    .map((shade) => ({
      ...shade,
      channel: Number(shade.channel),
    }))
    .filter((shade) => Number.isInteger(shade.channel) && shade.channel >= 1 && shade.channel <= 30);
}

function discoverChannels(gateway, status, explicitByChannel) {
  const shades = [];
  for (let i = 0; i < 30; i += 1) {
    const channel = i + 1;
    const explicit = explicitByChannel.get(channel);
    if (explicit?.enabled === false) continue;
    if (gateway.excludeChannels.has(channel)) continue;

    const discoveredName = normalizeGatewayChannelName(status.names?.[i], channel);
    const rfDeviceId = status.rfdevs?.[i] && status.rfdevs[i] !== "0" ? status.rfdevs[i] : null;
    const explicitlyIncluded = gateway.includeChannels.has(channel);
    const hasConfiguredShade = Boolean(explicit);
    const hasUsefulName = Boolean(discoveredName);
    const hasFeedback = Boolean(rfDeviceId);

    if (!hasConfiguredShade && !explicitlyIncluded && !hasUsefulName && !hasFeedback) continue;

    const name = explicit?.name || discoveredName || `Channel ${channel}`;
    shades.push({
      ...(explicit || {}),
      id: explicit?.id || `local-${gateway.id}-${channel}`,
      name,
      channel,
      gateway,
      assumePosition: normalizeMaybePosition(explicit?.assumePosition),
      rfDeviceId,
    });
  }
  return shades;
}

function normalizeGatewayChannelName(name, channel) {
  const value = String(name || "").trim();
  if (!value || value === "0" || value === `Channel ${channel}`) return null;
  return value;
}

function normalizeChannelList(channels) {
  if (!Array.isArray(channels)) return [];
  return channels
    .map(Number)
    .filter((channel) => Number.isInteger(channel) && channel >= 1 && channel <= 30);
}

function parseGatewayJson(data) {
  try {
    const parsed = JSON.parse(String(data).replace(/\n/g, "\\n").replace(/\r/g, "\\r"));
    if (!Array.isArray(parsed)) {
      throw new Error("response is not an array");
    }
    return parsed;
  } catch (err) {
    throw new LocalPowerShadesApiError(`Invalid gateway JSON response: ${err.message}`);
  }
}

function parseChannelValues(data, mapper = String) {
  const values = String(data || "").split(":");
  while (values.length < 30) values.push("0");
  return values.slice(0, 30).map((value) => mapper(value));
}

function parseGatewayChannelNames(chnames1 = "", chnames2 = "", chnames3 = "") {
  const groups = [chnames1, chnames2, chnames3].map((data, groupIndex) => {
    const values = String(data || "").split(":");
    while (values.length < 10) values.push(`Channel ${groupIndex * 10 + values.length + 1}`);
    return values.slice(0, 10);
  });
  return groups.flat();
}

function requestGateway(gateway, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: gateway.host,
      path: `/ajax.shtml?${query}`,
      method: "GET",
      timeout: timeoutMs,
      localAddress: gateway.localAddress,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new LocalPowerShadesApiError(`Gateway ${gateway.host} returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("timeout", () => {
      req.destroy(new LocalPowerShadesApiError(`Gateway ${gateway.host} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function normalizeMaybePosition(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return clampPosition(num);
}

function clampPosition(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

module.exports = {
  LocalPowerShadesApi,
  LocalPowerShadesApiError,
  parseGatewayJson,
  parseChannelValues,
  parseGatewayChannelNames,
  normalizeGatewayChannelName,
};
