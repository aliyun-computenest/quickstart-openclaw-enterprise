# 计算巢服务目录

- `config.yaml`：服务元数据、模板和部署物构建配置。
- `ros_templates/ack.yaml`：新建或已有 ACK 集群模板。
- `docker/`：Controller、Runtime 镜像及辅助进程构建文件。
- `helm/openclaw-enterprise-computenest/`：ACK 应用 Chart 源码。
- `resources/artifact_resources/helm_chart/`：计算巢导入使用的 Chart 压缩包。

ROS 模板参考 [资源编排](https://help.aliyun.com/zh/ros)，服务导入参考 [computenest-cli](https://pypi.org/project/computenest-cli/)。
