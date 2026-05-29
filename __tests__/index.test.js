"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeControlMode, resolveConfiguredControlMode } = require("../index");

test("normalizeControlMode preserves cloud and local UDP choices", () => {
  assert.equal(normalizeControlMode("cloud"), "cloud");
  assert.equal(normalizeControlMode("local-udp"), "local-udp");
  assert.equal(normalizeControlMode("udp"), "local-udp");
  assert.equal(normalizeControlMode("local"), "local-udp");
  assert.equal(normalizeControlMode("unexpected"), "cloud");
});

test("resolveConfiguredControlMode keeps existing cloud configs but defaults new configs to local UDP", () => {
  assert.equal(resolveConfiguredControlMode({}), "local-udp");
  assert.equal(resolveConfiguredControlMode({ email: "user@example.com", password: "secret" }), "cloud");
  assert.equal(resolveConfiguredControlMode({ apiToken: "token" }), "cloud");
  assert.equal(resolveConfiguredControlMode({ localGateways: [{ host: "192.168.1.50" }] }), "local-udp");
  assert.equal(resolveConfiguredControlMode({ controlMode: "cloud", localGateways: [{ host: "192.168.1.50" }] }), "cloud");
});
