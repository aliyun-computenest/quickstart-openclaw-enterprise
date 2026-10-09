>**免责声明：**本服务由第三方提供，我们尽力确保其安全性、准确性和可靠性，但无法保证其完全免于故障、中断、错误或攻击。因此，本公司在此声明：对于本服务的内容、准确性、完整性、可靠性、适用性以及及时性不作任何陈述、保证或承诺，不对您使用本服务所产生的任何直接或间接的损失或损害承担任何责任；对于您通过本服务访问的第三方网站、应用程序、产品和服务，不对其内容、准确性、完整性、可靠性、适用性以及及时性承担任何责任，您应自行承担使用后果产生的风险和责任；对于因您使用本服务而产生的任何损失、损害，包括但不限于直接损失、间接损失、利润损失、商誉损失、数据损失或其他经济损失，不承担任何责任，即使本公司事先已被告知可能存在此类损失或损害的可能性；我们保留不时修改本声明的权利，因此请您在使用本服务前定期检查本声明。如果您对本声明或本服务存在任何问题或疑问，请联系我们。

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
| `openclaw-enterprise-tls-proxy` | Deployment | HTTPS 接入与 TLS 终结 |
| `openclaw-enterprise-registry-sync` | Deployment | 镜像 / 运行时注册表同步 |
| `openclaw-enterprise-postgres` | StatefulSet | PostgreSQL 元数据存储（云盘 PVC 持久化） |
| Flux（helm-controller / source-controller） | 系统组件 | 以 GitOps 方式安装与维护 Helm 应用 |

集群侧由服务自动创建并维护 VPC、交换机与安全组；对外通过负载均衡（SLB）+ HTTPS 域名（`*.sslip.io`）暴露控制台。Controller、Runtime、PostgreSQL 镜像与 Helm Chart 均以计算巢部署物交付，避免运行时直接依赖境外镜像仓库。

## 前提条件

### RAM 账号所需权限

使用阿里云账号（主账号）创建服务实例时无需额外授权。若您使用 RAM 用户创建服务实例，需要在创建前为该 RAM 用户添加下列资源权限（详细操作请参见[为 RAM 用户授权](https://help.aliyun.com/document_detail/121945.html)）：

| 权限策略名称 | 备注 |
| --- | --- |
| AliyunComputeNestUserFullAccess | 计算巢服务的使用权限 |
| AliyunCSFullAccess | 容器服务 ACK 集群的创建与管理 |
| AliyunECSFullAccess | 工作节点 ECS 的创建与管理 |
| AliyunVPCFullAccess | VPC、交换机的创建与管理 |
| AliyunSLBFullAccess | 负载均衡（对外 HTTPS 接入）的创建与管理 |

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
| VPC / 交换机网段 | 新建集群时的网络网段，默认 `192.168.0.0/16` / `192.168.0.0/20` |

> 新建集群时，VPC、交换机与安全组由服务自动创建与维护，请确认网段不与现有网络冲突，无需手动配置。

### 2. 确认订单并创建

参数填写完成后可以看到对应询价明细（ACK、ECS、云盘和负载均衡费用），确认参数后点击 **下一步：确认订单**。确认订单完成后同意服务协议并点击 **立即创建** 进入部署阶段。

### 3. 等待部署完成

部署包含「创建 ACK 集群 → 工作节点就绪 → 安装 Flux 与 Helm 应用 → 等待控制面各组件就绪」等阶段，通常需要 **15～25 分钟**。等待实例状态变为「已部署」后进入服务实例管理页。

部署完成后，实例详情页将输出以下访问信息：

| 输出项 | 内容 |
| --- | --- |
| `Endpoint` | OCE 控制台 HTTPS 访问地址，形如 `https://openclaw-<ip>.sslip.io` |
| `AdminEmail` | 初始管理员邮箱 |
| `AdminPassword` | 初始管理员密码（部署时自动生成） |
| `ClusterId` | 实际使用的 ACK 集群 ID |

> 请妥善保存 `AdminPassword`，不要写入代码仓库、日志或公开文档。

### 4. 访问服务

1. 单击 `Endpoint` 链接打开 OCE 控制台；首次打开需确认自签名证书告警。
2. 使用 `AdminEmail` 与 `AdminPassword` 登录。
3. 登录后即可进入控制面，开始管理命名空间、Agent 与模型接入。建议尽快修改初始密码。

## 使用说明

### 配置模型接入

OCE 中的 Agent 需要对接一个大模型服务才能响应请求。登录后在控制台配置模型提供商（Model Provider）并填入对应的 API Key（如 OpenAI 兼容接口），作为 Agent 的默认模型或按 Agent 覆盖。

### 部署第一个 Agent

1. 在控制台创建（或从 Agent Preset 复制）一个 Agent 草稿；
2. 填写运行时与模型配置，提交生成一个 Revision；
3. 发布该 Revision，OCC 会调度 worker 在集群中拉起 Agent 沙箱；
4. 向 Agent 发送一条模型请求，验证端到端链路。

更详细的概念与操作（Control Plane、Agent、Revision、Preset、命名空间恢复等）见官方文档。

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
2. **HTTPS 接入**：控制台经 `tls-proxy` 以 HTTPS 暴露，当前使用实例内自动生成的自签名证书；如需限制访问来源，可在 SLB / 安全组层面收敛来源 CIDR。
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

### 组件处于 Pending / CrashLoopBackOff

- Pod 长时间 `Pending`：多为节点资源不足或 PVC 未绑定，检查节点可分配资源与 StorageClass。
- 容器 `CrashLoopBackOff`：查看对应 Pod 日志定位；确认镜像已随计算巢部署物正常交付。

## 官方文档

更多信息请访问官方文档：[OpenClaw Enterprise Kubernetes 部署指南](https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/kubernetes-setup.md)
