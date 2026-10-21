// OCE 计算巢定制入口代理（打进 controller 镜像，由 chart 的 tls-proxy 容器运行）。
// 主端口：反代 api 控制台（SSL 终结或 http 明文，视 PROXY_PROTOCOL）。
// 聊天端口（CHAT_PORT，一期固定经 SLB 8080 暴露）：按路由 ConfigMap 把网页聊天
// 反代到当前默认 Agent 的 gateway ClusterIP，支持 HTTP 与 WebSocket 升级。
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const listenPort = Number(process.env.PORT ?? "8443");
const upstreamHost = process.env.UPSTREAM_HOST ?? "openclaw-enterprise-api";
const upstreamPort = Number(process.env.UPSTREAM_PORT ?? "8080");
// https（默认）：自签证书终结 TLS；http：明文监听，供无证书的 IP 直连场景使用。
const protocol = process.env.PROXY_PROTOCOL === "http" ? "http" : "https";
// 聊天端口：0（默认）表示禁用；路由表来自 ConfigMap 挂载文件，格式 {"default":"gateway-xxx","namespace":"oce-xxx"}。
const chatPort = Number(process.env.CHAT_PORT ?? "0");
const chatRoutesFile = process.env.CHAT_ROUTES_FILE ?? "";
// 聊天流量的 Origin 哨兵：gateway controlUi 校验 Origin 白名单，而外部入口（SLB IP/域名）
// 在配置生成时不可预知（OCC_AUTH_BASE_URL 可能为空），统一改写为 controller 补丁写入
// gateway 默认白名单的哨兵值，保证任意部署形态下聊天页可用。
const chatOriginSentinel = process.env.CHAT_ORIGIN_SENTINEL ?? "http://localhost:18789";

function tlsOptions() {
  return {
    cert: readFileSync(process.env.TLS_CERT_PATH ?? "/etc/openclaw/tls/tls.crt"),
    key: readFileSync(process.env.TLS_KEY_PATH ?? "/etc/openclaw/tls/tls.key"),
  };
}

// 上游 production 模式会给会话 Cookie 强制加 Secure，浏览器在 http 页面会丢弃它导致登录后回跳。
// http 模式下去掉 Secure；带 __Secure-/__Host- 前缀的 Cookie 规范上必须 Secure，保持原样。
function relaxCookie(cookie) {
  if (/^\s*__(Secure|Host)-/i.test(cookie)) return cookie;
  return cookie.replace(/;\s*Secure\s*(?=;|$)/gi, "");
}

function responseHeaders(headers) {
  if (protocol !== "http" || headers["set-cookie"] === undefined) return headers;
  return { ...headers, "set-cookie": headers["set-cookie"].map(relaxCookie) };
}

// crypto.randomUUID 只在安全上下文（https/localhost）可用，控制台创建 Agent 时会调用；
// http 模式下以同源脚本补齐（CSP script-src 'self' 允许），并注入到控制台 HTML 中先于模块脚本执行。
const compatPath = "/console/oce-http-compat.js";
const compatScript = `if (globalThis.crypto && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = function () {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  };
}
`;

function isConsolePage(request) {
  return protocol === "http" && request.method === "GET" && (request.url ?? "").startsWith("/console");
}

function injectCompat(upstreamResponse, response) {
  const chunks = [];
  upstreamResponse.on("data", (chunk) => chunks.push(chunk));
  upstreamResponse.on("end", () => {
    const html = Buffer.concat(chunks)
      .toString("utf8")
      .replace("<script type=\"module\"", `<script src="${compatPath}"></script>\n    <script type="module"`);
    const body = Buffer.from(html, "utf8");
    const headers = { ...responseHeaders(upstreamResponse.headers), "content-length": String(body.length) };
    delete headers["transfer-encoding"];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    response.end(body);
  });
}

function handle(request, response) {
  if (protocol === "http" && request.url === compatPath) {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : compatScript);
    return;
  }
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      const html = String(upstreamResponse.headers["content-type"] ?? "").startsWith("text/html");
      if (html && isConsolePage(request) && upstreamResponse.headers["content-encoding"] === undefined) {
        injectCompat(upstreamResponse, response);
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`upstream unavailable: ${error.message}\n`);
  });
  request.pipe(upstream);
}

// ---- 聊天路由（一期：单默认 Agent，路由表 {"default":"<svc 名>","namespace":"<ns>"}）----

let routeCache = { at: 0, host: undefined };
function chatUpstream() {
  if (chatRoutesFile === "") return undefined;
  const now = Date.now();
  if (now - routeCache.at < 5000) return routeCache.host;
  routeCache.at = now;
  routeCache.host = undefined;
  try {
    const routes = JSON.parse(readFileSync(chatRoutesFile, "utf8"));
    const name = routes.default;
    const namespace = routes.namespace;
    if (typeof name === "string" && name.length > 0 && typeof namespace === "string" && namespace.length > 0) {
      routeCache.host = `${name}.${namespace}.svc`;
    }
  } catch {
    routeCache.host = undefined;
  }
  return routeCache.host;
}

function chatUnavailable(response, message) {
  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

// 聊天请求头：改写 Origin 为哨兵值（gateway 只在 WS 握手强校验，普通请求一并处理保持一致）。
function chatRequestHeaders(request) {
  const headers = { ...request.headers };
  if (typeof headers.origin === "string" && headers.origin !== "") {
    headers.origin = chatOriginSentinel;
  }
  return headers;
}

function chatHandle(request, response) {
  const target = chatUpstream();
  if (target === undefined) {
    chatUnavailable(response, "chat is not ready: no deployed agent to chat with yet\n");
    return;
  }
  const upstream = http.request(
    {
      host: target,
      port: 8080,
      method: request.method,
      path: request.url,
      headers: chatRequestHeaders(request),
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`gateway unavailable: ${error.message}\n`);
  });
  request.pipe(upstream);
}

const server =
  protocol === "http"
    ? http.createServer(handle)
    : https.createServer(tlsOptions(), handle);

function pipeUpgrade(request, socket, head, host, port, onFail, headerOverrides) {
  const headers = { ...request.headers, ...(headerOverrides ?? {}) };
  const upstream = net.connect(port, host, () => {
    const raw = Object.entries(headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${raw}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => onFail(socket));
}

server.on("upgrade", (request, socket, head) => {
  pipeUpgrade(request, socket, head, upstreamHost, upstreamPort, (s) => s.destroy());
});

const chatServer =
  chatPort > 0
    ? protocol === "http"
      ? http.createServer(chatHandle)
      : https.createServer(tlsOptions(), chatHandle)
    : undefined;

if (chatServer !== undefined) {
  chatServer.on("upgrade", (request, socket, head) => {
    const target = chatUpstream();
    if (target === undefined) {
      socket.destroy();
      return;
    }
    pipeUpgrade(request, socket, head, target, 8080, (s) => s.destroy(), chatRequestHeaders(request));
  });
  chatServer.listen(chatPort, "0.0.0.0", () => {
    process.stdout.write(
      `${protocol.toUpperCase()} chat proxy listening on ${chatPort}, routes ${chatRoutesFile}\n`,
    );
  });
}

server.listen(listenPort, "0.0.0.0", () => {
  process.stdout.write(
    `${protocol.toUpperCase()} proxy listening on ${listenPort}, upstream ${upstreamHost}:${upstreamPort}\n`,
  );
});
