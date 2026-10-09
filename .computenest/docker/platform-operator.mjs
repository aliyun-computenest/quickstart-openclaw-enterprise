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

function endpointHost(ingress) {
  if (ingress.ip) {
    return `openclaw-${ingress.ip.replaceAll(".", "-")}.sslip.io`;
  }
  if (ingress.hostname) return ingress.hostname;
  return undefined;
}

async function waitForEndpoint(context, serviceName) {
  const path = `/api/v1/namespaces/${context.namespace}/services/${serviceName}`;
  for (;;) {
    const service = await request(context, "GET", path);
    const ingress = service.status?.loadBalancer?.ingress?.[0];
    const host = ingress === undefined ? undefined : endpointHost(ingress);
    if (host) return host;
    process.stdout.write(`Waiting for LoadBalancer address on ${serviceName}\n`);
    await sleep(10_000);
  }
}

async function reconcileEndpoint(context) {
  const serviceName = process.env.OCE_SERVICE_NAME ?? "openclaw-enterprise";
  const configMapName = process.env.OCE_ENDPOINT_CONFIGMAP ?? "openclaw-enterprise-endpoint";
  const tlsSecretName = process.env.OCE_TLS_SECRET ?? "openclaw-enterprise-tls";
  const host = await waitForEndpoint(context, serviceName);
  const baseUrl = `https://${host}`;
  const existing = await getOptional(
    context,
    `/api/v1/namespaces/${context.namespace}/configmaps/${configMapName}`,
  );
  if (existing?.data?.["base-url"] === baseUrl) return baseUrl;

  const config = `[req]\ndistinguished_name=req_distinguished_name\nx509_extensions=v3\nprompt=no\n[req_distinguished_name]\nCN=${host}\n[v3]\nsubjectAltName=DNS:${host}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`;
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
    data: { "base-url": baseUrl, host },
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
