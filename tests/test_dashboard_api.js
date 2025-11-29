#!/usr/bin/env node
// Test dashboard API for PowerShades

const https = require('https');
const fs = require('fs');
const path = require('path');

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

const httpsAgent = new https.Agent({ keepAlive: true });

async function testDashboardApi(apiToken, propertyId, shadeId) {
  console.log("\n=== Testing Dashboard API ===\n");
  console.log(`Property ID: ${propertyId}`);
  console.log(`Shade ID: ${shadeId}`);

  const dashboardBase = "https://dashboard.powershades.com";

  // Test 1: With API token as Bearer
  console.log("\nTest 1: Using API token as Bearer");
  try {
    const url = `${dashboardBase}/shades/${propertyId}/${shadeId}`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Accept": "application/json"
      },
      agent: httpsAgent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success!`);
      console.log("\n  Shade detail:");
      console.log(JSON.stringify(data, null, 4));
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text.substring(0, 200)}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  // Test 2: With X-XSRF-TOKEN header
  console.log("\nTest 2: Using API token as X-XSRF-TOKEN");
  try {
    const url = `${dashboardBase}/shades/${propertyId}/${shadeId}`;
    const res = await fetch(url, {
      headers: {
        "X-XSRF-TOKEN": apiToken,
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      agent: httpsAgent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success!`);
      console.log("\n  Shade detail:");
      console.log(JSON.stringify(data, null, 4));
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text.substring(0, 200)}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  // Test 3: Try devices endpoint on dashboard
  console.log("\nTest 3: Dashboard /devices endpoint with Bearer token");
  try {
    const url = `${dashboardBase}/devices`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Accept": "application/json"
      },
      agent: httpsAgent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success!`);
      console.log("\n  Devices:");
      console.log(JSON.stringify(data, null, 4));
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text.substring(0, 200)}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  console.log("\n❌ Dashboard API requires session cookies (login via browser)");
  console.log("The dashboard API is separate from api.powershades.com");
  return false;
}

async function main() {
  loadEnv();
  const apiToken = process.env.POWERSHADES_API_TOKEN;

  if (!apiToken) {
    console.error("Set POWERSHADES_API_TOKEN in .env");
    process.exit(1);
  }

  // First, get a shade from the main API to get property_id and shade_id
  console.log("Fetching shade list from api.powershades.com...");
  try {
    const res = await fetch("https://api.powershades.com/shades/", {
      headers: { "Authorization": `Bearer ${apiToken}` },
      agent: httpsAgent
    });
    if (!res.ok) {
      console.error("Failed to fetch shades from API");
      process.exit(1);
    }
    const data = await res.json();
    const shades = Array.isArray(data) ? data : (data.results || []);
    if (shades.length === 0) {
      console.error("No shades found");
      process.exit(1);
    }
    const shade = shades[0];
    console.log(`Using shade: ${shade.name} (ID: ${shade.id}, Property: ${shade.property_id})`);

    await testDashboardApi(apiToken, shade.property_id, shade.id);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
