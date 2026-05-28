"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeControlMode } = require("../index");

test("normalizeControlMode preserves cloud and local UDP choices", () => {
  assert.equal(normalizeControlMode("cloud"), "cloud");
  assert.equal(normalizeControlMode("local-udp"), "local-udp");
  assert.equal(normalizeControlMode("udp"), "local-udp");
  assert.equal(normalizeControlMode("local"), "local-udp");
  assert.equal(normalizeControlMode("unexpected"), "cloud");
});
