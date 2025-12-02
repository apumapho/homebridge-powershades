#!/usr/bin/env node
// Minimal API smoke test for PowerShades.

const { PowerShadesApi } = require("../api");

async function main() {
  const email = process.env.POWERSHADES_USERNAME;
  const password = process.env.POWERSHADES_PASSWORD;
  const baseUrl = process.env.POWERSHADES_BASE_URL;
  if (!email || !password) {
    console.error("Set POWERSHADES_USERNAME and POWERSHADES_PASSWORD environment variables");
    process.exit(1);
  }

  const api = new PowerShadesApi({ email, password, baseUrl, logger: console });
  await api.login();
  const shades = await api.getShades();
  const scenes = await api.getScenes();
  const schedules = await api.getSchedules();

  // Try to fetch devices
  let devices = [];
  try {
    devices = await api.getDevices();
  } catch (err) {
    console.log(`Note: Could not fetch devices - ${err.message}`);
  }

  const printList = (label, payload) => {
    console.log(`\n${label.toUpperCase()}`);
    if (!Array.isArray(payload) || payload.length === 0) {
      console.log("  (none)");
      return;
    }
    payload.forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${JSON.stringify(item, null, 2)}`);
    });
  };

  console.log("Login OK");
  console.log(`Base URL used: ${api.activeBase}`);
  console.log(`Shades: ${Array.isArray(shades) ? shades.length : "unknown"}`);
  console.log(`Devices: ${Array.isArray(devices) ? devices.length : "unknown"}`);
  console.log(`Scenes: ${Array.isArray(scenes) ? scenes.length : "unknown"}`);
  console.log(`Schedules: ${Array.isArray(schedules) ? schedules.length : "unknown"}`);

  // Fetch shade attributes
  console.log("\nFetching shade attributes...");
  try {
    const shadeAttributes = await api.getShadeAttributes();
    console.log(`Found ${shadeAttributes.length} shade attribute records`);
    if (shadeAttributes.length > 0) {
      console.log("\nSAMPLE SHADE ATTRIBUTES:");
      console.log(JSON.stringify(shadeAttributes.slice(0, 10), null, 2));

      // Find manufacturer/model/serial/firmware attributes
      const relevantAttrs = shadeAttributes.filter(a =>
        ['Manufacturer', 'Model', 'SerialNumber', 'Serial', 'Firmware', 'FirmwareVersion', 'Version'].includes(a.attribute)
      );
      if (relevantAttrs.length > 0) {
        console.log("\n\nRELEVANT ATTRIBUTES (Manufacturer/Model/Serial/Firmware):");
        console.log(JSON.stringify(relevantAttrs, null, 2));
      }
    }
  } catch (err) {
    console.log(`Could not fetch shade attributes: ${err.message}`);
  }

  printList("shades", shades);
  printList("devices", devices);
  printList("scenes", scenes);
  printList("schedules", schedules);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
