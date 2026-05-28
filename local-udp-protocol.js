"use strict";

const dgram = require("dgram");

const DEFAULT_UDP_PORT = 42;
const DEFAULT_TIMEOUT_MS = 1200;
const MAX_CHANNEL = 30;
const MAX_PERCENT = 100;
const RENAME_NAME_BYTES = 50;

const COMMANDS = Object.freeze({
  up: 0x03,
  down: 0x04,
  stop: 0x05,
  p2: 0x16,
  "link-feedback": 0x21,
  link: 0x21,
});

class PowerShadesUdpProtocolError extends Error {}

function buildCommandPacket({ command, channel, sequence = nextSequence() }) {
  const commandCode = normalizeCommand(command);
  const packet = Buffer.alloc(8);
  packet.writeUInt16LE(0, 0);
  packet[4] = commandCode;
  packet[5] = normalizeSequence(sequence);
  packet.writeUInt16LE(normalizeChannel(channel), 6);
  writeChecksum(packet);
  return packet;
}

function buildSetPositionPacket({ channel, percent, sequence = nextSequence() }) {
  const packet = Buffer.alloc(18);
  packet.writeUInt16LE(10, 0);
  packet[4] = 0x1a;
  packet[5] = normalizeSequence(sequence);
  packet.writeUInt16LE(normalizeChannel(channel), 6);
  packet.writeUInt16LE(1, 8);
  packet.writeUInt16LE(normalizePercent(percent), 10);
  writeChecksum(packet);
  return packet;
}

function buildRenameChannelPacket({ channel, name, sequence = nextSequence() }) {
  const packet = Buffer.alloc(58);
  packet.writeUInt16LE(50, 0);
  packet[4] = 0x3b;
  packet[5] = normalizeSequence(sequence);
  packet.writeUInt16LE(normalizeChannel(channel), 6);
  writePaddedAscii(packet, 8, RENAME_NAME_BYTES, normalizeName(name));
  writeChecksum(packet);
  return packet;
}

function checksumPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 4) {
    throw new PowerShadesUdpProtocolError("Packet must be a Buffer of at least 4 bytes");
  }
  return crc16Ccitt(packet.subarray(4));
}

function writeChecksum(packet) {
  packet.writeUInt16LE(checksumPacket(packet), 2);
  return packet;
}

function crc16Ccitt(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function sendUdpPacket({
  host,
  packet,
  port = DEFAULT_UDP_PORT,
  localPort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  waitForResponse = true,
} = {}) {
  if (!host) {
    return Promise.reject(new PowerShadesUdpProtocolError("Missing gateway host"));
  }
  if (!Buffer.isBuffer(packet)) {
    return Promise.reject(new PowerShadesUdpProtocolError("Missing packet Buffer"));
  }

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let done = false;
    let timer = null;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(result);
    };

    socket.once("error", finish);
    socket.on("message", (message, rinfo) => {
      finish(null, { packet, response: message, rinfo });
    });

    const send = () => {
      socket.send(packet, port, host, (err) => {
        if (err) {
          finish(err);
          return;
        }

        if (!waitForResponse) {
          finish(null, { packet, response: null, rinfo: null });
          return;
        }

        timer = setTimeout(() => {
          finish(null, { packet, response: null, rinfo: null, timedOut: true });
        }, normalizeTimeout(timeoutMs));
        if (typeof timer.unref === "function") timer.unref();
      });
    };

    if (localPort !== undefined && localPort !== null && localPort !== "") {
      socket.bind(normalizePort(localPort, "localPort"), send);
    } else {
      send();
    }
  });
}

function packetToHex(packet) {
  return Buffer.from(packet).toString("hex").replace(/../g, "$& ").trim();
}

function nextSequence() {
  return Date.now() & 0xff;
}

function normalizeCommand(command) {
  if (typeof command === "number") {
    if (Number.isInteger(command) && command >= 0 && command <= 0xff) return command;
  }
  const key = String(command || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COMMANDS, key)) return COMMANDS[key];
  throw new PowerShadesUdpProtocolError(`Unknown command: ${command}`);
}

function normalizeChannel(channel) {
  const value = Number(channel);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHANNEL) {
    throw new PowerShadesUdpProtocolError(`Channel must be an integer from 1 to ${MAX_CHANNEL}`);
  }
  return value;
}

function normalizePercent(percent) {
  const value = Number(percent);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PERCENT) {
    throw new PowerShadesUdpProtocolError(`Percent must be an integer from 0 to ${MAX_PERCENT}`);
  }
  return value;
}

function normalizeSequence(sequence) {
  const value = Number(sequence);
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new PowerShadesUdpProtocolError("Sequence must be an integer from 0 to 255");
  }
  return value;
}

function normalizeName(name) {
  if (name === undefined || name === null || String(name).length === 0) {
    throw new PowerShadesUdpProtocolError("Name is required");
  }
  const value = String(name);
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new PowerShadesUdpProtocolError("Name must contain printable ASCII characters only");
  }
  if (Buffer.byteLength(value, "ascii") >= RENAME_NAME_BYTES) {
    throw new PowerShadesUdpProtocolError(`Name must be ${RENAME_NAME_BYTES - 1} ASCII bytes or fewer`);
  }
  return value;
}

function normalizePort(port, label = "port") {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new PowerShadesUdpProtocolError(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

function normalizeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_TIMEOUT_MS;
  return Math.round(value);
}

function writePaddedAscii(packet, offset, length, value) {
  packet.fill(0, offset, offset + length);
  packet.write(value, offset, length - 1, "ascii");
}

module.exports = {
  COMMANDS,
  DEFAULT_UDP_PORT,
  DEFAULT_TIMEOUT_MS,
  PowerShadesUdpProtocolError,
  buildCommandPacket,
  buildRenameChannelPacket,
  buildSetPositionPacket,
  checksumPacket,
  crc16Ccitt,
  nextSequence,
  packetToHex,
  sendUdpPacket,
};
