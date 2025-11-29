// Homebridge platform plugin for PowerShades.

const { PowerShadesApi } = require("./api");

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
    this.shadeListCache = [];
    this.shadeListCacheTime = 0;
    this.shadeListCacheTTL = (Number(this.config.shadeListCacheTTL) || 300) * 1000;
    this.lastActivityTime = 0;
    this.pollTimer = null;

    // Require either API token OR email+password
    if (!this.apiToken && (!this.email || !this.password)) {
      this.log.error("[PowerShades] Missing credentials: provide either 'apiToken' OR 'email' and 'password' in config.json");
      return;
    }

    this.psApi = new PowerShadesApi({
      email: this.email,
      password: this.password,
      apiToken: this.apiToken,
      baseUrl: this.baseUrl,
      logger: this.log,
    });

    if (this.api) {
      this.api.on("didFinishLaunching", () => {
        this.log.info("[PowerShades] Homebridge launch finished; discovering shades...");
        this.discoverShades();
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
    if (forceRefresh || !this.shadeListCache.length || (now - this.shadeListCacheTime) > this.shadeListCacheTTL) {
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
      .onSet((value) => this.handleSetTargetPosition(shade, value));

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
  }

  async handleSetTargetPosition(shade, value) {
    const target = clampPosition(value);
    this.log.info(`[PowerShades] Setting "${shade.name}" to ${target}%`);
    try {
      await this.psApi.moveShade(shade.name, target);
      // Trigger fast polling after user activity
      this.lastActivityTime = Date.now();
      this.restartPolling();
    } catch (err) {
      this.log.error("[PowerShades] Move failed:", err.message || err);
      throw err;
    }
  }

  handleGetCurrentPosition(accessory) {
    const shade = accessory.context.shade;
    return normalizePosition(shade);
  }

  handleGetPositionState(accessory) {
    // Without motion telemetry, report STOPPED.
    return this.api.hap.Characteristic.PositionState.STOPPED;
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
    const interval = this.getCurrentPollInterval();
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
        service.updateCharacteristic(this.api.hap.Characteristic.CurrentPosition, pos);
        service.updateCharacteristic(this.api.hap.Characteristic.TargetPosition, pos);
        service.updateCharacteristic(this.api.hap.Characteristic.PositionState, this.api.hap.Characteristic.PositionState.STOPPED);
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

function clampPosition(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
