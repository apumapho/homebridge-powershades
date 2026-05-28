"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCommandPacket,
  buildRenameChannelPacket,
  buildSetPositionPacket,
  checksumPacket,
  crc16Ccitt,
} = require("../local-udp-protocol");

describe("PowerShades local UDP protocol", () => {
  test("buildSetPositionPacket matches captured Config.NET packets", () => {
    assert.equal(
      buildSetPositionPacket({ channel: 1, percent: 50, sequence: 0x63 }).toString("hex"),
      "0a0009c61a63010001003200000000000000"
    );
    assert.equal(
      buildSetPositionPacket({ channel: 5, percent: 50, sequence: 0x65 }).toString("hex"),
      "0a00b6441a65050001003200000000000000"
    );
    assert.equal(
      buildSetPositionPacket({ channel: 15, percent: 75, sequence: 0x35 }).toString("hex"),
      "0a0095fc1a350f0001004b00000000000000"
    );
  });

  test("buildCommandPacket matches captured movement and feedback packets", () => {
    assert.equal(
      buildCommandPacket({ command: "up", channel: 1, sequence: 0x67 }).toString("hex"),
      "000016b603670100"
    );
    assert.equal(
      buildCommandPacket({ command: "down", channel: 1, sequence: 0x68 }).toString("hex"),
      "00000acb04680100"
    );
    assert.equal(
      buildCommandPacket({ command: "stop", channel: 15, sequence: 0x71 }).toString("hex"),
      "0000434305710f00"
    );
    assert.equal(
      buildCommandPacket({ command: "p2", channel: 4, sequence: 0x72 }).toString("hex"),
      "0000924616720400"
    );
    assert.equal(
      buildCommandPacket({ command: "link-feedback", channel: 4, sequence: 0x74 }).toString("hex"),
      "0000f68921740400"
    );
  });

  test("buildRenameChannelPacket matches captured rename packet", () => {
    assert.equal(
      buildRenameChannelPacket({ channel: 15, name: "Bedroom Window", sequence: 0x33 }).toString("hex"),
      "320029773b330f00426564726f6f6d2057696e646f77000000000000000000000000000000000000000000000000000000000000000000000000"
    );
  });

  test("checksum is CRC-16/CCITT over bytes 4 through packet end", () => {
    const packet = Buffer.from("0a0009c61a63010001003200000000000000", "hex");

    assert.equal(crc16Ccitt(packet.subarray(4)), 0xc609);
    assert.equal(checksumPacket(packet), packet.readUInt16LE(2));
  });

  test("validates unsafe inputs before building packets", () => {
    assert.throws(() => buildSetPositionPacket({ channel: 0, percent: 50, sequence: 1 }), /Channel/);
    assert.throws(() => buildSetPositionPacket({ channel: 1, percent: 101, sequence: 1 }), /Percent/);
    assert.throws(() => buildCommandPacket({ command: "tilt", channel: 1, sequence: 1 }), /Unknown command/);
    assert.throws(() => buildRenameChannelPacket({ channel: 1, name: "Name\u2019", sequence: 1 }), /ASCII/);
  });
});
