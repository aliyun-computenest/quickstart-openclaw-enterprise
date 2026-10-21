// OCE 计算巢定制：设备配对自动批准 + 聊天路由维护（打进 controller 镜像，
// 由 chart 的 autopair 容器常驻运行，SA 权限仅限 pods list/exec + configmap 读写）。
// 循环：
//   1. 全集群列出 openclaw.dev/workload-role=gateway 的 Running Pod；
//   2. 对每个 gateway Pod 通过 K8s exec 运行 node 脚本，把 pending 设备逐个 approve；
//   3. 维护聊天路由 ConfigMap（default 指向字典序第一个 gateway Service）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import https from "node:https";

const namespace = process.env.POD_NAMESPACE ?? "default";
const routesConfigMapName = process.env.CHAT_ROUTES_CONFIGMAP ?? "gateway-chat-routes";
const intervalMs = Number(process.env.INTERVAL_MS ?? "5000");
const host = process.env.KUBERNETES_SERVICE_HOST;
const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
const token = readFileSync(
  "/var/run/secrets/kubernetes.io/serviceaccount/token",
  "utf8",
);
const ca = readFileSync(
  "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
);

const seenApprovals = new Set();
// gateway busy（如配对成功后浏览器重连风暴）时 CLI 可能瞬时失败；
// 连续失败只打前 2 次，之后每 12 轮（约 1 分钟）提示一次，恢复时打一次。
const failStreak = new Map();

function apiRequest(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host,
        port,
        method,
        path,
        ca,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 300) {
            reject(new Error(`${method} ${path} -> ${response.statusCode} ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(text === "" ? {} : JSON.parse(text));
          } catch {
            resolve({});
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

// 在 gateway Pod 内执行的审批脚本：解析 openclaw devices list 的 pending 队列并逐个 approve。
const APPROVE_SCRIPT = [
  'const { execSync } = require("node:child_process");',
  'const list = JSON.parse(execSync("openclaw devices list --json", { encoding: "utf8" }));',
  "const pending = (list.pending || [])",
  '  .map((d) => d.requestId || d.deviceId || d.id)',
  "  .filter((id) => typeof id === \"string\" && /^[0-9a-fA-F-]{8,64}$/.test(id));",
  "const results = [];",
  "for (const id of pending) {",
  "  try {",
  '    execSync(`openclaw devices approve ${id}`, { encoding: "utf8", timeout: 20000 });',
  "    results.push({ id, ok: true });",
  "  } catch (error) {",
  "    results.push({ id, ok: false, error: String(error.message).slice(0, 160) });",
  "  }",
  "}",
  "console.log(JSON.stringify(results));",
].join("\n");

// 通过 K8s exec（WebSocket v4.channel.k8s.io 子协议）在容器内执行命令并收集 stdout。
// 浏览器风格 WebSocket 无法设 Authorization 头，改用 K8s 官方的认证子协议
// （base64url.bearer.authorization.k8s.io.<token>，与 client-go websocket 客户端同款）。
function execInPod(podName, podNamespace, container, command) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams();
    query.set("container", container);
    // 不带 stdin/stdout/stderr 参数时 API server 直接 400（exec 至少要声明一个流）。
    query.set("stdout", "1");
    query.set("stderr", "1");
    for (const part of command) query.append("command", part);
    const url = `wss://${host}:${port}/api/v1/namespaces/${podNamespace}/pods/${podName}/exec?${query.toString()}`;
    const socket = new WebSocket(url, [
      "v4.channel.k8s.io",
      `base64url.bearer.authorization.k8s.io.${Buffer.from(token).toString("base64url")}`,
    ]);
    const stdout = [];
    let stderr = "";
    const fail = (error) => {
      try {
        socket.close();
      } catch {}
      reject(error);
    };
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {};
    socket.onmessage = (event) => {
      const bytes = new Uint8Array(event.data);
      const channel = bytes[0];
      const payload = Buffer.from(bytes.slice(1)).toString("utf8");
      if (channel === 1) stdout.push(payload);
      else if (channel === 2) stderr += payload;
      else if (channel === 3) {
        // v4 协议：error channel 收到 {"status":"Success"} 是命令正常结束的信号，
        // 其余（含错误 Status 或非 JSON 输出）才是真失败。
        let status;
        try {
          status = JSON.parse(payload);
        } catch {
          status = undefined;
        }
        if (status?.status !== "Success") {
          fail(new Error(`exec error channel: ${stderr || payload}`));
        }
      }
    };
    socket.onerror = (event) => fail(new Error(`exec websocket failed: ${event?.message ?? "unknown"}`));
    socket.onclose = (event) => {
      if (stdout.length === 0) {
        reject(
          new Error(
            `exec closed (code=${event?.code ?? "?"} reason=${event?.reason ? event.reason.slice(0, 120) : "none"}): ${stderr.slice(0, 160)}`,
          ),
        );
        return;
      }
      resolve(stdout.join(""));
    };
    setTimeout(() => fail(new Error("exec timeout")), 30_000).unref();
  });
}

async function approvePendingDevices(pod) {
  const podName = pod.metadata.name;
  const podNamespace = pod.metadata.namespace;
  const output = await execInPod(podName, podNamespace, "gateway", [
    "node",
    "-e",
    APPROVE_SCRIPT,
  ]);
  failStreak.delete(podName);
  let results = [];
  try {
    const line = output.trim().split("\n").find((l) => l.startsWith("["));
    results = line === undefined ? [] : JSON.parse(line);
  } catch {
    process.stdout.write(`[autopair] unparsable output from ${podName}: ${output.slice(0, 200)}\n`);
  }
  for (const result of results) {
    if (result.ok === true) {
      seenApprovals.add(result.id);
      process.stdout.write(`[autopair] approved device ${result.id} on ${podName}\n`);
    } else {
      // 已不存在/已批准的请求同样记录，避免每轮重复重试。
      seenApprovals.add(result.id);
      process.stdout.write(`[autopair] approve skipped ${result.id}: ${result.error ?? "unknown"}\n`);
    }
  }
}

async function updateChatRoute(gatewayPods) {
  if (gatewayPods.length === 0) return;
  const pod = gatewayPods
    .slice()
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))[0];
  const agentNamespace = pod.metadata.namespace;
  const services = await apiRequest(
    `/api/v1/namespaces/${agentNamespace}/services`,
  );
  const gatewayService = (services.items ?? [])
    .map((item) => item.metadata.name)
    .filter((name) => name.startsWith("gateway-"))
    .sort()[0];
  if (gatewayService === undefined) return;
  const existing = await apiRequest(
    `/api/v1/namespaces/${namespace}/configmaps/${routesConfigMapName}`,
  ).catch(() => undefined);
  // ConfigMap 单 key routes.json（既是 tls-proxy 挂载文件名也是路由内容），比较后整体 replace。
  let current;
  try {
    current = JSON.parse(existing?.data?.["routes.json"] ?? "");
  } catch {
    current = undefined;
  }
  if (
    existing !== undefined &&
    current?.default === gatewayService &&
    current?.namespace === agentNamespace
  ) {
    return;
  }
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: routesConfigMapName, namespace },
    data: {
      "routes.json": JSON.stringify({ default: gatewayService, namespace: agentNamespace }),
    },
  };
  if (existing === undefined) {
    await apiRequest(`/api/v1/namespaces/${namespace}/configmaps`, "POST", body);
  } else {
    body.metadata.resourceVersion = existing.metadata?.resourceVersion;
    await apiRequest(
      `/api/v1/namespaces/${namespace}/configmaps/${routesConfigMapName}`,
      "PUT",
      body,
    );
  }
  process.stdout.write(
    `[autopair] chat route -> ${gatewayService}.${agentNamespace}\n`,
  );
}

async function tick() {
  const pods = await apiRequest(
    "/api/v1/pods?labelSelector=openclaw.dev%2Fworkload-role%3Dgateway",
  );
  const gatewayPods = (pods.items ?? []).filter(
    (pod) => pod.status?.phase === "Running",
  );
  for (const pod of gatewayPods) {
    const podName = pod.metadata.name;
    try {
      await approvePendingDevices(pod);
    } catch (error) {
      const streak = (failStreak.get(podName) ?? 0) + 1;
      failStreak.set(podName, streak);
      if (streak <= 2 || streak % 12 === 0) {
        process.stdout.write(`[autopair] ${podName}: ${String(error.message).slice(0, 200)}\n`);
      }
    }
  }
  if (gatewayPods.length > 0) {
    try {
      await updateChatRoute(gatewayPods);
    } catch (error) {
      process.stdout.write(`[autopair] route: ${String(error.message).slice(0, 200)}\n`);
    }
  }
}

async function main() {
  if (host === undefined) {
    throw new Error("KUBERNETES_SERVICE_HOST is not set; autopair must run in-cluster.");
  }
  process.stdout.write(`[autopair] started, namespace=${namespace}, interval=${intervalMs}ms\n`);
  for (;;) {
    try {
      await tick();
    } catch (error) {
      process.stdout.write(`[autopair] tick failed: ${String(error.message).slice(0, 200)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  process.stderr.write(`[autopair] fatal: ${String(error.stack ?? error).slice(0, 400)}\n`);
  process.exit(1);
});
