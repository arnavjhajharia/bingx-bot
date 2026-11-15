const test = require("node:test");
const { mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const https = require("https");
const { EventEmitter } = require("events");
const { BingXClient, publicGet, bingxError, signingString, symbolOf, coinOf, requestJson, proxied } = require("./bingx");

const SECRET = "test-secret-0000";
const API_KEY = "test-key-0000";
const NOW = 1_700_000_000_000;

afterEach(() => {
  mock.restoreAll();
});

/**
 * Replace https.request with a fake. `reply` decides what happens once the
 * request is sent: { status, chunks } answers with a response, { error }
 * emits 'error', { timeout: true } emits 'timeout'. Every call is recorded.
 */
function fakeHttps(reply = { status: 200, chunks: ['{"code":0}'] }) {
  const calls = [];
  mock.method(https, "request", (options, onResponse) => {
    const req = new EventEmitter();
    const call = { options, req, destroyedWith: undefined, ended: false };
    calls.push(call);
    req.destroy = (err) => {
      call.destroyedWith = err;
      if (err) process.nextTick(() => req.emit("error", err));
    };
    req.end = () => {
      call.ended = true;
      process.nextTick(() => {
        if (reply.error) return req.emit("error", reply.error);
        if (reply.timeout) return req.emit("timeout");
        const res = new EventEmitter();
        res.statusCode = reply.status;
        onResponse(res);
        for (const chunk of reply.chunks || []) res.emit("data", chunk);
        res.emit("end");
      });
    };
    return req;
  });
  return calls;
}

function hmac(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

// (a) signingString

test("signingString sorts keys, drops empty values and joins k=v with &", () => {
  const out = signingString({ symbol: "BTC-USDT", b: undefined, a: 1, c: null, d: "", side: "BUY", zero: 0 });
  assert.equal(out, "a=1&side=BUY&symbol=BTC-USDT&zero=0");
  assert.equal(signingString({}), "");
});

// (b) sign

test("BingXClient.sign is the HMAC-SHA256 hex of the payload", () => {
  const client = new BingXClient(API_KEY, SECRET);
  const payload = "recvWindow=10000&symbol=BTC-USDT&timestamp=1";
  assert.equal(client.sign(payload), hmac(payload));
  assert.match(client.sign(payload), /^[0-9a-f]{64}$/);
});

// (c) signed calls

for (const method of ["GET", "POST", "DELETE"]) {
  test(`client.${method.toLowerCase()} sends a signed ${method} request`, async () => {
    const calls = fakeHttps({ status: 200, chunks: ['{"code":0,"data":{"ok":true}}'] });
    mock.method(Date, "now", () => NOW);
    const saved = process.env.BINGX_HOST;
    delete process.env.BINGX_HOST;
    try {
      const client = new BingXClient(API_KEY, SECRET);
      const result = await client[method.toLowerCase()]("/openApi/swap/v2/trade/order", { symbol: "BTC-USDT", quantity: 2 });
      assert.deepEqual(result, { status: 200, body: { code: 0, data: { ok: true } } });

      assert.equal(calls.length, 1);
      const { options } = calls[0];
      assert.equal(options.method, method);
      assert.equal(options.hostname, "open-api.bingx.com");
      assert.equal(options.headers["X-BX-APIKEY"], API_KEY);
      assert.equal(options.headers.Accept, "application/json");

      const query = `quantity=2&recvWindow=10000&symbol=BTC-USDT&timestamp=${NOW}`;
      assert.equal(options.path, `/openApi/swap/v2/trade/order?${query}&signature=${hmac(query)}`);

      const [pathname, rest] = options.path.split("?");
      assert.equal(pathname, "/openApi/swap/v2/trade/order");
      const signed = rest.replace(/&signature=[0-9a-f]+$/, "");
      const signature = rest.slice(signed.length + "&signature=".length);
      assert.equal(signature, hmac(signed));
    } finally {
      if (saved === undefined) delete process.env.BINGX_HOST;
      else process.env.BINGX_HOST = saved;
    }
  });
}

test("signed calls work with no params", async () => {
  const calls = fakeHttps();
  mock.method(Date, "now", () => NOW);
  await new BingXClient(API_KEY, SECRET).get("/openApi/swap/v2/user/balance");
  const query = `recvWindow=10000&timestamp=${NOW}`;
  assert.equal(calls[0].options.path, `/openApi/swap/v2/user/balance?${query}&signature=${hmac(query)}`);
});

test("BINGX_HOST overrides the default host", async () => {
  const calls = fakeHttps();
  const saved = process.env.BINGX_HOST;
  process.env.BINGX_HOST = "open-api-vst.bingx.com";
  try {
    await new BingXClient(API_KEY, SECRET).get("/x");
    await publicGet("/y");
    assert.equal(calls[0].options.hostname, "open-api-vst.bingx.com");
    assert.equal(calls[1].options.hostname, "open-api-vst.bingx.com");
  } finally {
    if (saved === undefined) delete process.env.BINGX_HOST;
    else process.env.BINGX_HOST = saved;
  }
});

// (d) publicGet

test("publicGet sends no API key and omits '?' without params", async () => {
  const calls = fakeHttps({ status: 200, chunks: ['{"code":0,"data":[]}'] });
  const result = await publicGet("/openApi/swap/v2/quote/contracts");
  assert.deepEqual(result, { status: 200, body: { code: 0, data: [] } });
  const { options } = calls[0];
  assert.equal(options.method, "GET");
  assert.equal(options.path, "/openApi/swap/v2/quote/contracts");
  assert.equal("X-BX-APIKEY" in options.headers, false);
});

test("publicGet appends sorted params unsigned", async () => {
  const calls = fakeHttps();
  await publicGet("/openApi/swap/v3/quote/klines", { symbol: "ETH-USDT", interval: "1d", limit: 5, startTime: undefined });
  const { options } = calls[0];
  assert.equal(options.path, "/openApi/swap/v3/quote/klines?interval=1d&limit=5&symbol=ETH-USDT");
  assert.doesNotMatch(options.path, /signature=/);
  assert.equal("X-BX-APIKEY" in options.headers, false);
});

// (e) requestJson

test("requestJson parses JSON split across chunks", async () => {
  fakeHttps({ status: 200, chunks: ['{"code":0,', '"data":{"a":1}}'] });
  assert.deepEqual(await requestJson("GET", "/p"), { status: 200, body: { code: 0, data: { a: 1 } } });
});

test("requestJson returns the raw string for a non-JSON body", async () => {
  fakeHttps({ status: 502, chunks: ["<html>Bad Gateway</html>"] });
  assert.deepEqual(await requestJson("GET", "/p"), { status: 502, body: "<html>Bad Gateway</html>" });
});

test("requestJson returns null for an empty body", async () => {
  fakeHttps({ status: 204, chunks: [] });
  assert.deepEqual(await requestJson("GET", "/p"), { status: 204, body: null });
});

test("requestJson passes the method, a timeout and extra headers", async () => {
  const calls = fakeHttps();
  await requestJson("POST", "/p", { "X-Test": "1" });
  const { options, ended } = calls[0];
  assert.equal(options.method, "POST");
  assert.equal(options.timeout, 15_000);
  assert.deepEqual(options.headers, { Accept: "application/json", "X-Test": "1" });
  assert.equal(ended, true);
});

test("requestJson rejects on a request error", async () => {
  fakeHttps({ error: new Error("ECONNRESET") });
  await assert.rejects(requestJson("GET", "/p"), { message: "ECONNRESET" });
});

test("a timeout destroys the request and rejects", async () => {
  const calls = fakeHttps({ timeout: true });
  await assert.rejects(requestJson("GET", "/p"), { message: "BingX did not answer in time" });
  assert.ok(calls[0].destroyedWith instanceof Error);
  assert.equal(calls[0].destroyedWith.message, "BingX did not answer in time");
});

// (f) bingxError

test("bingxError with no response", () => {
  assert.equal(bingxError(null), "BingX did not answer");
  assert.equal(bingxError(undefined), "BingX did not answer");
});

test("bingxError for HTTP errors", () => {
  assert.equal(bingxError({ status: 400, body: { code: 100001, msg: "signature verification failed" } }), "BingX: signature verification failed");
  assert.equal(bingxError({ status: 500, body: { code: 1 } }), "BingX returned 500");
  assert.equal(bingxError({ status: 503, body: "Service Unavailable" }), "BingX returned 503");
  assert.equal(bingxError({ status: 404, body: null }), "BingX returned 404");
});

test("bingxError for an unreadable body", () => {
  assert.equal(bingxError({ status: 200, body: "<html>" }), "BingX sent an unreadable reply");
  assert.equal(bingxError({ status: 200, body: null }), "BingX sent an unreadable reply");
  assert.equal(bingxError({ status: 200, body: 42 }), "BingX sent an unreadable reply");
});

test("bingxError for a non-zero code", () => {
  assert.equal(bingxError({ status: 200, body: { code: 80014, msg: "Invalid parameters" } }), "BingX: Invalid parameters");
  assert.equal(bingxError({ status: 200, body: { code: 80014 } }), "BingX: error 80014");
  assert.equal(bingxError({ status: 200, body: { code: "101204", msg: "" } }), "BingX: error 101204");
});

test("bingxError treats code 0 (number or string) as success", () => {
  assert.equal(bingxError({ status: 200, body: { code: 0, data: {} } }), null);
  assert.equal(bingxError({ status: 200, body: { code: "0" } }), null);
});

// (g) symbolOf / coinOf

test("symbolOf and coinOf round trip", () => {
  for (const coin of ["BTC", "ETH", "1000PEPE"]) {
    assert.equal(symbolOf(coin), `${coin}-USDT`);
    assert.equal(coinOf(symbolOf(coin)), coin);
  }
  assert.equal(coinOf("BTC"), "BTC");
  assert.equal(coinOf(undefined), "");
  assert.equal(coinOf(null), "");
});

// (h) proxied

test("proxied() is false when BINGX_PROXY_URL is unset", () => {
  if (!process.env.BINGX_PROXY_URL) {
    assert.equal(proxied(), false);
    return;
  }
  // The agent is created at load time, so load a fresh copy without the variable.
  const saved = process.env.BINGX_PROXY_URL;
  const key = require.resolve("./bingx");
  const cached = require.cache[key];
  delete process.env.BINGX_PROXY_URL;
  delete require.cache[key];
  try {
    assert.equal(require("./bingx").proxied(), false);
  } finally {
    process.env.BINGX_PROXY_URL = saved;
    require.cache[key] = cached;
  }
});
