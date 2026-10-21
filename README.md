# OpenClaw Enterprise 社区版（阿里云计算巢服务）

本仓库将 [OpenClaw Enterprise](https://github.com/openclaw/openclaw-enterprise) 封装为阿里云计算巢私有化服务：一键交付 **ACK 托管 Pro 集群**（或复用已有 ACK 集群），并在其中以 GitOps（Flux）方式安装控制面 API、Agent 运行时、PostgreSQL 与 HTTP/HTTPS 接入层，实现开箱即用的智能体（Agent）管理平台。

服务遵循上游 Kubernetes-only 架构，将 Controller、Runtime、PostgreSQL 镜像与 Helm Chart 作为计算巢部署物交付，避免运行时直接依赖境外镜像仓库。当前封装固定上游源码版本 `a5cc0d75139f2c61dd148f8332a9167102fd9752`。

查看服务实例部署在线文档，请访问 [服务实例部署文档](https://aliyun-computenest.github.io/quickstart-openclaw-enterprise)。

## 部署形态

| 形态 | 基础设施 | 访问方式 | 适用场景 |
|---|---|---|---|
| ACK 集群版 | 新建或已有 ACK | SLB 公网 HTTP（默认）/ HTTPS（公网 IP 或自定义域名） | 多用户、生产化和弹性扩展 |

## 仓库结构

```text
.computenest/
├── config.yaml                     计算巢服务定义（镜像 / Helm Chart 部署物）
├── docker/
│   ├── Dockerfile.controller       控制面镜像
│   ├── Dockerfile.runtime          Agent 运行时镜像
│   ├── platform-operator.mjs       端点 / TLS / bootstrap 凭据同步算子
│   ├── tls-proxy.mjs               HTTP/HTTPS 接入代理与多 Agent 聊天端口路由
│   └── autopair.mjs                Agent 配对与聊天端口自动分配
├── helm/openclaw-enterprise-computenest/   Helm Chart 源（组件编排）
├── resources/
│   ├── icons/service_logo.png      服务图标
│   └── artifact_resources/helm_chart/
│       └── openclaw-enterprise-computenest-0.1.14.tgz   当前使用的 Chart 部署物
└── ros_templates/
    └── ack.yaml                    ROS 编排模板（集群 / 节点池 / 组件 / 接入）
docs/
└── index.md                        服务实例部署文档（GitHub Pages 首页）
mkdocs.yml                          MkDocs 站点配置
```

## 用户文档

部署参数、访问方式、集群核验与运维说明见 [docs/index.md](docs/index.md)。

网页聊天（含多 Agent 端口段 8080-8089 的分配、跳转与回收规则）见文档站「与 Agent 对话」章节：每个运行中的 Agent 自动独占一个聊天端口，第一个 Agent 固定使用 8080；复用已有 ACK 集群时需自行放行 8080-8089。

## 本地校验

```shell
# Helm Chart 静态检查与渲染
helm lint .computenest/helm/openclaw-enterprise-computenest
helm template openclaw .computenest/helm/openclaw-enterprise-computenest \
  --set images.controller=example/controller:test \
  --set images.runtime=example/runtime:test \
  --set images.postgres=example/postgres:test \
  --set databasePassword=test-password \
  --set authSecret=test-auth-secret-with-at-least-32-characters >/tmp/openclaw-rendered.yaml
```

## 文档本地预览

在线文档通过 [MkDocs](https://github.com/mkdocs/mkdocs) + 计算巢主题生成：

```shell
pip install mkdocs                      # 或 pip3
pip install --upgrade mkdocs-aliyun-computenest
mkdocs serve                            # 仓库根目录执行
```

本地在浏览器打开 [http://localhost:8000/](http://localhost:8000/) 预览。推送到 `main` 分支后由 GitHub Actions 自动构建并发布 Pages。
