# GitHub 仓库设置

目标仓库：[`Suixinlei/opencode-v1-to-v2`](https://github.com/Suixinlei/opencode-v1-to-v2)

更新日期：2026-07-31

## 当前状态

已经完成：

- 仓库已公开，默认分支为 `main`；
- 公开历史从净化后的 tree 创建，不包含原本地仓库中带内部元数据的旧 commit；
- GitHub CI 在 macOS 本地与 Linux runner 上均通过 46 项测试；
- Dependabot 已启用，首轮 5 个升级已验证后合并到 `main`，当前无待处理 PR；
- 双架构 target image、SBOM、BuildKit provenance 和 GitHub attestation 已发布；
- GHCR 镜像已支持未登录客户端按 digest 拉取；
- 新公开 digest 已完成 official replay、legacy cleanup、同 session 续聊和重启读回。

仍需使用仓库 owner 的 GitHub 登录态完成：

- About description 与 topics；
- Private vulnerability reporting 和账户计划支持的安全开关；
- `main` branch ruleset；
- 关闭 Wiki；
- 创建 GitHub Release 页面并附 source archive checksum。

这些是 GitHub 账户级设置，不影响当前 source preview 的代码、CI 或匿名镜像使用。

## About

建议 description：

> Safely migrate persisted OpenCode V1 session history into verified V2 events and projections.

建议 topics：

- `opencode`
- `data-migration`
- `sqlite`
- `session-history`
- `bun`
- `typescript`

## 干净历史发布记录

公开前没有直接推送原本地仓库已有的 5 个 commit，因为其历史曾包含私有
registry、组织 package scope、内网地址和 `.DS_Store`。

实际发布过程：

1. 只从最终净化后的 77 个 tracked 文件创建 candidate tree；
2. 冷启动执行 `bun install --frozen-lockfile && bun run verify`；
3. 检查 Python 语法、workflow YAML、Markdown 链接和大文件；
4. 使用 Gitleaks 扫描完整 candidate tree；
5. 以公开 noreply 身份创建新的 root commit；
6. 只把这条干净历史及其后续公开维护 commit 推送到 GitHub。

原本地仓库没有被 reset、force-push 或重写；它与公开仓库的历史边界保持明确。

## Security

`SECURITY.md` 已指向 GitHub Security Advisory。建议在仓库 Settings 中启用：

- Private vulnerability reporting；
- Dependabot alerts；
- Dependabot security updates；
- Secret scanning（账户计划支持时）；
- Push protection（账户计划支持时）。

启用 private reporting 后，应再用未登录或普通用户视角检查 Security 页面是否展示
私密报告入口。

## Container package

`target-image.yml` 使用仓库 `GITHUB_TOKEN` 发布并关联：

```text
ghcr.io/suixinlei/opencode-v1-to-v2-target
```

当前发现 tag：

```text
1.18.9-4da7bb44
```

2026-07-31 验证通过的 manifest digest：

```text
sha256:f96a27c656ae754f7ecfd2064ca5ab9b523c0acba34a129ded34fcb8fd8b75f7
```

验证使用全新的空 Docker credential directory，确认未登录客户端可以拉取。随后
针对该 digest 执行 `scripts/verify-target-image.ts`，结果为：

- `officialReplayVerified: true`；
- `cleanupVerified: true`；
- `sameSession: true`；
- `oldContextReachedModel: true`；
- `assistantWritePersisted: true`；
- `restartReadbackPassed: true`；
- `noNewSessionCreated: true`。

tag 只用于发现；所有迁移示例仍必须使用
`repository@sha256:digest`。镜像重新构建后，即使运行时文件未变，provenance 或
revision label 也可能产生新 manifest digest，因此用户应在每次执行前解析 tag。

## Branch protection

建议为 `main` 创建 ruleset：

- Pull request 才能合并；
- CI / `verify` 必须通过；
- 分支必须与 `main` 保持最新；
- conversation 必须 resolved；
- 禁止 force push 和 branch deletion。

项目目前只有一名维护者，可以暂缓强制 approval；CI 和禁止 force push 仍建议
启用。设置前应确认不会阻断 Dependabot 与 target image workflow 的正常更新。

## Issues 与协作

- 保持 Issues 开启，仓库已提供 bug/feature forms；
- Wiki 建议关闭，版本化文档统一维护在 `docs/`；
- Discussions 可在出现真实用户问答需求后开启；
- `CODEOWNERS` 当前把所有路径指向 `@Suixinlei`；
- Dependabot 分别按周检查 npm、按月检查 GitHub Actions。

## Release

首发采用 source-only `0.1.0`：

- `package.json` 保持 `"private": true`；
- tag 为 `v0.1.0`；
- 唯一支持的 target profile 是
  `opencode-v2@1.18.9+4da7bb44.official-musl-v1`；
- target image 使用上文 manifest digest，且已有 SBOM、provenance 与 attestation；
- GitHub Release 页面创建后应补充 source archive checksum；
- 不上传数据库、run 产物、容器凭证或私有 image 地址。

只有未来明确决定发布 npm package 后，才能移除 `"private": true`。
