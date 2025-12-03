// Tests for PowerShades API authentication and backoff logic

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PowerShadesApi, PowerShadesApiError } = require('../api.js');

describe('PowerShadesApi - Authentication and Backoff', () => {
  let mockLogger;
  let fetchResponses;
  let fetchCalls;

  beforeEach(() => {
    // Reset fetch mock before each test
    fetchResponses = [];
    fetchCalls = [];

    global.fetch = async (...args) => {
      fetchCalls.push(args);
      if (fetchResponses.length === 0) {
        throw new Error('No mock response configured');
      }
      const response = fetchResponses.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response;
    };

    // Mock logger to avoid console spam
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  });

  // Helper to add mock responses
  function mockFetch(response) {
    fetchResponses.push(response);
  }

  describe('Token Refresh Flow', () => {
    test('should successfully refresh tokens', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      // Mock successful login
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'access_token', refresh: 'refresh_token' }),
      });

      await api.login();
      assert.strictEqual(api.accessToken, 'access_token');
      assert.strictEqual(api.refreshToken, 'refresh_token');

      // Mock successful refresh
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'new_access_token' }),
      });

      await api.refreshTokens();
      assert.strictEqual(api.accessToken, 'new_access_token');
      assert.strictEqual(api.consecutiveAuthFailures, 0);
    });

    test('should clear tokens and enter backoff when refresh fails', async () => {
      const warnCalls = [];
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: {
          ...mockLogger,
          warn: (msg) => warnCalls.push(msg),
        },
        maxAuthFailures: 1, // Fail immediately for testing
      });

      // Mock successful login
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'access_token', refresh: 'refresh_token' }),
      });

      await api.login();

      // Mock failed refresh
      mockFetch({
        ok: false,
        status: 401,
        text: async () => 'Token is invalid',
      });

      await assert.rejects(api.refreshTokens());
      assert.strictEqual(api.refreshToken, null);
      assert.strictEqual(api.consecutiveAuthFailures, 1);
      assert.strictEqual(warnCalls.length, 1);
      assert.match(warnCalls[0], /Token refresh failed/);
    });

    test('should attempt re-login when refresh token is missing', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      // Mock successful initial login
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'initial_token', refresh: 'refresh_token' }),
      });

      await api.login();

      // Clear refresh token to simulate missing refresh token scenario
      api.refreshToken = null;
      api.accessToken = 'expired_token';

      // Mock 401 response, re-login, and retry
      mockFetch({ ok: false, status: 401, text: async () => 'Unauthorized' });
      mockFetch({ ok: true, status: 200, json: async () => ({ access: 'new_token', refresh: 'new_refresh' }) });
      mockFetch({ ok: true, status: 200, json: async () => ({ results: [] }) });

      const result = await api.getShades();
      assert.deepStrictEqual(result, []);
    });
  });

  describe('Exponential Backoff', () => {
    test('should enter backoff after max auth failures', async () => {
      const errorCalls = [];
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: {
          ...mockLogger,
          error: (msg) => errorCalls.push(msg),
        },
        maxAuthFailures: 3,
        authFailureBackoffMs: 60000,
      });

      // Simulate 3 consecutive login failures
      for (let i = 0; i < 3; i++) {
        mockFetch({ ok: false, status: 401, text: async () => 'Invalid credentials' });
        try {
          await api.login();
        } catch (err) {
          // Expected to fail
        }
      }

      assert.strictEqual(api.consecutiveAuthFailures, 3);
      assert.ok(api.nextAuthRetryTime > Date.now());
      assert.strictEqual(errorCalls.length, 1);
      assert.match(errorCalls[0], /Too many auth failures/);
    });

    test('should prevent login attempts during backoff period', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
        maxAuthFailures: 1,
        authFailureBackoffMs: 60000,
      });

      // Trigger backoff
      mockFetch({ ok: false, status: 401, text: async () => 'Invalid credentials' });

      await assert.rejects(api.login());

      // Attempt login during backoff - should not call fetch
      const callsBefore = fetchCalls.length;
      await assert.rejects(
        api.login(),
        (err) => err.message.includes('Auth in backoff')
      );
      assert.strictEqual(fetchCalls.length, callsBefore); // Should not make additional API calls
    });

    test('should calculate exponential backoff correctly', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
        maxAuthFailures: 3,
        authFailureBackoffMs: 60000, // 1 minute
        maxBackoffMs: 3600000, // 1 hour
      });

      // Test first backoff (3 failures = 1x multiplier)
      api.consecutiveAuthFailures = 2;
      const beforeFirst = Date.now();
      api.handleAuthFailure(); // This makes it 3 failures
      const firstBackoff = api.nextAuthRetryTime - beforeFirst;
      assert.ok(firstBackoff >= 60000, 'First backoff should be at least 60 seconds');
      assert.ok(firstBackoff < 120000, 'First backoff should be less than 120 seconds');

      // Test second backoff (4 failures = 2x multiplier)
      api.consecutiveAuthFailures = 3;
      const beforeSecond = Date.now();
      api.handleAuthFailure(); // This makes it 4 failures
      const secondBackoff = api.nextAuthRetryTime - beforeSecond;
      assert.ok(secondBackoff >= 120000, 'Second backoff should be at least 120 seconds');
      assert.ok(secondBackoff < 240000, 'Second backoff should be less than 240 seconds');
    });

    test('should cap backoff at maxBackoffMs', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
        maxAuthFailures: 2,
        authFailureBackoffMs: 60000,
        maxBackoffMs: 300000, // 5 minutes max
      });

      // Simulate many failures to trigger exponential growth
      const beforeTime = Date.now();
      api.consecutiveAuthFailures = 10; // Would normally be 2^8 * 60000 = 15.36 million ms
      api.handleAuthFailure();

      const backoff = api.nextAuthRetryTime - beforeTime;
      assert.ok(backoff <= 300000); // Should be capped at 5 minutes
    });

    test('should reset failure counter on successful auth', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
        maxAuthFailures: 3,
      });

      // Simulate 2 failures
      api.consecutiveAuthFailures = 2;

      // Mock successful login
      mockFetch({ ok: true, status: 200, json: async () => ({ access: 'access_token', refresh: 'refresh_token' }) });

      await api.login();
      assert.strictEqual(api.consecutiveAuthFailures, 0);
      assert.strictEqual(api.nextAuthRetryTime, 0);
    });
  });

  describe('API Token Authentication', () => {
    test('should not attempt refresh with API token', async () => {
      const api = new PowerShadesApi({
        apiToken: 'my_api_token',
        logger: mockLogger,
      });

      assert.strictEqual(api.accessToken, 'my_api_token');
      assert.strictEqual(api.refreshToken, null);

      // Mock 401 response
      mockFetch({ ok: false, status: 401, text: async () => 'Unauthorized' });

      await assert.rejects(api.getShades());
      assert.strictEqual(api.consecutiveAuthFailures, 1); // Should enter backoff, not refresh
    });

    test('should enter backoff on API token 401 errors', async () => {
      const api = new PowerShadesApi({
        apiToken: 'invalid_token',
        logger: mockLogger,
        maxAuthFailures: 1,
      });

      // Mock 401 response
      mockFetch({ ok: false, status: 401, text: async () => 'Invalid API token' });

      await assert.rejects(api.getShades());
      assert.strictEqual(api.consecutiveAuthFailures, 1);
      assert.ok(api.nextAuthRetryTime > Date.now());
    });
  });

  describe('Request Retry Logic', () => {
    test('should retry request after successful token refresh', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      // Mock successful login
      mockFetch({ ok: true, status: 200, json: async () => ({ access: 'initial_token', refresh: 'refresh_token' }) });
      await api.login();

      // Mock 401 on first request, successful refresh, successful retry
      mockFetch({ ok: false, status: 401, text: async () => 'Token expired' });
      mockFetch({ ok: true, status: 200, json: async () => ({ access: 'refreshed_token' }) });
      mockFetch({ ok: true, status: 200, json: async () => ({ results: [{ id: 1, name: 'Shade 1' }] }) });

      const shades = await api.getShades();
      assert.deepStrictEqual(shades, [{ id: 1, name: 'Shade 1' }]);
      assert.strictEqual(fetchCalls.length, 4); // login + 401 + refresh + retry
    });

    test('should not retry more than once', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      // Mock successful login
      mockFetch({ ok: true, status: 200, json: async () => ({ access: 'initial_token', refresh: 'refresh_token' }) });
      await api.login();

      // Mock 401, refresh, 401 again
      mockFetch({ ok: false, status: 401, text: async () => 'Token expired' });
      mockFetch({ ok: true, status: 200, json: async () => ({ access: 'refreshed_token' }) });
      mockFetch({ ok: false, status: 401, text: async () => 'Still unauthorized' });

      await assert.rejects(api.getShades());
      assert.strictEqual(fetchCalls.length, 4); // login + 401 + refresh + retry (no third attempt)
    });
  });

  describe('Error Handling', () => {
    test('should throw PowerShadesApiError on non-401 errors', async () => {
      const api = new PowerShadesApi({
        apiToken: 'valid_token',
        logger: mockLogger,
      });

      mockFetch({ ok: false, status: 500, text: async () => 'Internal Server Error' });

      await assert.rejects(
        api.getShades(),
        (err) => err instanceof PowerShadesApiError && err.message.includes('API error 500')
      );
    });

    test('should handle network errors gracefully', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      mockFetch(new Error('Network error'));

      await assert.rejects(
        api.login(),
        (err) => err.message.includes('Network error') || err.message.includes('Login failed')
      );
    });
  });

  describe('API Response Parsing', () => {
    test('should parse getShades with results array format', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: 1, name: 'Shade 1' }, { id: 2, name: 'Shade 2' }] }),
      });

      const shades = await api.getShades();
      assert.deepStrictEqual(shades, [{ id: 1, name: 'Shade 1' }, { id: 2, name: 'Shade 2' }]);
    });

    test('should parse getShades with direct array format', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'Shade 1' }, { id: 2, name: 'Shade 2' }],
      });

      const shades = await api.getShades();
      assert.deepStrictEqual(shades, [{ id: 1, name: 'Shade 1' }, { id: 2, name: 'Shade 2' }]);
    });

    test('should return empty array when getShades response is invalid', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      const shades = await api.getShades();
      assert.deepStrictEqual(shades, []);
    });

    test('should parse getScenes with results array format', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: 1, name: 'Morning' }] }),
      });

      const scenes = await api.getScenes();
      assert.deepStrictEqual(scenes, [{ id: 1, name: 'Morning' }]);
    });

    test('should parse getSchedules with direct array format', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, time: '08:00' }],
      });

      const schedules = await api.getSchedules();
      assert.deepStrictEqual(schedules, [{ id: 1, time: '08:00' }]);
    });

    test('should parse getShadeAttributes correctly', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: 1, battery: 85 }] }),
      });

      const attributes = await api.getShadeAttributes();
      assert.deepStrictEqual(attributes, [{ id: 1, battery: 85 }]);
    });
  });

  describe('Base URL Fallback Logic', () => {
    test('should dedupe /api suffix in baseUrl', () => {
      const api1 = new PowerShadesApi({
        apiToken: 'test',
        baseUrl: 'https://api.powershades.com',
        logger: mockLogger,
      });

      const api2 = new PowerShadesApi({
        apiToken: 'test',
        baseUrl: 'https://api.powershades.com/api',
        logger: mockLogger,
      });

      // Both should have the same candidates
      assert.strictEqual(api1.baseCandidates.length, 2);
      assert.strictEqual(api2.baseCandidates.length, 2);
    });

    test('should try multiple base URLs on login failure', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        baseUrl: 'https://api.powershades.com',
        logger: mockLogger,
      });

      // First base URL fails
      mockFetch({ ok: false, status: 404, text: async () => 'Not Found' });

      // Second base URL succeeds
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'token', refresh: 'refresh' })
      });

      await api.login();
      assert.strictEqual(api.accessToken, 'token');
      assert.strictEqual(fetchCalls.length, 2); // Tried both URLs
    });

    test('should fail after trying all base URLs', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        baseUrl: 'https://api.powershades.com',
        logger: mockLogger,
      });

      // Both base URLs fail
      mockFetch({ ok: false, status: 404, text: async () => 'Not Found' });
      mockFetch({ ok: false, status: 404, text: async () => 'Not Found' });

      await assert.rejects(
        api.login(),
        (err) => err.message.includes('Login failed')
      );
      assert.strictEqual(fetchCalls.length, 2); // Tried both URLs
    });

    test('should set activeBase on successful login', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'token', refresh: 'refresh' })
      });

      await api.login();
      assert.ok(api.activeBase, 'activeBase should be set');
      assert.ok(api.activeBase.startsWith('https://'), 'activeBase should be a URL');
    });
  });

  describe('Different Response Types', () => {
    test('should handle 204 No Content responses', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 204,
      });

      const result = await api.moveShade('Test Shade', 50);
      assert.strictEqual(result, null);
    });

    test('should handle empty response body correctly', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => null,
      });

      const shades = await api.getShades();
      assert.deepStrictEqual(shades, []);
    });

    test('should handle response with no results property', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ count: 0, data: [] }),
      });

      const shades = await api.getShades();
      assert.deepStrictEqual(shades, []);
    });
  });

  describe('Critical API Methods', () => {
    test('moveShade should send correct payload', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      await api.moveShade('Living Room', 75);

      // Verify the request was made with correct data
      assert.strictEqual(fetchCalls.length, 1);
      const [url, options] = fetchCalls[0];
      assert.ok(url.includes('/shades/move/'));

      // Parse the request body
      const body = JSON.parse(options.body);
      assert.strictEqual(body.shade_name, 'Living Room');
      assert.strictEqual(body.percentage, 75);
    });

    test('moveShade should handle API errors', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: false,
        status: 400,
        text: async () => 'Shade not found',
      });

      await assert.rejects(
        api.moveShade('NonExistent', 50),
        (err) => err.message.includes('API error 400')
      );
    });

    test('getScenes should call correct endpoint', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, name: 'Morning' }],
      });

      await api.getScenes();

      assert.strictEqual(fetchCalls.length, 1);
      const [url] = fetchCalls[0];
      assert.ok(url.includes('/scenes/'));
    });

    test('getSchedules should call correct endpoint', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      });

      await api.getSchedules();

      assert.strictEqual(fetchCalls.length, 1);
      const [url] = fetchCalls[0];
      assert.ok(url.includes('/schedules/'));
    });

    test('getShadeAttributes should call correct endpoint', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [{ id: 1, battery: 90 }],
      });

      await api.getShadeAttributes();

      assert.strictEqual(fetchCalls.length, 1);
      const [url] = fetchCalls[0];
      assert.ok(url.includes('/shadeattributes/'));
    });

    test('should include Authorization header in API calls', async () => {
      const api = new PowerShadesApi({
        apiToken: 'my_secret_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await api.getShades();

      const [, options] = fetchCalls[0];
      assert.ok(options.headers.Authorization);
      assert.strictEqual(options.headers.Authorization, 'Bearer my_secret_token');
    });

    test('should use correct HTTP agent based on protocol', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        baseUrl: 'https://api.powershades.com',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await api.getShades();

      const [, options] = fetchCalls[0];
      assert.ok(options.agent, 'Should include HTTP agent');
    });
  });

  describe('Group API Methods', () => {
    test('getGroups should call correct endpoint', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => [
          { id: 1, name: 'Living Room', shades: [1, 2, 3] },
          { id: 2, name: 'Bedroom', shades: [4, 5] },
        ],
      });

      const groups = await api.getGroups();

      assert.strictEqual(fetchCalls.length, 1);
      const [url] = fetchCalls[0];
      assert.ok(url.includes('/groups/'));
      assert.strictEqual(groups.length, 2);
      assert.strictEqual(groups[0].name, 'Living Room');
    });

    test('getGroups should handle results array format', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: 1, name: 'Test Group', shades: [] }],
        }),
      });

      const groups = await api.getGroups();
      assert.strictEqual(groups.length, 1);
    });

    test('getGroups should return empty array on null response', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => null,
      });

      const groups = await api.getGroups();
      assert.deepStrictEqual(groups, []);
    });

    test('moveGroup should send correct payload', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      await api.moveGroup(123, 75);

      assert.strictEqual(fetchCalls.length, 1);
      const [url, options] = fetchCalls[0];
      assert.ok(url.includes('/groups/123/move/'));

      const body = JSON.parse(options.body);
      assert.strictEqual(body.percentage, 75);
    });

    test('moveGroup should handle API errors', async () => {
      const api = new PowerShadesApi({
        apiToken: 'test_token',
        logger: mockLogger,
      });

      mockFetch({
        ok: false,
        status: 404,
        text: async () => 'Group not found',
      });

      await assert.rejects(
        api.moveGroup(999, 50),
        (err) => err.message.includes('API error 404')
      );
    });

    test('moveGroup should require authentication', async () => {
      const api = new PowerShadesApi({
        email: 'test@example.com',
        password: 'password123',
        logger: mockLogger,
      });

      // Mock login
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ access: 'token123', refresh: 'refresh123' }),
      });

      // Mock moveGroup
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      await api.moveGroup(123, 50);

      // Should have made login call + moveGroup call
      assert.strictEqual(fetchCalls.length, 2);
      const [, moveOptions] = fetchCalls[1];
      assert.ok(moveOptions.headers.Authorization);
    });
  });
});
