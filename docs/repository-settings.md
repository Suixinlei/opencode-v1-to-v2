# GitHub 仓库设置

目标仓库：[`Suixinlei/opencode-v1-to-v2`](https://github.com/Suixinlei/opencode-v1-to-v2)

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

## 首次推送

公开仓库当前为空。不要直接推送本地已有的 5 个 commit，因为其历史中包含私有
registry、组织 package scope、内网地址和 `.DS_Store`。

应当：

1. 完成 `ops/` 和 `live-continuation-proof` 的组织适配隔离；
2. 对最终公开 tree 做 secret、PII 和内部元数据扫描；
3. 从最终公开 tree 创建一个新的 initial commit；
4. 在临时 clone 中跑 `bun install --frozen-lockfile && bun run verify`；
5. 确认 GitHub 页面只显示净化后的新历史后再创建 `v0.1.0`。

本文件只记录要求，不授权自动 force-push 或重写当前本地仓库。

## Security

在仓库 Settings 中启用：

- Private vulnerability reporting；
- Dependabot alerts；
- Dependabot security updates；
- Secret scanning（账户计划支持时）；
- Push protection（账户计划支持时）。

`SECURITY.md` 已指向 GitHub Security Advisory。启用 private reporting 后再测试
一次未登录/普通用户看到的报告入口。

## Container package

`target-image.yml` 使用仓库 `GITHUB_TOKEN` 发布并关联：

```text
ghcr.io/suixinlei/opencode-v1-to-v2-target
```

GHCR 首次发布的 container package 默认是 private，仓库公开不会自动改变 package
visibility。首次 workflow 成功后，进入 package settings：

1. 保持 package 与本仓库关联；
2. 将 visibility 显式改为 public；
3. 退出登录后验证版本 tag 可以 inspect；
4. 按 workflow summary 中的 manifest digest 匿名拉取并执行 identity check。

README 只能展示 tag 作为发现入口；所有迁移示例仍必须使用
`repository@sha256:digest`。

## Branch protection

`main` 建议要求：

- Pull request 才能合并；
- CI / `verify` 必须通过；
- 分支必须与 `main` 保持最新；
- conversation 必须 resolved；
- 禁止 force push 和 branch deletion。

如果项目只有一名维护者，是否强制 approval 可以暂缓，但 CI 和 force-push
保护仍建议开启。

## Issues 与协作

- 保持 Issues 开启，仓库已提供 bug/feature forms；
- Wiki 可关闭，版本化文档统一维护在 `docs/`；
- Discussions 可在出现真实用户问答需求后开启；
- `CODEOWNERS` 当前把所有路径指向 `@Suixinlei`。

## Release

首发采用 source-only：

- `package.json` 保持 `"private": true`；
- release notes 必须写明唯一支持的 target profile；
- 附上 source archive checksum；
- 附上 target image manifest digest、SBOM 和 provenance；
- 不上传数据库、run 产物、容器凭证或私有 image 地址；
- 在有公开可复现 target image 前，不宣称 official replay 开箱即用。
