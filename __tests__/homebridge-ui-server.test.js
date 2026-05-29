"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildChannelRows } = require("../homebridge-ui/server");

test("custom UI discovery rows preserve configured battery thresholds", () => {
  const rows = buildChannelRows({
    percent: [50],
    battery: [7700],
    rx: [-64],
    rfdevs: ["abc"],
    names: ["Kitchen"],
  }, new Map([
    [1, {
      channel: 1,
      name: "Kitchen Window",
      powerSource: "battery",
      batteryMinMillivolts: 7600,
      batteryMaxMillivolts: 7800,
      lowBatteryMillivolts: 7650,
    }],
  ]));

  assert.equal(rows[0].name, "Kitchen Window");
  assert.equal(rows[0].effectivePowerSource, "battery");
  assert.equal(rows[0].batteryLevel, 50);
  assert.equal(rows[0].batteryMinMillivolts, 7600);
  assert.equal(rows[0].batteryMaxMillivolts, 7800);
  assert.equal(rows[0].lowBatteryMillivolts, 7650);
});
