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
});
