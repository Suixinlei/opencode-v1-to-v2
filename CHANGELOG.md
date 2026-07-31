# Changelog

本项目的重要变化记录在此。公开发布后采用语义化版本，并在每个 release 下记录
迁移语义、兼容的 OpenCode target profile、产物 schema 和升级注意事项。

## Unreleased

- 开始补充开源治理、贡献、安全和 CI 基础设施。
- 记录公开发布阻断项与公共/组织专用代码边界。
- 让 CLI 无参数、`-h` 和 `--help` 安全输出使用说明。
- 重写 README，明确项目作用、适用范围、安全保证和完整迁移流程。
- 增加架构、兼容性和安全模型文档。
- 使用 Apache-2.0，并记录 OpenCode 与 AI SDK 的第三方归属。
- 增加公开 GitHub 仓库元数据；继续禁止意外 npm 发布。
- 移除公共核心中的私有默认镜像，改为显式 digest-pinned image。
- 增加英文 README。
- 移除 fleet ops 中的主机和 controller 私有默认值，改为必填参数。
- 增加基于 OpenCode 官方 release checksum 的 `linux/amd64` / `linux/arm64`
  target image、GHCR 发布 workflow、SBOM 和 provenance。
- target profile 更新为
  `opencode-v2@1.18.9+4da7bb44.official-musl-v1`，旧 plan 必须重新生成。
