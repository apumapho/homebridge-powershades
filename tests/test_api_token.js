#!/usr/bin/env node
// Test API token authentication for PowerShades

const https = require('https');
const http = require('http');
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
const httpAgent = new http.Agent({ keepAlive: true });

async function testApiToken(apiToken, baseUrl = "https://api.powershades.com") {
  console.log("\n=== Testing API Token Authentication ===\n");

  // Test 1: Direct Bearer token
  console.log("Test 1: Using API token as direct Bearer token");
  try {
    const agent = baseUrl.startsWith('https') ? httpsAgent : httpAgent;
    const res = await fetch(`${baseUrl}/shades/`, {
      headers: { "Authorization": `Bearer ${apiToken}` },
      agent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success! Got ${Array.isArray(data) ? data.length : (data.results?.length || 0)} shades`);
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  // Test 2: Token auth endpoint
  console.log("\nTest 2: Using /auth/token/ endpoint");
  try {
    const agent = baseUrl.startsWith('https') ? httpsAgent : httpAgent;
    const res = await fetch(`${baseUrl}/auth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: apiToken }),
      agent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Got response:`, data);
      if (data.access || data.token) {
        console.log(`  ✓ Success! Got access token`);
        return true;
      }
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  // Test 3: API key header
  console.log("\nTest 3: Using X-API-Key header");
  try {
    const agent = baseUrl.startsWith('https') ? httpsAgent : httpAgent;
    const res = await fetch(`${baseUrl}/shades/`, {
      headers: { "X-API-Key": apiToken },
      agent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success! Got ${Array.isArray(data) ? data.length : (data.results?.length || 0)} shades`);
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  // Test 4: Token as Bearer with "Token" prefix
  console.log("\nTest 4: Using 'Token' prefix instead of 'Bearer'");
  try {
    const agent = baseUrl.startsWith('https') ? httpsAgent : httpAgent;
    const res = await fetch(`${baseUrl}/shades/`, {
      headers: { "Authorization": `Token ${apiToken}` },
      agent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success! Got ${Array.isArray(data) ? data.length : (data.results?.length || 0)} shades`);
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  // Test 5: Try /devices/ endpoint with token
  console.log("\nTest 5: Trying /devices/ endpoint with token");
  try {
    const agent = baseUrl.startsWith('https') ? httpsAgent : httpAgent;
    const res = await fetch(`${baseUrl}/devices/`, {
      headers: { "Authorization": `Bearer ${apiToken}` },
      agent
    });
    console.log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Success! Got ${Array.isArray(data) ? data.length : (data.results?.length || 0)} devices`);
      return true;
    } else {
      const text = await res.text();
      console.log(`  ✗ Failed: ${text}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }

  console.log("\n❌ No authentication method worked");
  return false;
}

async function main() {
  loadEnv();
  const apiToken = process.env.POWERSHADES_API_TOKEN;
  const baseUrl = process.env.POWERSHADES_BASE_URL;

  if (!apiToken) {
    console.error("Set POWERSHADES_API_TOKEN in the environment or .env file");
    console.error("Get your API token from the PowerShades dashboard");
    process.exit(1);
  }

  console.log(`API Token: ${apiToken.substring(0, 10)}...${apiToken.substring(apiToken.length - 5)}`);
  console.log(`Base URL: ${baseUrl || "https://api.powershades.com"}`);

  const success = await testApiToken(apiToken, baseUrl);

  if (success) {
    console.log("\n\n=== Testing Additional Endpoints with Token ===\n");
    const base = baseUrl || "https://api.powershades.com";
    const agent = base.startsWith('https') ? httpsAgent : httpAgent;

    // Test /devices/
    console.log("Testing /devices/ endpoint:");
    try {
      const res = await fetch(`${base}/devices/`, {
        headers: { "Authorization": `Bearer ${apiToken}` },
        agent
      });
      console.log(`  Status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        const devices = Array.isArray(data) ? data : (data.results || []);
        console.log(`  ✓ Success! Got ${devices.length} devices`);
        if (devices.length > 0) {
          console.log("\n  First device:");
          console.log(JSON.stringify(devices[0], null, 4));
        }
      } else {
        const text = await res.text();
        console.log(`  ✗ Failed: ${text}`);
      }
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }

    // Test /shadeattributes/
    console.log("\nTesting /shadeattributes/ endpoint:");
    try {
      const res = await fetch(`${base}/shadeattributes/`, {
        headers: { "Authorization": `Bearer ${apiToken}` },
        agent
      });
      console.log(`  Status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        const attrs = Array.isArray(data) ? data : (data.results || []);
        console.log(`  ✓ Success! Got ${attrs.length} shade attributes`);
      } else {
        const text = await res.text();
        console.log(`  ✗ Failed: ${text}`);
      }
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }

    // Test individual shade detail
    console.log("\nTesting /shades/{id}/ endpoint:");
    try {
      const shadesRes = await fetch(`${base}/shades/`, {
        headers: { "Authorization": `Bearer ${apiToken}` },
        agent
      });
      if (shadesRes.ok) {
        const shadesData = await shadesRes.json();
        const shades = Array.isArray(shadesData) ? shadesData : (shadesData.results || []);
        if (shades.length > 0) {
          const shadeId = shades[0].id;
          const res = await fetch(`${base}/shades/${shadeId}/`, {
            headers: { "Authorization": `Bearer ${apiToken}` },
            agent
          });
          console.log(`  Status: ${res.status}`);
          if (res.ok) {
            const data = await res.json();
            console.log(`  ✓ Success! Got detailed shade info`);
            console.log("\n  Shade details:");
            console.log(JSON.stringify(data, null, 4));
          } else {
            const text = await res.text();
            console.log(`  ✗ Failed: ${text}`);
          }
        }
      }
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
