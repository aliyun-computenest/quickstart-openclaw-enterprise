# OpenClaw Enterprise 社区版 部署文档

## 概述

OpenClaw Enterprise（OCE）是一款开源、厂商中立的智能体（Agent）管理平台，可以理解为「面向 Agent 的 Kubernetes」。它通过 OpenClaw Control Plane（OCC）统一部署和管理 Agent 及其版本（Revision），支持模型接入、沙箱运行时、RBAC 与多租户命名空间。

通过阿里云计算巢服务，您可以一键部署 OpenClaw Enterprise 社区版：服务自动创建一套 **ACK 托管 Pro 集群**（或复用您已有的 ACK 集群），并在其中安装控制面、Agent 运行时、PostgreSQL 与 HTTPS 接入层，实现开箱即用。

## 部署架构

服务在 ACK 集群的目标命名空间（默认 `openclaw-enterprise`）内部署以下组件：

| 组件 | 类型 | 作用 |
| --- | --- | --- |
| `openclaw-enterprise-api` | Deployment | 控制面 API（OCC），管理 Agent / Revision |
| `openclaw-enterprise-worker` | Deployment | Agent 调度与运行时工作器 |
| `openclaw-enterprise-bootstrap` | Deployment | 初始化与数据迁移 |
| `openclaw-enterprise-endpoint` | Deployment | 对外端点服务 |
| `openclaw-enterprise-tls-proxy` | Deployment | 控制台接入与 TLS 终结（HTTP/HTTPS 可切换） |
| `openclaw-enterprise-registry-sync` | Deployment | 镜像 / 运行时注册表同步 |
| `openclaw-enterprise-postgres` | StatefulSet | PostgreSQL 元数据存储（云盘 PVC 持久化） |
| Flux（helm-controller / source-controller） | 系统组件 | 以 GitOps 方式安装与维护 Helm 应用 |

集群侧由服务自动创建并维护 VPC、交换机与安全组；对外通过负载均衡（SLB）以 HTTPS 暴露控制台，访问地址默认为负载均衡公网 IP，也可指定自定义域名。Controller、Runtime、PostgreSQL 镜像与 Helm Chart 均以计算巢部署物交付，避免运行时直接依赖境外镜像仓库。

## 前提条件

### 复用已有 ACK 集群的要求

若「集群方式」选择复用已有 ACK 集群，目标集群需满足：

- 集群状态正常，工作节点具备足够 CPU、内存和可用云盘配额；
- 已安装并可使用 CSI 云盘驱动；
- 允许创建 `LoadBalancer` Service、ClusterRole、ClusterRoleBinding、PVC 和 Secret；
- 默认 StorageClass `alicloud-disk-topology-alltype` 可用，以便 PVC 按工作负载所在可用区动态绑定；
- 部署身份必须是服务消费者账号，并具备访问该 ACK 集群的权限。

## 部署流程

### 1. 创建服务实例

访问 OpenClaw Enterprise 社区版 服务部署链接，按提示填写部署参数：

[部署链接](https://computenest.console.aliyun.com/service/instance/create/cn-hangzhou?type=user&ServiceId=service-70f80f1f8680499089b4)

在模板选择页选择 **ACK 集群版**，点击 **下一步** 进入参数填写页。主要参数说明如下：

| 参数 | 说明 |
| --- | --- |
| 集群方式 | `NewAck` 新建 ACK 托管 Pro 集群；或选择复用已有 ACK 集群 |
| 已有 ACK 集群 | 仅当「集群方式」选择复用已有集群时填写 |
| 可用区 | 部署所在可用区（如 `cn-hongkong-b`），请选择有库存的可用区 |
| 工作节点规格 | 工作节点 ECS 规格，默认 `ecs.g8i.2xlarge`（8 vCPU / 32 GiB） |
| 工作节点数量 | 工作节点个数，默认 3（可选 2～10） |
| 节点登录密码 | 工作节点 ECS 登录密码，需包含大小写字母、数字及特殊符号 |
| 初始管理员邮箱 | OCE 控制台初始管理员邮箱，默认 `admin@example.com` |
| Kubernetes 命名空间 | 组件部署到的命名空间，默认 `openclaw-enterprise` |
| 控制台访问方式 | 默认「负载均衡公网 IP」，通过 `http://<IP>/console` 访问；选择「自定义域名」时通过 `http://<域名>/console` 访问 |
| 自定义域名 | 仅当访问方式为「自定义域名」时必填，例如 `openclaw.example.com`，不带协议和路径 |
| 控制台访问协议 | 默认 `HTTP`（80 端口），浏览器打开即用、无证书告警；选择 `HTTPS`（443 端口）时使用实例内自签名证书，首次访问需确认证书告警 |
| VPC / 交换机网段 | 新建集群时的网络网段，默认 `192.168.0.0/16` / `192.168.0.0/20` |

> 新建集群时，VPC、交换机与安全组由服务自动创建与维护，请确认网段不与现有网络冲突，无需手动配置。

> OCE 出于安全考虑只接受来自部署时确定的访问地址的登录请求。选择 IP 访问时请始终用输出的 IP 地址访问；选择自定义域名时请始终用该域名访问，用其他地址或其他协议（例如用 IP 访问域名模式的实例、用 https 访问 HTTP 模式的实例）会导致登录失败。

### 2. 确认订单并创建

参数填写完成后可以看到对应询价明细（ACK、ECS、云盘和负载均衡费用），确认参数后点击 **下一步：确认订单**。确认订单完成后同意服务协议并点击 **立即创建** 进入部署阶段。

### 3. 等待部署完成

部署包含「创建 ACK 集群 → 工作节点就绪 → 安装 Flux 与 Helm 应用 → 等待控制面各组件就绪」等阶段，通常需要 **15～25 分钟**。等待实例状态变为「已部署」后进入服务实例管理页。

部署完成后，实例详情页将输出以下访问信息：

| 输出项 | 内容 |
| --- | --- |
| `Endpoint` | OCE 控制台访问地址，形如 `http://<IP>/console`；选择自定义域名或 HTTPS 时相应为 `http(s)://<域名或 IP>/console` |
| `OpenChat` | 默认 Agent 的网页聊天入口，形如 `http://<IP>:8080` |
| `AdminEmail` | 初始管理员邮箱 |
| `AdminPassword` | 初始管理员密码（部署时自动生成），同时也是网页聊天的登录密码 |

> 请妥善保存 `AdminPassword`，不要写入代码仓库、日志或公开文档。实际使用的 ACK 集群 ID 与负载均衡公网 IP 可在实例详情页的「资源」列表中查看。

### 4. 访问服务

1. 若选择了自定义域名，先在您的 DNS 服务商处添加一条 A 记录，将该域名解析到负载均衡的公网 IP（在实例详情页的「资源」列表中找到对应的 SLB 实例，其服务地址即为公网 IP），待解析生效后再访问。
2. 单击 `Endpoint` 链接直接打开 OCE 控制台（地址已包含 `/console` 路径）；选择 HTTPS 协议时首次打开需确认自签名证书告警。
3. 使用 `AdminEmail` 与 `AdminPassword` 登录。
4. 登录后即可进入控制面，开始管理命名空间、Agent 与模型接入。

> 控制台管理员密码在部署时生成并写入集群，可在控制台内修改；但网页聊天的登录密码固定取部署时的初始管理员密码，**不会随控制台改密同步**，修改控制台密码前请先保存好 `AdminPassword`。

## 使用说明

### 配置模型接入

OCE 中的 Agent 需要对接一个大模型服务才能响应请求。登录后在控制台配置模型提供商（Model Provider）并填入对应的 API Key（如 OpenAI 兼容接口），作为 Agent 的默认模型或按 Agent 覆盖。

### 部署第一个 Agent

1. 在控制台创建（或从 Agent Preset 复制）一个 Agent 草稿；
2. 填写运行时与模型配置，提交生成一个 Revision；
3. 发布该 Revision，OCC 会调度 worker 在集群中拉起 Agent 沙箱；
4. 向 Agent 发送一条模型请求，验证端到端链路。

更详细的概念与操作（Control Plane、Agent、Revision、Preset、命名空间恢复等）见官方文档。

### 与 Agent 对话（网页聊天，开箱即用）

Agent 发布成功后，无需任何手工网络或认证配置，即可从浏览器与它对话：

1. **打开聊天页**：在 OCE 控制台进入 Agent 详情页，点击工具栏的 **Open Chat** 链接，会在新窗口打开该 Agent 的聊天页（自动跳转到它分配到的聊天端口）；
2. **输入聊天密码**：首次打开会出现密码输入框。聊天密码**与 OCE 控制台管理员密码相同**（即部署输出项 `AdminPassword`），所有 Agent 共用，无需到集群中单独获取；
3. **自动配对**：提交密码后页面短暂显示「等待批准」，实例内置的自动配对组件会在约 5 秒内自动批准该浏览器，随后直接进入聊天界面；
4. **开始对话**：输入消息即可获得 Agent 回复（模型与提示词跟随 Agent 配置）。

> - 聊天入口经负载均衡的 **8080-8089 端口段**对外暴露，所有监听在首次部署时由系统（阿里云 CCM）按 Chart 声明自动创建，无需手工配置；**复用已有 ACK 集群**时，请确保集群安全组已放行 8080-8089；
> - 网页聊天采用 Gateway 密码认证 + 设备配对双重保护；聊天密码与控制台管理员密码一致，请妥善保管；
> - 聊天密码取自部署完成时写入的初始管理员密码：之后在控制台修改管理员密码只影响控制台登录，聊天入口仍使用初始密码；
> - 命令行验证方式仍然可用：`kubectl -n <namespace> exec <gateway pod> -c gateway -- openclaw agent --local -m "你好"`。

#### 多 Agent 与聊天端口段（8080-8089）

服务为网页聊天在负载均衡上预留了 **10 个端口（8080-8089）**，每个运行中的 Agent 自动独占一个端口，互不干扰：

- **端口分配**：Agent 就绪后自动获得独立聊天端口，第一个 Agent 的聊天入口固定为 **8080**（即服务输出 `OpenChat` 指向的默认入口），其余 Agent 依次占用后续端口，最多支持 10 个 Agent 同时提供网页聊天；
- **端口跳转**：每个 Agent 详情页的 Open Chat 按钮都会自动跳转到对应端口；也可以从任意聊天端口访问 `http://<负载均衡IP>:8080/chat-switch?agent=<AgentID>` 手动跳转；
- **端口回收**：Agent 删除或未就绪时端口自动回收，对应端口会显示「该端口尚未分配 Agent」引导页；页面每 5 秒自动刷新，Agent 分配到端口后无需手动刷新即可进入聊天。

> 多个 Agent 的聊天页各自独立（密码、会话互不相通），分享聊天链接时请确认端口与目标 Agent 对应。

## 部署后核验

如需确认集群内组件真实就绪，可通过 ACK 控制台或 `kubectl` 查看目标命名空间下资源状态：

```bash
kubectl get nodes
kubectl -n openclaw-enterprise get deploy,statefulset,pod,svc,pvc
```

预期：工作节点均为 `Ready`；6 个 Deployment 与 `openclaw-enterprise-postgres` StatefulSet 均为 Ready / Running；两个 PVC 均为 `Bound`；`openclaw-enterprise-tls-proxy` 的 `LoadBalancer` Service 已分配外部地址。

## 数据与运维

- PostgreSQL 数据与 bootstrap 数据持久化在阿里云云盘 PVC 上，删除 Pod 不会丢失元数据；**删除服务实例会一并释放集群与云盘**，请先备份必要数据。
- 组件通过 Flux（GitOps）安装与维护，正常情况下无需手动 `helm` 操作；如需排查，可在集群内查看 `flux-system` 命名空间下 controller 日志。
- 工作节点为按量付费 ECS，长期运行请关注费用；不用时可通过删除服务实例回收整套集群资源。

## 安全说明

1. **保护管理员凭据**：`AdminPassword` 为部署时自动生成的强密码，数据库密码与认证密钥由 ROS 随机生成，请仅在可信渠道保存与分发。
2. **访问协议与来源限制**：控制台经 `tls-proxy` 暴露，默认 HTTP（80 端口），登录凭据与会话以明文传输，建议在 SLB / 安全组层面将访问来源收敛到办公网等可信 CIDR；对传输安全有要求时请选择 HTTPS（实例内自签名证书）。
3. **集群访问控制**：OCE 支持 RBAC 与多租户命名空间，服务会创建集群级 RBAC 资源；同一集群内的多个实例必须使用不同命名空间，生产环境建议按团队划分命名空间并最小化授权，删除实例前请确认没有外部工作负载依赖该命名空间。

## 故障排查

### ACK 部署长时间未完成

检查节点是否 Ready、PVC 是否 Bound、LoadBalancer 是否分配地址：

```bash
kubectl get nodes
kubectl -n openclaw-enterprise get pods,pvc
kubectl -n openclaw-enterprise get svc openclaw-enterprise-tls-proxy
```

若使用已有 ACK 集群，重点检查集群权限、CSI 云盘驱动、默认 StorageClass 与 SLB 配额。

### 控制台能打开但登录失败

登录只接受来自 `Endpoint` 所示地址的请求。请确认浏览器地址栏中的主机名与 `Endpoint` 完全一致：IP 模式使用 IP 访问，自定义域名模式使用该域名访问且域名已解析到负载均衡的公网 IP。

### 聊天页提示密码错误

- 确认输入的是部署输出项 `AdminPassword`。初始管理员密码写入集群后不再随控制台改密变化，在控制台改过密码时请仍用 `AdminPassword` 登录聊天页。
- 密码正确但页面一直停留在「等待批准」，说明实例内的自动配对组件未生效，检查 `openclaw-enterprise-worker` 与聊天端口对应 Agent 的运行状态。

### 组件处于 Pending / CrashLoopBackOff

- Pod 长时间 `Pending`：多为节点资源不足或 PVC 未绑定，检查节点可分配资源与 StorageClass。
- 容器 `CrashLoopBackOff`：查看对应 Pod 日志定位；确认镜像已随计算巢部署物正常交付。

## 官方文档

更多信息请访问官方文档：[OpenClaw Enterprise Kubernetes 部署指南](https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/kubernetes-setup.md)

## 免责声明

>本服务由第三方提供，我们尽力确保其安全性、准确性和可靠性，但无法保证其完全免于故障、中断、错误或攻击。因此，本公司在此声明：对于本服务的内容、准确性、完整性、可靠性、适用性以及及时性不作任何陈述、保证或承诺，不对您使用本服务所产生的任何直接或间接的损失或损害承担任何责任；对于您通过本服务访问的第三方网站、应用程序、产品和服务，不对其内容、准确性、完整性、可靠性、适用性以及及时性承担任何责任，您应自行承担使用后果产生的风险和责任；对于因您使用本服务而产生的任何损失、损害，包括但不限于直接损失、间接损失、利润损失、商誉损失、数据损失或其他经济损失，不承担任何责任，即使本公司事先已被告知可能存在此类损失或损害的可能性；我们保留不时修改本声明的权利，因此请您在使用本服务前定期检查本声明。如果您对本声明或本服务存在任何问题或疑问，请联系我们。
