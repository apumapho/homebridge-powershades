#!/usr/bin/env node
// Minimal API smoke test for PowerShades. Uses .env (POWERSHADES_USERNAME/POWERSHADES_PASSWORD).

const { PowerShadesApi } = require("../api");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    process.env[key.trim()] ??= value;
  }
}

async function main() {
  loadEnv();
  const email = process.env.POWERSHADES_USERNAME;
  const password = process.env.POWERSHADES_PASSWORD;
  const baseUrl = process.env.POWERSHADES_BASE_URL;
  if (!email || !password) {
    console.error("Set POWERSHADES_USERNAME and POWERSHADES_PASSWORD in the environment or .env");
    process.exit(1);
  }

  const api = new PowerShadesApi({ email, password, baseUrl, logger: console });
  await api.login();
  const shades = await api.getShades();
  const scenes = await api.getScenes();
  const schedules = await api.getSchedules();

  console.log("Login OK");
  console.log(`Base URL used: ${api.activeBase}`);
  console.log(`Shades: ${Array.isArray(shades) ? shades.length : "unknown"}`);
  console.log(`Scenes: ${Array.isArray(scenes) ? scenes.length : "unknown"}`);
  console.log(`Schedules: ${Array.isArray(schedules) ? schedules.length : "unknown"}`);

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

  printList("shades", shades);
  printList("scenes", scenes);
  printList("schedules", schedules);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
