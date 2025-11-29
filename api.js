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
  constructor({ email, password, baseUrl = DEFAULT_BASE, logger = console }) {
    this.email = email;
    this.password = password;
    this.baseCandidates = dedupeCandidates(baseUrl);
    this.logger = logger;
    this.accessToken = null;
    this.refreshToken = null;
    this.activeBase = null;
  }

  async login() {
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
        return data;
      } catch (err) {
        lastError = err;
        continue;
      }
    }
    throw new PowerShadesApiError(`Login failed: ${lastError}`);
  }

  async refreshTokens() {
    if (!this.refreshToken) {
      throw new PowerShadesApiError("Missing refresh token");
    }
    const data = await this.request("post", "/auth/jwt/refresh/", {
      json: { refresh: this.refreshToken },
      useAuth: false,
    });
    this.accessToken = data.access || data.token || this.accessToken;
  }

  async getShades() {
    const data = await this.request("get", "/shades/");
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

    if (res.status === 401 && useAuth && retryOn401 && this.refreshToken) {
      await this.refreshTokens();
      mergedHeaders["Authorization"] = `Bearer ${this.accessToken}`;
      return this.requestWithBase(baseUrl, method, path, { json, headers: mergedHeaders, useAuth, retryOn401: false });
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
