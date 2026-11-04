const crypto = require("crypto");
const https = require("https");

/** Live by default; set BINGX_HOST=open-api-vst.bingx.com for BingX's demo (VST) exchange. */
function host() {
  return process.env.BINGX_HOST || "open-api.bingx.com";
}

function requestJson(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host(), path, method, headers: { Accept: "application/json", ...headers }, timeout: 15_000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let body = data;
          try {
            body = data ? JSON.parse(data) : null;
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("BingX did not answer in time")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * BingX signs the parameters sorted by key and joined as k=v&k=v with the raw
 * values, then expects the same string in the URL plus &signature=<hex>.
 * Values here are plain symbols, numbers and words, so no URL-encoding is needed.
 */
function signingString(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

class BingXClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  sign(payload) {
    return crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
  }

  call(method, path, params = {}) {
    const query = signingString({ ...params, timestamp: Date.now(), recvWindow: 10_000 });
    return requestJson(method, `${path}?${query}&signature=${this.sign(query)}`, { "X-BX-APIKEY": this.apiKey });
  }

  get(path, params) {
    return this.call("GET", path, params);
  }

  post(path, params) {
    return this.call("POST", path, params);
  }

  delete(path, params) {
    return this.call("DELETE", path, params);
  }
}

/** Public market data needs no key. */
function publicGet(path, params = {}) {
  const query = signingString(params);
  return requestJson("GET", query ? `${path}?${query}` : path);
}

/**
 * BingX answers HTTP 200 with `code != 0` for a refused request, so the code
 * decides. Returns a readable message, or null when the call succeeded.
 */
function bingxError(response) {
  if (!response) return "BingX did not answer";
  const body = response.body;
  if (response.status >= 400) {
    if (body && typeof body === "object" && body.msg) return `BingX: ${body.msg}`;
    return `BingX returned ${response.status}`;
  }
  if (!body || typeof body !== "object") return "BingX sent an unreadable reply";
  if (Number(body.code) !== 0) return `BingX: ${body.msg || `error ${body.code}`}`;
  return null;
}

/** BTC <-> BTC-USDT */
const symbolOf = (coin) => `${coin}-USDT`;
const coinOf = (symbol) => String(symbol || "").replace(/-USDT$/, "");

module.exports = { BingXClient, publicGet, bingxError, signingString, symbolOf, coinOf, requestJson };
