# OpenCode migration target image

这个镜像只承担一个作用：为迁移工具的 **official replay** 和续聊验证提供固定的
OpenCode V2 运行时。它不是迁移工具本身，也不包含数据库、会话、凭证或业务
配置。

镜像从 OpenCode `v1.18.9` 官方 release 的 musl 资产构建，支持
`linux/amd64` 和 `linux/arm64`。构建同时锁定并校验：

- OpenCode tag 与 commit；
- 上游压缩包 SHA-256；
- 解压后的平台二进制 SHA-256；
- Alpine 基础镜像 digest；
- OpenCode 所需 `libgcc` / `libstdc++` APK 版本与文件 SHA-256；
- 容器内 `opencode --version`。

全部机器可审计输入见 [profile.json](profile.json)。Docker 构建上下文由根目录
`.dockerignore` 限制为镜像定义和许可证文件，迁移源码、数据库及运行产物不会
进入镜像。

## 本地构建

```bash
docker buildx build \
  --platform linux/amd64 \
  --file docker/opencode-target/Dockerfile \
  --tag opencode-v1-to-v2-target:test \
  --load \
  .
```

```bash
docker run --rm --entrypoint /bin/sh \
  opencode-v1-to-v2-target:test \
  -lc 'opencode --version && uname -m && sha256sum "$(command -v opencode)"'
```

## 发布与使用

`.github/workflows/target-image.yml` 在 `main` 中镜像定义变化时构建多架构镜像，
发布到：

```text
ghcr.io/suixinlei/opencode-v1-to-v2-target
```

tag 只用于发现版本。迁移命令必须先取得 OCI manifest digest，再传入不可变
引用：

```bash
docker buildx imagetools inspect \
  ghcr.io/suixinlei/opencode-v1-to-v2-target:1.18.9-4da7bb44
```

```bash
export OPENCODE_MIGRATION_IMAGE=\
ghcr.io/suixinlei/opencode-v1-to-v2-target@sha256:<manifest-digest>
```

维护者可以在不接触真实数据库和模型的情况下运行完整验收：

```bash
bun scripts/verify-target-image.ts "$OPENCODE_MIGRATION_IMAGE"
```

该脚本只使用匿名 fixture 和本地 mock model，依次验证 official replay、完整
verifier、legacy cleanup、同 session 续聊写入以及重启读取；临时数据库和报告
在完成后删除。

GitHub Container Registry 首次创建 package 时默认为 private。维护者必须在
package settings 中明确切换为 public，并在未登录状态验证可以按 digest 拉取，
才能把它写成公开可用的迁移前置条件。
