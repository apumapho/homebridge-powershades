"use strict";

const POWER_SOURCE_AUTO = "auto";
const POWER_SOURCE_BATTERY = "battery";
const POWER_SOURCE_HARDWIRED = "hardwired";
const POWER_SOURCE_UNKNOWN = "unknown";

const POWER_SOURCE_VALUES = new Set([
  POWER_SOURCE_AUTO,
  POWER_SOURCE_BATTERY,
  POWER_SOURCE_HARDWIRED,
  POWER_SOURCE_UNKNOWN,
]);

const DEFAULT_BATTERY_MIN_MILLIVOLTS = 7000;
const DEFAULT_BATTERY_MAX_MILLIVOLTS = 8400;
const DEFAULT_LOW_BATTERY_MILLIVOLTS = 7200;
const HARDWIRED_MIN_MILLIVOLTS = 11000;
const BATTERY_MIN_REASONABLE_MILLIVOLTS = 5000;

function normalizePowerSource(value) {
  const normalized = String(value || POWER_SOURCE_AUTO).trim().toLowerCase();
  return POWER_SOURCE_VALUES.has(normalized) ? normalized : POWER_SOURCE_AUTO;
}

function inferPowerSourceFromMillivolts(millivolts) {
  const value = Number(millivolts);
  if (!Number.isFinite(value) || value <= 0) return POWER_SOURCE_UNKNOWN;
  if (value >= HARDWIRED_MIN_MILLIVOLTS) return POWER_SOURCE_HARDWIRED;
  if (value >= BATTERY_MIN_REASONABLE_MILLIVOLTS) return POWER_SOURCE_BATTERY;
  return POWER_SOURCE_UNKNOWN;
}

function resolvePowerSource(configuredPowerSource, millivolts) {
  const configured = normalizePowerSource(configuredPowerSource);
  if (configured !== POWER_SOURCE_AUTO) return configured;
  return inferPowerSourceFromMillivolts(millivolts);
}

function batteryLevelFromMillivolts(millivolts, {
  minMillivolts = DEFAULT_BATTERY_MIN_MILLIVOLTS,
  maxMillivolts = DEFAULT_BATTERY_MAX_MILLIVOLTS,
} = {}) {
  const value = Number(millivolts);
  const min = Number(minMillivolts);
  const max = Number(maxMillivolts);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  const scaled = ((value - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function isLowBatteryMillivolts(millivolts, lowMillivolts = DEFAULT_LOW_BATTERY_MILLIVOLTS) {
  const value = Number(millivolts);
  const low = Number(lowMillivolts);
  return Number.isFinite(value) && value > 0 && Number.isFinite(low) && value <= low;
}

function shouldExposeBatteryService(configuredPowerSource, millivolts) {
  return resolvePowerSource(configuredPowerSource, millivolts) === POWER_SOURCE_BATTERY;
}

module.exports = {
  POWER_SOURCE_AUTO,
  POWER_SOURCE_BATTERY,
  POWER_SOURCE_HARDWIRED,
  POWER_SOURCE_UNKNOWN,
  DEFAULT_BATTERY_MIN_MILLIVOLTS,
  DEFAULT_BATTERY_MAX_MILLIVOLTS,
  DEFAULT_LOW_BATTERY_MILLIVOLTS,
  batteryLevelFromMillivolts,
  inferPowerSourceFromMillivolts,
  isLowBatteryMillivolts,
  normalizePowerSource,
  resolvePowerSource,
  shouldExposeBatteryService,
};
