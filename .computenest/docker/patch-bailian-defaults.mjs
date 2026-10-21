// 构建期补丁：把上游控制台“不使用 Preset”创建 Agent 的默认值改为国内可用的阿里云百炼。
// 上游默认指向 api.openai.com / openai-responses，并默认 Dedicated + Codex，
// 在本服务的 ACK 安装中既不可达也没有 dedicated 后端。
// 每条替换都必须恰好命中一次，否则构建失败，避免上游升级后静默失效。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2] ?? "/source";
const DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const patches = {
  "apps/controller/src/console/agents/create.mjs": [
    [
      `    gateway: {
      mode: "local",
      bind: "lan",
      controlUi: {
        enabled: true,
        allowedOrigins: ["http://127.0.0.1:18789", "http://localhost:18789"],
      },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },`,
      `    gateway: {
      mode: "local",
      bind: "lan",
      controlUi: {
        enabled: true,
        allowedOrigins: ["http://127.0.0.1:18789", "http://localhost:18789"],
      },
      auth: {
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },`,
    ],
    [
      `  openai: [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],`,
      `  openai: ["qwen-plus", "qwen-max", "qwen-flash", "qwen-turbo"],`,
    ],
    [
      `nativeProvider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";`,
      `nativeProvider === "anthropic" ? "https://api.anthropic.com" : "${DASHSCOPE}";`,
    ],
    [
      `api: nativeProvider === "anthropic" ? "anthropic-messages" : "openai-responses",`,
      `api:
        nativeProvider === "anthropic"
          ? "anthropic-messages"
          : harnessId === "codex"
            ? "openai-responses"
            : "openai-completions",`,
    ],
    [
      `                contextWindow: 128000,
                maxTokens: 8192,
                reasoning: true,`,
      `                contextWindow: 131072,
                maxTokens: 8192,
                reasoning: false,`,
    ],
    [
      `      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    ...(providerModel`,
      `      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    // 百炼没有 OpenAI 默认的 text-embedding-3-small，记忆检索改用百炼 embedding 模型。
    ...(harnessId === "openclaw" && nativeProvider === "openai"
      ? { memory: { search: { provider: "openai", model: "text-embedding-v3" } } }
      : {}),
    ...(providerModel`,
    ],
    [
      `    values.models = { ...values.models, providers };
`,
      `    values.models = { ...values.models, providers };
    if (next.memory && values.memory === undefined) {
      values.memory = next.memory;
    } else if (!next.memory && values.memory?.search?.model === "text-embedding-v3") {
      delete values.memory;
    }
`,
    ],
    [
      `element("option", { value: "openai" }, "OpenAI"),`,
      `element("option", { value: "openai" }, "阿里云百炼（OpenAI 兼容）"),`,
    ],
    [
      `element("option", { value: "api_key" }, "OpenAI API key"),`,
      `element("option", { value: "api_key" }, "百炼 API Key"),`,
    ],
    [
      `nativeProvider.value === "anthropic" ? "Anthropic API key" : "OpenAI API key";`,
      `nativeProvider.value === "anthropic" ? "Anthropic API key" : "百炼 API Key";`,
    ],
    // 没有 dedicated 后端时，默认走 Embedded OpenClaw。
    [
      `mode.value = agent.executionMode ?? "dedicated";`,
      `mode.value = agent.executionMode ?? "embedded";`,
    ],
    [
      `nativeProvider.value === "anthropic" || binding?.method === "runtime" ? "openclaw" : "codex";`,
      `"openclaw";`,
    ],
    // Codex 依赖 OpenAI/ChatGPT 账号与 dedicated 后端，仅在已选中时保留。
    [
      `    codexOption.hidden = nativeProvider.value === "anthropic";
    codexOption.disabled = nativeProvider.value === "anthropic";`,
      `    codexOption.hidden = nativeProvider.value === "anthropic" || harness.value !== "codex";
    codexOption.disabled = codexOption.hidden;`,
    ],
  ],
  "apps/controller/src/drivers/compute/model-discovery.ts": [
    [
      `anthropic ? "https://api.anthropic.com/v1/models" : "https://api.openai.com/v1/models",`,
      `anthropic ? "https://api.anthropic.com/v1/models" : "${DASHSCOPE}/models",`,
    ],
  ],
  // 网页聊天产品化：解锁 K8s driver 的托管密码认证（上游 SSH/Docker driver 已支持同款），
  // 并让「不使用 Preset」的默认模板直接带 gateway 密码引用。
  "apps/controller/src/drivers/compute/kubernetes/index.ts": [
    [
      `    if (auth.mode !== undefined && auth.mode !== "trusted-proxy") {
      throw new ConfigurationFailure(
        "Kubernetes Compute supports only native trusted-proxy gateway authentication.",
      );
    }`,
      `    const passwordRecord = asRecord(auth.password);
    const usesGatewayPassword =
      auth.password !== undefined &&
      passwordRecord?.source === "env" &&
      (passwordRecord.provider === undefined || passwordRecord.provider === "default") &&
      passwordRecord.id === OPENCLAW_GATEWAY_PASSWORD;
    if (auth.mode !== undefined && auth.mode !== "trusted-proxy" && !usesGatewayPassword) {
      throw new ConfigurationFailure(
        "Kubernetes Compute supports only native trusted-proxy or managed gateway password authentication.",
      );
    }`,
    ],
    [
      `    return {
      ...configuration,
      gateway: {
        ...gateway,
        trustedProxies: [...this.options.network.gatewayTrustedProxyCidrs],
        allowRealIpFallback: true,
        auth: {
          ...auth,
          mode: "trusted-proxy",`,
      `    if (usesGatewayPassword) {
      // 托管密码模式：不注入 trusted-proxy 块，聊天入口经 tls-proxy 反代用密码访问。
      // 允许来源跟随实例对外地址（api 进程的 OCC_AUTH_BASE_URL），聊天端口固定 8080。
      let chatHost: string | undefined;
      try {
        chatHost = new URL(process.env.OCC_AUTH_BASE_URL ?? "").host;
      } catch {
        chatHost = undefined;
      }
      const controlUiRecord = asRecord(gateway.controlUi);
      // Preset 生成的配置里 controlUi 可能没有 allowedOrigins 数组，此时回退到
      // controller 默认模板的本地 origins 再追加聊天入口，确保任意配置形状都完成注入。
      const existingOrigins = asRecord(controlUiRecord)?.allowedOrigins;
      const baseOrigins = Array.isArray(existingOrigins)
        ? existingOrigins
        : ["http://127.0.0.1:18789", "http://localhost:18789"];
      const nextControlUi =
        controlUiRecord === undefined
          ? controlUiRecord
          : {
              ...controlUiRecord,
              allowedOrigins: [
                ...baseOrigins,
                ...(chatHost === undefined
                  ? []
                  : [\`http://\${chatHost}:8080\`, \`https://\${chatHost}:8080\`]),
              ],
            };
      return {
        ...configuration,
        gateway: {
          ...gateway,
          ...(nextControlUi === undefined ? {} : { controlUi: nextControlUi }),
          auth: {
            ...auth,
            mode: "password",
          },
        },
      };
    }
    return {
      ...configuration,
      gateway: {
        ...gateway,
        trustedProxies: [...this.options.network.gatewayTrustedProxyCidrs],
        allowRealIpFallback: true,
        auth: {
          ...auth,
          mode: "trusted-proxy",`,
    ],
  ],
  // Agent 详情工具栏加「Open Chat」按钮：新窗口打开聊天端口（协议跟随当前控制台，
  // 端口固定 8080 经 SLB 暴露）。聊天密码获取方式见部署文档。
  "apps/controller/src/console/agents/detail.mjs": [
    [
      `  const headerActions = element(
    "div",
    { className: "agent-toolbar-actions" },
    selected !== "draft"
      ? button("Create new version", () => change("draft", "configuration"), {
          className: "primary",
        })
      : null,
  );`,
      `  const headerActions = element(
    "div",
    { className: "agent-toolbar-actions" },
    selected !== "draft"
      ? button("Create new version", () => change("draft", "configuration"), {
          className: "primary",
        })
      : null,
    ...(agent.status === "deleting"
      ? []
      : [
          button(
            "Open Chat",
            () => {
              window.open(
                \`\${window.location.protocol}//\${window.location.hostname}:8080/\`,
                "_blank",
                "noopener",
              );
            },
            { title: "Open web chat (port 8080). See the deployment guide for the chat password." },
          ),
        ]),
  );`,
    ],
  ],
};

for (const [file, replacements] of Object.entries(patches)) {
  const path = join(root, file);
  let source = await readFile(path, "utf8");
  for (const [from, to] of replacements) {
    const count = source.split(from).length - 1;
    if (count !== 1) {
      throw new Error(`${file}: expected exactly one match, found ${count}:\n${from}`);
    }
    source = source.replace(from, () => to);
  }
  await writeFile(path, source);
  console.log(`patched ${file} (${replacements.length} replacements)`);
}
