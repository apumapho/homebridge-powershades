"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { serializeGateway } = require("../homebridge-ui/public/app");

test("custom UI save serialization preserves gateway and shade overrides", () => {
  const gateway = {
    host: "http://192.168.1.50/",
    serial: "gw1",
    localAddress: "192.168.1.2",
    udpPort: 42,
    localUdpPort: 50042,
    udpTimeoutMs: 1500,
    waitForUdpResponse: false,
    includeChannels: [4, "5", 99, "bad"],
    excludeChannels: [9],
    channels: [
      {
        channel: 1,
        name: "Kitchen",
        enabled: true,
        powerSource: "battery",
        batteryMinMillivolts: 7600,
        batteryMaxMillivolts: 7800,
        lowBatteryMillivolts: 7650,
        useful: true,
      },
      {
        channel: 2,
        name: "Hidden",
        enabled: false,
        hasConfig: true,
        powerSource: "hardwired",
      },
      {
        channel: 3,
        name: "Empty",
        enabled: false,
        useful: false,
        hasConfig: false,
      },
    ],
  };

  assert.deepEqual(serializeGateway(gateway), {
    host: "192.168.1.50",
    serial: "gw1",
    localAddress: "192.168.1.2",
    discoverChannels: true,
    udpPort: 42,
    localUdpPort: 50042,
    udpTimeoutMs: 1500,
    waitForUdpResponse: false,
    includeChannels: [4, 5],
    excludeChannels: [9],
    shades: [
      {
        channel: 1,
        name: "Kitchen",
        powerSource: "battery",
        batteryMinMillivolts: 7600,
        batteryMaxMillivolts: 7800,
        lowBatteryMillivolts: 7650,
      },
      {
        channel: 2,
        name: "Hidden",
        enabled: false,
        powerSource: "hardwired",
      },
    ],
  });
});

test("custom UI help icons do not also use native browser title tooltips", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../homebridge-ui/public/app.js"), "utf8");
  assert.equal(appSource.includes(".title ="), false);
  assert.equal(appSource.includes("setAttribute(\"title\""), false);
});
