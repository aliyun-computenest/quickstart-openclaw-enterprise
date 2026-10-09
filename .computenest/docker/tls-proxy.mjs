import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const listenPort = Number(process.env.PORT ?? "8443");
const upstreamHost = process.env.UPSTREAM_HOST ?? "openclaw-enterprise-api";
const upstreamPort = Number(process.env.UPSTREAM_PORT ?? "8080");
const certificate = readFileSync(process.env.TLS_CERT_PATH ?? "/etc/openclaw/tls/tls.crt");
const privateKey = readFileSync(process.env.TLS_KEY_PATH ?? "/etc/openclaw/tls/tls.key");

const server = https.createServer({ cert: certificate, key: privateKey }, (request, response) => {
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`upstream unavailable: ${error.message}\n`);
  });
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const headers = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(listenPort, "0.0.0.0", () => {
  process.stdout.write(`TLS proxy listening on ${listenPort}, upstream ${upstreamHost}:${upstreamPort}\n`);
});
