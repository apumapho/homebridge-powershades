"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  batteryLevelFromMillivolts,
  inferPowerSourceFromMillivolts,
  normalizePowerSource,
  resolvePowerSource,
} = require("../power-source");

test("power source inference separates hardwired and battery voltage ranges", () => {
  assert.equal(inferPowerSourceFromMillivolts(12400), "hardwired");
  assert.equal(inferPowerSourceFromMillivolts(8000), "battery");
  assert.equal(inferPowerSourceFromMillivolts(null), "unknown");
});

test("explicit power source overrides voltage inference", () => {
  assert.equal(resolvePowerSource("battery", 12400), "battery");
  assert.equal(resolvePowerSource("hardwired", 8000), "hardwired");
  assert.equal(resolvePowerSource("auto", 8000), "battery");
  assert.equal(normalizePowerSource("unexpected"), "auto");
});

test("battery voltage is scaled to HomeKit battery percentage", () => {
  assert.equal(batteryLevelFromMillivolts(7000), 0);
  assert.equal(batteryLevelFromMillivolts(8400), 100);
  assert.equal(batteryLevelFromMillivolts(7700), 50);
  assert.equal(batteryLevelFromMillivolts(9000), 100);
  assert.equal(batteryLevelFromMillivolts(0), null);
});
