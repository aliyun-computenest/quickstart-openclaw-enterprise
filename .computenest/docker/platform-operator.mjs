import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import process from "node:process";

const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const namespacePath = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
const apiHost = process.env.KUBERNETES_SERVICE_HOST;
const apiPort = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function client() {
  const [token, ca, namespace] = await Promise.all([
    readFile(tokenPath, "utf8"),
    readFile(caPath),
    readFile(namespacePath, "utf8"),
  ]);
  return { token: token.trim(), ca, namespace: namespace.trim() };
}

async function request(context, method, path, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: apiHost,
        port: apiPort,
        method,
        path,
        ca: context.ca,
        headers: {
          Authorization: `Bearer ${context.token}`,
          Accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json", "Content-Length": payload.length }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const value = text.length === 0 ? undefined : JSON.parse(text);
          if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
            resolve(value);
          } else {
            const error = new Error(`Kubernetes API ${method} ${path} failed: ${response.statusCode} ${text}`);
            error.statusCode = response.statusCode;
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function getOptional(context, path) {
  try {
    return await request(context, "GET", path);
  } catch (error) {
    if (error.statusCode === 404) return undefined;
    throw error;
  }
}

async function upsert(context, kind, name, body) {
  const plural = kind === "configmap" ? "configmaps" : "secrets";
  const base = `/api/v1/namespaces/${context.namespace}/${plural}`;
  const current = await getOptional(context, `${base}/${name}`);
  if (current === undefined) {
    return request(context, "POST", base, body);
  }
  body.metadata.resourceVersion = current.metadata.resourceVersion;
  return request(context, "PUT", `${base}/${name}`, body);
}

const ipv4Pattern = /^\d{1,3}(\.\d{1,3}){3}$/;

// OCC_AUTH_BASE_URL 只信任单一 origin，用户必须用这里生成的 host 访问才能登录。
// ip（默认）：直接用 SLB 公网 IP；domain：用户自有域名（需自行解析到 SLB）；sslip：openclaw-<ip>.sslip.io。
function endpointHost(ingress) {
  const address = ingress.ip ?? ingress.hostname;
  if (!address) return undefined;
  const mode = process.env.OCE_ENDPOINT_MODE ?? "ip";
  const domain = process.env.OCE_ENDPOINT_DOMAIN?.trim().toLowerCase();
  if (mode === "domain") {
    if (domain) return domain;
    process.stdout.write("Endpoint mode is domain but no domain is set; falling back to the load balancer address\n");
  }
  if (mode === "sslip" && ingress.ip) {
    return `openclaw-${ingress.ip.replaceAll(".", "-")}.sslip.io`;
  }
  return address;
}

async function waitForEndpoint(context, serviceName) {
  const path = `/api/v1/namespaces/${context.namespace}/services/${serviceName}`;
  for (;;) {
    const service = await request(context, "GET", path);
    const ingress = service.status?.loadBalancer?.ingress?.[0];
    const host = ingress === undefined ? undefined : endpointHost(ingress);
    if (host) return { host, address: ingress.ip ?? ingress.hostname };
    process.stdout.write(`Waiting for LoadBalancer address on ${serviceName}\n`);
    await sleep(10_000);
  }
}

async function reconcileEndpoint(context) {
  const serviceName = process.env.OCE_SERVICE_NAME ?? "openclaw-enterprise";
  const configMapName = process.env.OCE_ENDPOINT_CONFIGMAP ?? "openclaw-enterprise-endpoint";
  const tlsSecretName = process.env.OCE_TLS_SECRET ?? "openclaw-enterprise-tls";
  const { host, address } = await waitForEndpoint(context, serviceName);
  // http：tls-proxy 明文监听并放宽会话 Cookie，免自签证书告警；https：自签证书。
  const protocol = process.env.OCE_ENDPOINT_PROTOCOL === "http" ? "http" : "https";
  const baseUrl = `${protocol}://${host}`;
  const existing = await getOptional(
    context,
    `/api/v1/namespaces/${context.namespace}/configmaps/${configMapName}`,
  );
  if (existing?.data?.["base-url"] === baseUrl && existing?.data?.address === address) return baseUrl;

  const subjectAltName = ipv4Pattern.test(host) ? `IP:${host}` : `DNS:${host}`;
  const config = `[req]\ndistinguished_name=req_distinguished_name\nx509_extensions=v3\nprompt=no\n[req_distinguished_name]\nCN=${host}\n[v3]\nsubjectAltName=${subjectAltName}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`;
  await writeFile("/tmp/openssl.cnf", config, "utf8");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
    "-keyout", "/tmp/tls.key", "-out", "/tmp/tls.crt", "-config", "/tmp/openssl.cnf",
  ]);
  const [certificate, privateKey] = await Promise.all([
    readFile("/tmp/tls.crt"),
    readFile("/tmp/tls.key"),
  ]);
  await upsert(context, "secret", tlsSecretName, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: tlsSecretName, namespace: context.namespace },
    type: "kubernetes.io/tls",
    data: {
      "tls.crt": certificate.toString("base64"),
      "tls.key": privateKey.toString("base64"),
    },
  });
  await upsert(context, "configmap", configMapName, {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: configMapName, namespace: context.namespace },
    data: { "base-url": baseUrl, host, address },
  });
  process.stdout.write(`Configured public endpoint ${baseUrl}\n`);
  return baseUrl;
}

async function reconcileBootstrap(context) {
  const passwordPath = process.env.OCE_BOOTSTRAP_PASSWORD_FILE;
  const secretName = process.env.OCE_BOOTSTRAP_SECRET ?? "openclaw-enterprise-bootstrap";
  const adminEmail = process.env.OCE_ADMIN_EMAIL;
  if (!passwordPath || !adminEmail) throw new Error("Bootstrap password path and administrator email are required");
  let password;
  for (;;) {
    try {
      password = (await readFile(passwordPath, "utf8")).trim();
      if (password) break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await sleep(5_000);
  }
  await upsert(context, "secret", secretName, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secretName, namespace: context.namespace },
    type: "Opaque",
    stringData: { "admin-email": adminEmail, "admin-password": password },
  });
  process.stdout.write(`Synchronized bootstrap credentials to Secret ${secretName}\n`);
}

async function main() {
  const mode = process.argv[2];
  const context = await client();
  if (mode === "endpoint") {
    for (;;) {
      try {
        await reconcileEndpoint(context);
      } catch (error) {
        console.error(error);
      }
      await sleep(60_000);
    }
  }
  if (mode === "bootstrap") {
    await reconcileBootstrap(context);
    setInterval(() => {}, 3_600_000);
    return;
  }
  throw new Error("Usage: node platform-operator.mjs endpoint|bootstrap");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
