const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  LocalPowerShadesApi,
  normalizeGatewayChannelName,
  parseChannelValues,
  parseGatewayJson,
} = require('../local-api.js');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('LocalPowerShadesApi', () => {
  test('parseGatewayJson should parse gateway array responses', () => {
    assert.deepStrictEqual(parseGatewayJson('["1:2:3"]'), ['1:2:3']);
  });

  test('parseChannelValues should pad to 30 channels', () => {
    const values = parseChannelValues('100:-1:0', Number);
    assert.strictEqual(values.length, 30);
    assert.strictEqual(values[0], 100);
    assert.strictEqual(values[1], -1);
    assert.strictEqual(values[2], 0);
    assert.strictEqual(values[29], 0);
  });

  test('getShades should decorate configured local shades with gateway status', async () => {
    const responses = {
      percent: '["100:-1:25"]',
      battery: '["12280:0:8080"]',
      rx: '["-71:0:-58"]',
      rfdevs: '["abc:0:def"]',
    };
    const calls = [];
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{
        host: '192.168.1.10',
        serial: 'gw1',
        discoverChannels: false,
        shades: [
          { name: 'Left', channel: 1 },
          { name: 'Right', channel: 2, assumePosition: 40 },
        ],
      }],
      requestFn: async (_gateway, query) => {
        calls.push(query);
        const variable = query.replace('var=', '');
        return responses[variable];
      },
    });

    const shades = await api.getShades();

    assert.deepStrictEqual(calls, ['var=percent', 'var=battery', 'var=rx', 'var=rfdevs']);
    assert.strictEqual(shades.length, 2);
    assert.strictEqual(shades[0].name, 'Left');
    assert.strictEqual(shades[0].current_position, 100);
    assert.strictEqual(shades[0].batteryMillivolts, 12280);
    assert.strictEqual(shades[0].effectivePowerSource, 'hardwired');
    assert.strictEqual(shades[0].batteryLevel, null);
    assert.strictEqual(shades[0].rx, -71);
    assert.strictEqual(shades[0].rfDeviceId, 'abc');
    assert.strictEqual(shades[1].current_position, 40);
    assert.strictEqual(shades[1].batteryMillivolts, null);
    assert.strictEqual(shades[1].rfDeviceId, null);
  });

  test('getShades should expose configured battery metadata for battery shades', async () => {
    const responses = {
      percent: '["50"]',
      battery: '["7700"]',
      rx: '["-65"]',
      rfdevs: '["abc"]',
    };
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{
        host: '192.168.1.10',
        serial: 'gw1',
        discoverChannels: false,
        shades: [
          {
            name: 'Battery Shade',
            channel: 1,
            powerSource: 'battery',
            batteryMinMillivolts: 7600,
            batteryMaxMillivolts: 7800,
            lowBatteryMillivolts: 7650,
          },
        ],
      }],
      requestFn: async (_gateway, query) => responses[query.replace('var=', '')],
    });

    const [shade] = await api.getShades();

    assert.strictEqual(shade.powerSource, 'battery');
    assert.strictEqual(shade.effectivePowerSource, 'battery');
    assert.strictEqual(shade.batteryMillivolts, 7700);
    assert.strictEqual(shade.batteryLevel, 50);
    assert.strictEqual(shade.batteryMinMillivolts, 7600);
    assert.strictEqual(shade.batteryMaxMillivolts, 7800);
    assert.strictEqual(shade.lowBatteryMillivolts, 7650);
    assert.strictEqual(shade.lowBattery, false);
  });

  test('UDP mode should discover named and linked gateway channels', async () => {
    const responses = {
      percent: '["100:-1:25"]',
      battery: '["12280:0:8080"]',
      rx: '["-71:0:-58"]',
      rfdevs: '["abc:0:def"]',
      chnames1: '["Kitchen Window:Channel 2:Kitchen Window"]',
      chnames2: '["Channel 11:Channel 12"]',
      chnames3: '["Channel 21"]',
    };
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{ host: '192.168.1.10', serial: 'gw1' }],
      requestFn: async (_gateway, query) => responses[query.replace('var=', '')],
    });

    const shades = await api.getShades();

    assert.deepStrictEqual(shades.map((shade) => [shade.channel, shade.name]), [
      [1, 'Kitchen Window'],
      [3, 'Kitchen Window'],
    ]);
    assert.strictEqual(shades[0].current_position, 100);
    assert.strictEqual(shades[1].current_position, 25);
    assert.strictEqual(shades[1].batteryMillivolts, 8080);
  });

  test('UDP mode should honor explicit channel overrides and exclusions', async () => {
    const responses = {
      percent: '["100:25:50"]',
      battery: '["12280:12290:12300"]',
      rx: '["-71:-72:-73"]',
      rfdevs: '["abc:def:ghi"]',
      chnames1: '["Kitchen Window:Dining Side:Dining Center"]',
      chnames2: '["Channel 11"]',
      chnames3: '["Channel 21"]',
    };
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{
        host: '192.168.1.10',
        serial: 'gw1',
        excludeChannels: [2],
        shades: [
          { channel: 1, name: 'Custom Door' },
          { channel: 3, enabled: false },
        ],
      }],
      requestFn: async (_gateway, query) => responses[query.replace('var=', '')],
    });

    const shades = await api.getShades();

    assert.deepStrictEqual(shades.map((shade) => [shade.channel, shade.name]), [
      [1, 'Custom Door'],
    ]);
  });

  test('UDP mode should send native set-position packets for percentage moves', async () => {
    const sent = [];
    const responses = {
      percent: '["20"]',
      battery: '["12280"]',
      rx: '["-71"]',
      rfdevs: '["abc"]',
      chnames1: '["Kitchen Window"]',
      chnames2: '["Channel 11"]',
      chnames3: '["Channel 21"]',
    };
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{ host: '192.168.1.10', serial: 'gw1' }],
      optimisticStatusHoldMs: 600000,
      requestFn: async (_gateway, query) => responses[query.replace('var=', '')],
      sendUdpFn: async (args) => {
        sent.push(args);
        return { packet: args.packet, response: args.packet, rinfo: { address: args.host, port: args.port } };
      },
    });
    const [shade] = await api.getShades();

    await api.moveShade(shade, 50);

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].host, '192.168.1.10');
    assert.strictEqual(sent[0].packet.length, 18);
    assert.strictEqual(sent[0].packet[4], 0x1a);
    assert.strictEqual(sent[0].packet.readUInt16LE(6), 1);
    assert.strictEqual(sent[0].packet.readUInt16LE(10), 50);
    assert.strictEqual(api.getState(shade).current_position, 50);

    shade.gateway.lastStatusRefresh = 0;
    await api.refreshShadeStates();
    assert.strictEqual(api.getState(shade).current_position, 50);
    assert.strictEqual(api.getState(shade).target_position, 50);
    assert.strictEqual(api.getState(shade).lastIgnoredPosition, 20);

    api.getState(shade).optimisticUntil = 0;
    shade.gateway.lastStatusRefresh = 0;
    await api.refreshShadeStates();
    assert.strictEqual(api.getState(shade).current_position, 20);
    assert.strictEqual(api.getState(shade).target_position, 20);
  });

  test('UDP mode should accept gateway feedback when it confirms the optimistic target', async () => {
    const sent = [];
    const responses = {
      percent: '["20"]',
      battery: '["12280"]',
      rx: '["-71"]',
      rfdevs: '["abc"]',
      chnames1: '["Kitchen Window"]',
      chnames2: '["Channel 11"]',
      chnames3: '["Channel 21"]',
    };
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{ host: '192.168.1.10', serial: 'gw1' }],
      requestFn: async (_gateway, query) => responses[query.replace('var=', '')],
      sendUdpFn: async (args) => {
        sent.push(args);
        return { packet: args.packet, response: args.packet, rinfo: { address: args.host, port: args.port } };
      },
    });
    const [shade] = await api.getShades();

    await api.moveShade(shade, 50);
    responses.percent = '["50"]';
    shade.gateway.lastStatusRefresh = 0;
    await api.refreshShadeStates();

    assert.strictEqual(api.getState(shade).current_position, 50);
    assert.strictEqual(api.getState(shade).target_position, 50);
    assert.strictEqual(api.getState(shade).optimisticUntil, 0);
  });

  test('UDP commands should not wait behind slow gateway status requests', async () => {
    let releaseStatus;
    const statusStarted = new Promise((resolve) => {
      releaseStatus = resolve;
    });
    const sent = [];
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{
        host: '192.168.1.10',
        serial: 'gw1',
        discoverChannels: false,
        shades: [{ name: 'Left', channel: 1 }],
      }],
      requestFn: async () => {
        await statusStarted;
        return '["0"]';
      },
      sendUdpFn: async (args) => {
        sent.push(args);
        return { packet: args.packet, response: args.packet, rinfo: { address: args.host, port: args.port } };
      },
    });
    const [shade] = api.shades;

    const statusPromise = api.refreshShadeStates();
    await Promise.resolve();
    await api.moveShade(shade, 75);
    releaseStatus();
    await statusPromise;

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].packet.readUInt16LE(10), 75);
  });

  test('UDP mode should send native stop packets', async () => {
    const sent = [];
    const api = new LocalPowerShadesApi({
      logger: silentLogger,
      gateways: [{
        host: '192.168.1.10',
        serial: 'gw1',
        discoverChannels: false,
        shades: [{ name: 'Left', channel: 5 }],
      }],
      requestFn: async () => '["0:0:0"]',
      sendUdpFn: async (args) => {
        sent.push(args);
        return { packet: args.packet, response: args.packet, rinfo: { address: args.host, port: args.port } };
      },
    });

    await api.stopShade('Left');

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].packet[4], 0x05);
    assert.strictEqual(sent[0].packet.readUInt16LE(6), 5);
  });

  test('normalizeGatewayChannelName should ignore default channel names', () => {
    assert.strictEqual(normalizeGatewayChannelName('Channel 4', 4), null);
    assert.strictEqual(normalizeGatewayChannelName("Guest Bath", 4), "Guest Bath");
  });
});
