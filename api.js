// Lightweight PowerShades API client using global fetch (Node 18+).

const https = require('https');
const http = require('http');

const DEFAULT_BASE = "https://api.powershades.com";

// HTTP agent with keep-alive for connection reuse
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
});

class PowerShadesApiError extends Error {}

class PowerShadesApi {
  constructor({
    email,
    password,
    apiToken,
    baseUrl = DEFAULT_BASE,
    logger = console,
    maxAuthFailures = 3,
    authFailureBackoffMs = 60000,
    maxBackoffMs = 3600000
  }) {
    this.email = email;
    this.password = password;
    this.apiToken = apiToken;
    this.baseCandidates = dedupeCandidates(baseUrl);
    this.logger = logger;
    this.accessToken = apiToken || null; // Use API token directly if provided
    this.refreshToken = null;
    this.activeBase = null;

    // Auth failure tracking for circuit breaker
    this.consecutiveAuthFailures = 0;
    this.maxAuthFailures = maxAuthFailures;
    this.authFailureBackoffMs = authFailureBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.nextAuthRetryTime = 0;

    // Log authentication method
    if (this.apiToken) {
      this.logger.info?.("[PowerShades] Using API token authentication");
    } else {
      this.logger.info?.("[PowerShades] Using email/password authentication");
    }
  }

  async login() {
    // Check if we're in backoff period
    const now = Date.now();
    if (now < this.nextAuthRetryTime) {
      const waitSeconds = Math.ceil((this.nextAuthRetryTime - now) / 1000);
      throw new PowerShadesApiError(`Auth in backoff, retry in ${waitSeconds}s`);
    }

    // If using API token, skip login and set active base
    if (this.apiToken) {
      this.activeBase = this.baseCandidates[0];
      this.consecutiveAuthFailures = 0; // Reset on successful API token usage
      return { token: this.apiToken };
    }

    // Otherwise, use email/password authentication
    let lastError;
    for (const base of this.baseCandidates) {
      try {
        const data = await this.requestWithBase(base, "post", "/auth/jwt/", {
          json: { email: this.email, password: this.password },
          useAuth: false,
        });
        this.activeBase = base;
        this.accessToken = data.access || data.token;
        this.refreshToken = data.refresh;
        if (!this.accessToken) {
          throw new PowerShadesApiError("No access token returned");
        }
        // Reset failure tracking on successful login
        this.consecutiveAuthFailures = 0;
        this.nextAuthRetryTime = 0;
        return data;
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    // Track login failure
    this.handleAuthFailure();
    throw new PowerShadesApiError(`Login failed: ${lastError}`);
  }

  async refreshTokens() {
    if (!this.refreshToken) {
      throw new PowerShadesApiError("Missing refresh token");
    }

    try {
      const data = await this.request("post", "/auth/jwt/refresh/", {
        json: { refresh: this.refreshToken },
        useAuth: false,
      });
      this.accessToken = data.access || data.token || this.accessToken;
      // Reset failure tracking on successful refresh
      this.consecutiveAuthFailures = 0;
      this.nextAuthRetryTime = 0;
    } catch (err) {
      // Refresh failed - clear tokens and try re-login next time
      this.logger.warn?.("[PowerShades] Token refresh failed, clearing auth state");
      this.accessToken = this.apiToken || null; // Reset to API token if available
      this.refreshToken = null;
      this.handleAuthFailure();
      throw err;
    }
  }

  handleAuthFailure() {
    this.consecutiveAuthFailures++;

    if (this.consecutiveAuthFailures >= this.maxAuthFailures) {
      // Calculate exponential backoff
      const backoffMultiplier = Math.pow(2, this.consecutiveAuthFailures - this.maxAuthFailures);
      const backoffMs = Math.min(
        this.authFailureBackoffMs * backoffMultiplier,
        this.maxBackoffMs
      );
      this.nextAuthRetryTime = Date.now() + backoffMs;

      const backoffMinutes = Math.ceil(backoffMs / 60000);
      this.logger.error?.(
        `[PowerShades] Too many auth failures (${this.consecutiveAuthFailures}). ` +
        `Backing off for ${backoffMinutes} minute(s). Check your credentials.`
      );
    } else {
      this.logger.warn?.(
        `[PowerShades] Auth failure ${this.consecutiveAuthFailures}/${this.maxAuthFailures}`
      );
    }
  }

  async getShades() {
    const data = await this.request("get", "/shades/");
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.results)) return data.results;
    return [];
  }

  async getShadeAttributes() {
    const data = await this.request("get", "/shadeattributes/");
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.results)) return data.results;
    return [];
  }

  async moveShade(name, percentage) {
    return this.request("post", "/shades/move/", {
      json: { shade_name: name, percentage },
    });
  }

  async getScenes() {
    const data = await this.request("get", "/scenes/");
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.results)) return data.results;
    return [];
  }

  async getSchedules() {
    const data = await this.request("get", "/schedules/");
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.results)) return data.results;
    return [];
  }

  async request(method, path, options = {}) {
    const base = this.activeBase || this.baseCandidates[0];
    return this.requestWithBase(base, method, path, options);
  }

  async requestWithBase(baseUrl, method, path, { json, headers = {}, useAuth = true, retryOn401 = true } = {}) {
    const url = `${baseUrl}${path}`;
    const mergedHeaders = { ...headers };
    if (json) {
      mergedHeaders["Content-Type"] = "application/json";
    }
    if (useAuth) {
      if (!this.accessToken) {
        await this.login();
      }
      mergedHeaders["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const agent = url.startsWith('https') ? httpsAgent : httpAgent;
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: mergedHeaders,
      body: json ? JSON.stringify(json) : undefined,
      agent,
    });

    // Handle 401 with token refresh (only if using email/password auth)
    if (res.status === 401 && useAuth && retryOn401) {
      if (this.refreshToken) {
        // Try to refresh tokens
        try {
          await this.refreshTokens();
          mergedHeaders["Authorization"] = `Bearer ${this.accessToken}`;
          return this.requestWithBase(baseUrl, method, path, { json, headers: mergedHeaders, useAuth, retryOn401: false });
        } catch (refreshErr) {
          // Refresh failed, error already logged and backoff set
          throw new PowerShadesApiError(`API error ${res.status} on ${path}: Token refresh failed`);
        }
      } else if (!this.apiToken) {
        // No refresh token and not using API token - try re-login
        this.logger.info?.("[PowerShades] No refresh token, attempting re-login");
        this.accessToken = null;
        try {
          await this.login();
          mergedHeaders["Authorization"] = `Bearer ${this.accessToken}`;
          return this.requestWithBase(baseUrl, method, path, { json, headers: mergedHeaders, useAuth, retryOn401: false });
        } catch (loginErr) {
          // Login failed, error already logged and backoff set
          throw new PowerShadesApiError(`API error ${res.status} on ${path}: Re-login failed`);
        }
      } else {
        // Using API token that got 401 - this is a permanent failure
        this.handleAuthFailure();
        const text = await res.text();
        throw new PowerShadesApiError(`API error ${res.status} on ${path}: ${text}`);
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new PowerShadesApiError(`API error ${res.status} on ${path}: ${text}`);
    }
    if (res.status === 204) {
      return null;
    }
    return res.json();
  }
}

function dedupeCandidates(rawBase) {
  const trimmed = (rawBase || DEFAULT_BASE).replace(/\/+$/, "");
  const candidates = [trimmed, trimmed.endsWith("/api") ? trimmed.slice(0, -4) : `${trimmed}/api`];
  const seen = new Set();
  const ordered = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      ordered.push(c);
    }
  }
  return ordered;
}

module.exports = { PowerShadesApi, PowerShadesApiError, DEFAULT_BASE };
