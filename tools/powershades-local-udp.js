#!/usr/bin/env node
"use strict";

const http = require("http");
const { LocalPowerShadesApi } = require("../local-api");
const {
  DEFAULT_UDP_PORT,
  buildCommandPacket,
  buildRenameChannelPacket,
  buildSetPositionPacket,
  packetToHex,
  sendUdpPacket,
} = require("../local-udp-protocol");

const COMMAND_ALIASES = new Map([
  ["set-position", "set-position"],
  ["set", "set-position"],
  ["position", "set-position"],
  ["rename-channel", "rename-channel"],
  ["rename", "rename-channel"],
  ["up", "up"],
  ["down", "down"],
  ["stop", "stop"],
  ["p2", "p2"],
  ["link", "link-feedback"],
  ["link-feedback", "link-feedback"],
  ["discover", "discover"],
  ["status", "status"],
]);

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (!command || options.help) {
    printUsage(options.help ? 0 : 1);
    return;
  }

  if (command === "status") {
    const status = await readGatewayStatus(options);
    printResult(status, options);
    return;
  }

  if (command === "discover") {
    const discovery = await discoverGateway(options);
    printResult(discovery, { ...options, json: true });
    return;
  }

  const packet = buildPacket(command, options);
  const summary = {
    command,
    host: options.host,
    port: Number(options.port || DEFAULT_UDP_PORT),
    localPort: options.localPort === undefined ? null : Number(options.localPort),
    packetHex: packetToHex(packet),
  };

  if (options.dryRun) {
    printResult({ ...summary, dryRun: true }, options);
    return;
  }

  const result = await sendUdpPacket({
    host: requireHost(options),
    packet,
    port: options.port || DEFAULT_UDP_PORT,
    localPort: options.localPort,
    timeoutMs: options.timeoutMs,
    waitForResponse: options.waitForResponse,
  });

  printResult({
    ...summary,
    responseHex: result.response ? packetToHex(result.response) : null,
    responseFrom: result.rinfo ? `${result.rinfo.address}:${result.rinfo.port}` : null,
    timedOut: Boolean(result.timedOut),
  }, options);
}

function buildPacket(command, options) {
  if (command === "set-position") {
    return buildSetPositionPacket({
      channel: requireOption(options, "channel"),
      percent: requireOption(options, "percent"),
      sequence: options.sequence,
    });
  }
  if (command === "rename-channel") {
    return buildRenameChannelPacket({
      channel: requireOption(options, "channel"),
      name: requireOption(options, "name"),
      sequence: options.sequence,
    });
  }
  return buildCommandPacket({
    command,
    channel: requireOption(options, "channel"),
    sequence: options.sequence,
  });
}

function parseArgs(argv) {
  const options = {
    waitForResponse: true,
  };
  let command = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--no-wait") {
      options.waitForResponse = false;
      continue;
    }

    if (arg.startsWith("--")) {
      const [rawKey, rawValue] = arg.slice(2).split("=", 2);
      const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = rawValue === undefined ? argv[++i] : rawValue;
      if (value === undefined) throw new Error(`Missing value for --${rawKey}`);
      options[key] = value;
      continue;
    }

    if (!command) {
      command = COMMAND_ALIASES.get(arg.toLowerCase());
      if (!command) throw new Error(`Unknown command: ${arg}`);
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { command, options };
}

function requireHost(options) {
  return requireOption(options, "host");
}

function requireOption(options, key) {
  if (options[key] === undefined || options[key] === "") {
    throw new Error(`Missing required option --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return options[key];
}

async function readGatewayStatus(options) {
  const host = requireHost(options);
  const variables = ["percent", "battery", "rx", "rfdevs", "chnames1", "chnames2", "chnames3"];
  const values = {};
  for (const variable of variables) {
    values[variable] = await requestGatewayVariable(host, variable, options.timeoutMs);
  }
  return values;
}

async function discoverGateway(options) {
  const host = requireHost(options);
  const api = new LocalPowerShadesApi({
    gateways: [{
      host,
      serial: options.serial,
      includeChannels: splitChannelList(options.includeChannels),
      excludeChannels: splitChannelList(options.excludeChannels),
    }],
    requestTimeoutMs: options.timeoutMs,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });
  const shades = await api.getShades();
  return {
    host,
    channels: shades.map((shade) => ({
      channel: shade.channel,
      name: shade.name,
      percent: shade.current_position,
      batteryMillivolts: shade.batteryMillivolts,
      rx: shade.rx,
      rfDeviceId: shade.rfDeviceId,
    })),
    suggestedConfig: {
      host,
      ...(options.serial ? { serial: options.serial } : {}),
      shades: shades.map((shade) => ({
        channel: shade.channel,
        name: shade.name,
      })),
    },
  };
}

function requestGatewayVariable(host, variable, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      path: `/ajax.shtml?var=${encodeURIComponent(variable)}`,
      method: "GET",
      timeout: Number(timeoutMs) || 2500,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Gateway returned HTTP ${res.statusCode} for ${variable}`));
          return;
        }
        try {
          const parsed = JSON.parse(body.replace(/\n/g, "\\n").replace(/\r/g, "\\r"));
          resolve(Array.isArray(parsed) ? parsed[0] : parsed);
        } catch {
          resolve(body);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Gateway timed out reading ${variable}`)));
    req.on("error", reject);
    req.end();
  });
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}: ${value}`);
  }
}

function splitChannelList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => Number(item.trim())).filter(Number.isInteger);
}

function printUsage(exitCode) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node tools/powershades-local-udp.js status --host 192.168.1.50
  node tools/powershades-local-udp.js discover --host 192.168.1.50
  node tools/powershades-local-udp.js set-position --host 192.168.1.50 --channel 15 --percent 50
  node tools/powershades-local-udp.js up|down|stop|p2|link-feedback --host 192.168.1.50 --channel 15
  node tools/powershades-local-udp.js rename-channel --host 192.168.1.50 --channel 15 --name "Bedroom Window"

Options:
  --dry-run             Build and print the packet without sending it.
  --sequence N          Use an explicit sequence byte, 0-255.
  --port N              Gateway UDP port. Defaults to 42.
  --local-port N        Bind a local source UDP port before sending.
  --timeout-ms N        Response/status timeout in milliseconds.
  --no-wait             Do not wait for a UDP response.
  --json                Print JSON output.`);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  buildPacket,
  parseArgs,
};
