// Homebridge platform plugin for PowerShades.

const { PowerShadesApi } = require("./api");
const { LocalPowerShadesApi } = require("./local-api");
const {
  batteryLevelFromMillivolts,
  isLowBatteryMillivolts,
  shouldExposeBatteryService,
} = require("./power-source");

const PLUGIN_NAME = "homebridge-powershades";
const PLATFORM_NAME = "PowerShades";

module.exports = (homebridge) => {
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PowerShadesPlatform);
};

class PowerShadesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.pollInterval = Math.max(Number(this.config.pollInterval) || 10, 2);
    this.fastPollInterval = Math.max(Number(this.config.fastPollInterval) || 1, 1);
    this.fastPollDuration = Math.max(Number(this.config.fastPollDuration) || 30, 5);
    this.email = this.config.email;
    this.password = this.config.password;
    this.apiToken = this.config.apiToken;
    this.baseUrl = this.config.baseUrl;
    this.controlMode = resolveConfiguredControlMode(this.config);
    this.isLocalMode = this.controlMode === "local-udp";
    this.shadeListCache = [];
    this.shadeListCacheTime = 0;
    this.shadeListCacheTTL = (Number(this.config.shadeListCacheTTL) || 300) * 1000;
    this.groupListCache = [];
    this.groupListCacheTime = 0;
    this.exposeGroups = this.config.exposeGroups || [];
    this.lastActivityTime = 0;
    this.pollTimer = null;

    if (this.isLocalMode) {
      this.psApi = new LocalPowerShadesApi({
        gateways: this.config.localGateways || this.config.gateways || [],
        logger: this.log,
        requestTimeoutMs: this.config.localRequestTimeoutMs,
        statusCacheTTL: (Number(this.config.localStatusCacheTTL) || 30) * 1000,
        optimisticStatusHoldMs: this.config.localOptimisticStatusHoldMs,
      });
      if (!this.psApi.gateways.length) {
        this.log.error("[PowerShades] Local control mode requires at least one configured local gateway");
        return;
      }
    } else if (!this.apiToken && (!this.email || !this.password)) {
      // Cloud mode requires either API token OR email+password.
      this.log.error("[PowerShades] Missing credentials: provide either 'apiToken' OR 'email' and 'password' in config.json");
      return;
    } else {
      this.psApi = new PowerShadesApi({
        email: this.email,
        password: this.password,
        apiToken: this.apiToken,
        baseUrl: this.baseUrl,
        logger: this.log,
        maxAuthFailures: this.config.maxAuthFailures,
        authFailureBackoffMs: this.config.authFailureBackoffMs,
        maxBackoffMs: this.config.maxBackoffMs,
      });
    }

    if (this.api) {
      this.api.on("didFinishLaunching", async () => {
        this.log.info("[PowerShades] Homebridge launch finished; discovering shades...");
        await this.discoverShades();
        if (!this.isLocalMode) {
          await this.discoverGroups();
        }
        await this.cleanupStaleAccessories();
        this.startPolling();
      });
    }
  }

  configureAccessory(accessory) {
    this.log.info("[PowerShades] Restoring cached accessory:", accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  async getCachedShades(forceRefresh = false) {
    const now = Date.now();
    if (this.isLocalMode || forceRefresh || !this.shadeListCache.length || (now - this.shadeListCacheTime) > this.shadeListCacheTTL) {
      this.shadeListCache = await this.psApi.getShades();
      this.shadeListCacheTime = now;
      this.log.debug(`[PowerShades] Refreshed shade list cache (${this.shadeListCache.length} shades)`);
    }
    return this.shadeListCache;
  }

  async discoverShades() {
    try {
      const shades = await this.getCachedShades(true);
      this.log.info(`[PowerShades] Found ${shades.length} shades`);
      for (const shade of shades) {
        this.registerShadeAccessory(shade);
      }
    } catch (err) {
      this.log.error("[PowerShades] Failed to fetch shades:", err.message || err);
    }
  }

  async getCachedGroups(forceRefresh = false) {
    const now = Date.now();
    if (forceRefresh || !this.groupListCache.length || (now - this.groupListCacheTime) > this.shadeListCacheTTL) {
      this.groupListCache = await this.psApi.getGroups();
      this.groupListCacheTime = now;
      this.log.debug(`[PowerShades] Refreshed group list cache (${this.groupListCache.length} groups)`);
    }
    return this.groupListCache;
  }

  async discoverGroups() {
    if (this.isLocalMode) {
      this.log.info("[PowerShades] Shade groups are not available in local control mode");
      return;
    }

    try {
      const groups = await this.getCachedGroups(true);

      // Log all available groups for easy config setup
      if (groups.length > 0) {
        const groupNames = groups.map(g => g.name).join(', ');
        this.log.info(`[PowerShades] Available groups: ${groupNames}`);
      }

      if (!this.exposeGroups || this.exposeGroups.length === 0) {
        this.log.info("[PowerShades] No groups configured to expose (use 'exposeGroups' in config)");
        return;
      }

      const exposedGroups = groups.filter(g => this.exposeGroups.includes(g.name));
      this.log.info(`[PowerShades] Exposing ${exposedGroups.length} groups: ${exposedGroups.map(g => g.name).join(', ')}`);

      for (const group of exposedGroups) {
        this.registerGroupAccessory(group);
      }
    } catch (err) {
      this.log.error("[PowerShades] Failed to fetch groups:", err.message || err);
    }
  }

  async cleanupStaleAccessories() {
    try {
      // Build set of valid UUIDs for current shades and groups
      const validUUIDs = new Set();

      // Add UUIDs for all current shades
      const shades = await this.getCachedShades(false);
      for (const shade of shades) {
        const uuid = this.api.hap.uuid.generate(`powershades-shade-${shade.id || shade.name}`);
        validUUIDs.add(uuid);
      }

      // Add UUIDs for exposed groups
      if (!this.isLocalMode && this.exposeGroups && this.exposeGroups.length > 0) {
        const groups = await this.getCachedGroups(false);
        const exposedGroups = groups.filter(g => this.exposeGroups.includes(g.name));
        for (const group of exposedGroups) {
          const uuid = this.api.hap.uuid.generate(`powershades-group-${group.id}`);
          validUUIDs.add(uuid);
        }
      }

      // Remove accessories that are no longer valid
      const staleAccessories = [];
      for (const [uuid, accessory] of this.accessories.entries()) {
        if (!validUUIDs.has(uuid)) {
          staleAccessories.push(accessory);
          this.accessories.delete(uuid);
        }
      }

      if (staleAccessories.length > 0) {
        this.log.info(`[PowerShades] Removing ${staleAccessories.length} stale accessories: ${staleAccessories.map(a => a.displayName).join(', ')}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      }
    } catch (err) {
      this.log.error("[PowerShades] Failed to clean up stale accessories:", err.message || err);
    }
  }

  registerGroupAccessory(group) {
    const uuid = this.api.hap.uuid.generate(`powershades-group-${group.id}`);
    let accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.info("[PowerShades] Updating existing group accessory:", group.name);
      accessory.displayName = group.name;
      accessory.context.group = group;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info("[PowerShades] Adding new group accessory:", group.name);
      accessory = new this.api.platformAccessory(group.name || "PowerShades Group", uuid);
      accessory.context.group = group;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    // Update AccessoryInformation service name
    const infoService = accessory.getService(this.api.hap.Service.AccessoryInformation);
    if (infoService) {
      infoService.setCharacteristic(this.api.hap.Characteristic.Name, group.name);
    }

    const service =
      accessory.getService(this.api.hap.Service.WindowCovering) ||
      accessory.addService(this.api.hap.Service.WindowCovering, group.name || "PowerShades Group");

    // Update service name
    service.setCharacteristic(this.api.hap.Characteristic.Name, group.name);

    // Handlers for groups
    service
      .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
      .onSet((value) => this.handleSetGroupTargetPosition(group, value));

    service
      .getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
      .onGet(() => this.handleGetGroupCurrentPosition(accessory));

    service
      .getCharacteristic(this.api.hap.Characteristic.PositionState)
      .onGet(() => this.handleGetPositionState(accessory));

    // Initialize positions (use average of shades in group)
    const current = this.getGroupAveragePosition(group);
    service.updateCharacteristic(this.api.hap.Characteristic.CurrentPosition, current);
    service.updateCharacteristic(this.api.hap.Characteristic.TargetPosition, current);
    service.updateCharacteristic(this.api.hap.Characteristic.PositionState, this.api.hap.Characteristic.PositionState.STOPPED);
  }

  registerShadeAccessory(shade) {
    const uuid = this.api.hap.uuid.generate(`powershades-shade-${shade.id || shade.name}`);
    let accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.info("[PowerShades] Updating existing shade accessory:", shade.name);
      accessory.displayName = shade.name;
      accessory.context.shade = shade;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info("[PowerShades] Adding new shade accessory:", shade.name);
      accessory = new this.api.platformAccessory(shade.name || "PowerShade", uuid);
      accessory.context.shade = shade;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    // Update AccessoryInformation service name (what HomeKit displays)
    const infoService = accessory.getService(this.api.hap.Service.AccessoryInformation);
    if (infoService) {
      infoService.setCharacteristic(this.api.hap.Characteristic.Name, shade.name);
    }

    const service =
      accessory.getService(this.api.hap.Service.WindowCovering) ||
      accessory.addService(this.api.hap.Service.WindowCovering, shade.name || "PowerShade");

    // Update service name to match current shade name
    service.setCharacteristic(this.api.hap.Characteristic.Name, shade.name);

    // Handlers
    service
      .getCharacteristic(this.api.hap.Characteristic.TargetPosition)
      .onSet((value) => this.handleSetTargetPosition(accessory, shade, value));

    service
      .getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
      .onGet(() => this.handleGetCurrentPosition(accessory));

    service
      .getCharacteristic(this.api.hap.Characteristic.PositionState)
      .onGet(() => this.handleGetPositionState(accessory));

    // Initialize positions optimistically.
    const current = normalizePosition(shade);
    service.updateCharacteristic(this.api.hap.Characteristic.CurrentPosition, current);
    service.updateCharacteristic(this.api.hap.Characteristic.TargetPosition, current);
    service.updateCharacteristic(this.api.hap.Characteristic.PositionState, this.api.hap.Characteristic.PositionState.STOPPED);
    this.updateBatteryService(accessory, shade);
  }

  async handleSetTargetPosition(accessory, shade, value) {
    const target = clampPosition(value);
    const modeLabel = this.controlMode === "local-udp"
      ? "via local UDP"
      : "via cloud";
    this.log.info(`[PowerShades] Setting "${shade.name}" to ${target}% ${modeLabel}`);
    try {
      await this.psApi.moveShade(this.isLocalMode ? shade : shade.name, target);
      this.updateShadeTargetState(accessory, target);
      // Trigger fast polling after user activity
      this.lastActivityTime = Date.now();
      this.restartPolling();
    } catch (err) {
      this.log.error("[PowerShades] Move failed:", err.message || err);
      throw err;
    }
  }

  updateShadeTargetState(accessory, target) {
    if (!accessory) return;
    const shade = accessory.context.shade || {};
    accessory.context.shade = {
      ...shade,
      current_position: target,
      percentage: target,
      position: target,
      target_position: target,
    };
    const service = accessory.getService(this.api.hap.Service.WindowCovering);
    if (!service) return;
    service.updateCharacteristic(this.api.hap.Characteristic.CurrentPosition, target);
    service.updateCharacteristic(this.api.hap.Characteristic.TargetPosition, target);
    service.updateCharacteristic(
      this.api.hap.Characteristic.PositionState,
      this.api.hap.Characteristic.PositionState.STOPPED,
    );
  }

  handleGetCurrentPosition(accessory) {
    const shade = accessory.context.shade;
    return normalizePosition(shade);
  }

  handleGetPositionState(accessory) {
    if (this.isLocalMode && this.psApi?.isShadeMoving) {
      const shade = accessory.context.shade;
      if (this.psApi.isShadeMoving(shade)) {
        const direction = this.psApi.getShadeDirection?.(shade);
        return direction === "opening"
          ? this.api.hap.Characteristic.PositionState.DECREASING
          : this.api.hap.Characteristic.PositionState.INCREASING;
      }
    }
    // Without motion telemetry, report STOPPED.
    return this.api.hap.Characteristic.PositionState.STOPPED;
  }

  updateBatteryService(accessory, shade) {
    const batteryService = accessory.getService(this.api.hap.Service.Battery);
    if (!this.shouldExposeBatteryForShade(shade)) {
      if (batteryService) {
        accessory.removeService(batteryService);
      }
      return;
    }

    const service = batteryService || accessory.addService(this.api.hap.Service.Battery, `${shade.name} Battery`, "battery");
    service.setCharacteristic(this.api.hap.Characteristic.Name, `${shade.name} Battery`);
    if (!service._powershadesBatteryHandlers) {
      service
        .getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
        .onGet(() => this.getBatteryLevel(accessory.context.shade));
      service
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .onGet(() => this.getLowBatteryStatus(accessory.context.shade));
      service._powershadesBatteryHandlers = true;
    }

    service.updateCharacteristic(this.api.hap.Characteristic.BatteryLevel, this.getBatteryLevel(shade));
    service.updateCharacteristic(this.api.hap.Characteristic.StatusLowBattery, this.getLowBatteryStatus(shade));
  }

  shouldExposeBatteryForShade(shade) {
    return shouldExposeBatteryService(shade?.powerSource, shade?.batteryMillivolts);
  }

  getBatteryLevel(shade) {
    if (Number.isFinite(Number(shade?.batteryLevel))) {
      return clampPosition(shade.batteryLevel);
    }
    return batteryLevelFromMillivolts(shade?.batteryMillivolts, {
      minMillivolts: shade?.batteryMinMillivolts,
      maxMillivolts: shade?.batteryMaxMillivolts,
    }) ?? 0;
  }

  getLowBatteryStatus(shade) {
    const low = shade?.lowBattery !== undefined
      ? Boolean(shade.lowBattery)
      : isLowBatteryMillivolts(shade?.batteryMillivolts, shade?.lowBatteryMillivolts);
    return low
      ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  async handleSetGroupTargetPosition(group, value) {
    if (this.isLocalMode) {
      throw new Error("Groups are not supported in local control mode");
    }

    const target = clampPosition(value);
    this.log.info(`[PowerShades] Setting group "${group.name}" to ${target}%`);
    try {
      await this.psApi.moveGroup(group.id, target);
      // Trigger fast polling after user activity
      this.lastActivityTime = Date.now();
      this.restartPolling();
    } catch (err) {
      this.log.error("[PowerShades] Group move failed:", err.message || err);
      throw err;
    }
  }

  handleGetGroupCurrentPosition(accessory) {
    const group = accessory.context.group;
    return this.getGroupAveragePosition(group);
  }

  getGroupAveragePosition(group) {
    if (!group.shades || group.shades.length === 0) return 0;

    const shadePositions = group.shades.map(shadeId => {
      const shade = this.shadeListCache.find(s => s.id === shadeId);
      return shade ? normalizePosition(shade) : 0;
    });

    const sum = shadePositions.reduce((acc, pos) => acc + pos, 0);
    return Math.round(sum / shadePositions.length);
  }

  getCurrentPollInterval() {
    const timeSinceActivity = (Date.now() - this.lastActivityTime) / 1000;
    if (timeSinceActivity < this.fastPollDuration) {
      return this.fastPollInterval;
    }
    return this.pollInterval;
  }

  restartPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.schedulePoll();
  }

  schedulePoll() {
    let interval = this.getCurrentPollInterval();

    // If the API is in auth backoff, don't poll every 10 seconds — wait for backoff to expire.
    // This prevents thousands of useless "Auth in backoff" log entries and allows the retry
    // to happen promptly when the backoff window opens.
    if (this.psApi && this.psApi.isInBackoff && this.psApi.isInBackoff()) {
      const backoffRemaining = Math.ceil((this.psApi.nextAuthRetryTime - Date.now()) / 1000);
      if (backoffRemaining > interval) {
        interval = backoffRemaining + 1; // Poll 1 second after backoff expires
        this.log.debug?.(`[PowerShades] Auth in backoff, next poll in ${backoffRemaining}s`);
      }
    }

    this.pollTimer = setTimeout(async () => {
      await this.pollShades();
      this.schedulePoll();
    }, interval * 1000);
  }

  async pollShades() {
    try {
      const shades = await this.getCachedShades(false);
      for (const shade of shades) {
        const uuid = this.api.hap.uuid.generate(`powershades-shade-${shade.id || shade.name}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) continue;
        accessory.context.shade = shade;
        const service = accessory.getService(this.api.hap.Service.WindowCovering);
        const pos = normalizePosition(shade);
        const target = this.isLocalMode ? normalizeTargetPosition(shade) : pos;
        service.updateCharacteristic(this.api.hap.Characteristic.CurrentPosition, pos);
        service.updateCharacteristic(this.api.hap.Characteristic.TargetPosition, target);
        service.updateCharacteristic(this.api.hap.Characteristic.PositionState, this.handleGetPositionState(accessory));
        this.updateBatteryService(accessory, shade);
      }

      // Poll groups
      if (!this.isLocalMode && this.exposeGroups && this.exposeGroups.length > 0) {
        const groups = await this.getCachedGroups(false);
        for (const group of groups) {
          if (!this.exposeGroups.includes(group.name)) continue;
          const uuid = this.api.hap.uuid.generate(`powershades-group-${group.id}`);
          const accessory = this.accessories.get(uuid);
          if (!accessory) continue;
          accessory.context.group = group;
          const service = accessory.getService(this.api.hap.Service.WindowCovering);
          const pos = this.getGroupAveragePosition(group);
          service.updateCharacteristic(this.api.hap.Characteristic.CurrentPosition, pos);
          service.updateCharacteristic(this.api.hap.Characteristic.TargetPosition, pos);
          service.updateCharacteristic(this.api.hap.Characteristic.PositionState, this.api.hap.Characteristic.PositionState.STOPPED);
        }
      }
    } catch (err) {
      this.log.error("[PowerShades] Poll failed:", err.message || err);
    }
  }

  startPolling() {
    this.schedulePoll();
  }
}

function normalizePosition(shade) {
  const val =
    shade?.current_position ??
    shade?.percentage ??
    shade?.position ??
    shade?.shade_position ??
    0;
  const num = Number(val);
  if (Number.isNaN(num)) return 0;
  return clampPosition(num);
}

function normalizeTargetPosition(shade) {
  const val = shade?.target_position ?? normalizePosition(shade);
  const num = Number(val);
  if (Number.isNaN(num)) return normalizePosition(shade);
  return clampPosition(num);
}

function clampPosition(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

function normalizeControlMode(value) {
  const mode = String(value || "cloud").toLowerCase();
  if (mode === "local-udp" || mode === "udp" || mode === "local") return "local-udp";
  return "cloud";
}

function resolveConfiguredControlMode(config = {}) {
  if (config.controlMode || config.mode) {
    return normalizeControlMode(config.controlMode || config.mode);
  }
  const hasLocalGateways = Array.isArray(config.localGateways || config.gateways)
    && (config.localGateways || config.gateways).length > 0;
  if (hasLocalGateways) return "local-udp";
  if (config.apiToken || (config.email && config.password)) return "cloud";
  return "local-udp";
}

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
module.exports.normalizeControlMode = normalizeControlMode;
module.exports.resolveConfiguredControlMode = resolveConfiguredControlMode;
