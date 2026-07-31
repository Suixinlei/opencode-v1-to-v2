# 开源就绪度盘点

更新日期：2026-07-31

当前结论：项目已经具备对外提供 **source-only `0.1.0` preview** 的条件。
[`Suixinlei/opencode-v1-to-v2`](https://github.com/Suixinlei/opencode-v1-to-v2)
使用净化后的新历史公开，CI、双架构 target image、匿名按 digest 拉取和完整
迁移/续聊验收均已通过。

这个结论不等于“通用生产迁移器”。当前只承诺一个固定 OpenCode target
profile，更通用的 fleet adapter、Python ops 自动化测试和覆盖率基线仍是后续
工程项。外部用户应先对 backup 做单 session canary，不应直接处理 live database。

## 项目的公共边界

| 层级 | 对外定位 | 当前内容 |
| --- | --- | --- |
| 公共核心 | 已公开 | inventory、planner、recipe、projector、verifier、candidate migration、cleanup、匿名 fixture |
| 公共集成 | 已公开且显式配置 | official replay、local continuation proof、固定 OpenCode target profile |
| 组织适配 | 仅保留无私有默认值的参考 adapter | live continuation proof、生产 SSH/SCP 编排、固定存储布局和 controller API |
| 运行证据 | 永不发布 | `runs/`、数据库、WAL/SHM、backup、receipt、生产扫描和调试导出 |

公共核心不依赖组织 package scope、私有 OCI registry、内部域名、生产 IP、
root SSH、固定 `/data/sandbox-storage` 布局或 Cookie/session 鉴权。

## Source preview 发布 Gate

| 状态 | 项目 | 完成情况 |
| --- | --- | --- |
| 已完成 | 开源许可证和版权主体 | Apache-2.0；`LICENSE` / `NOTICE` 已加入，copyright 为 Suixinlei |
| 已完成 | 第三方来源与许可证兼容 | OpenCode 固定 commit 为 MIT，AI SDK 6.0.168 为 Apache-2.0；已加入 `THIRD_PARTY_NOTICES.md` |
| 已完成 | 干净公开历史 | 从 77 个净化文件创建新 root commit；原本地含内部元数据的历史未推送 |
| 已完成 | CI 与依赖锁定 | Bun 1.3.13、TypeScript 7.0.2；macOS/Linux 均为 46 项测试通过；GitHub Actions 使用 commit SHA |
| 已完成 | OpenCode target image | `linux/amd64` / `linux/arm64` 构建、SBOM、provenance、attestation 和匿名拉取均通过 |
| 已完成 | 完整匿名验收 | 对公开 digest 完成 official replay、cleanup、同 session 续聊、落库与重启读回 |
| 已满足预览 | Fleet adapter | 主机/controller 私有默认值已移除；固定布局和非通用兼容承诺已写入 `ops/README.md` |
| 已完成 | 发布形态 | source-only `0.1.0`；`private: true` 继续阻止意外 npm 发布 |
| 部分完成 | 维护与安全渠道 | `SECURITY.md` 和 Advisory 路径已提供；账户级 private reporting、ruleset 等仍需 owner 登录设置 |
| 已完成 | 公共兼容矩阵 | 固定 profile、Bun、双架构资产摘要和明确拒绝范围已记录 |

源码预览阶段 `package.json` 必须保持 `"private": true`，避免仓库公开被误解为
npm package 已发布。

## 已验证证据

- GitHub CI workflow：安装 frozen lockfile、TypeScript typecheck、46 项 Bun 测试和
  Python syntax check；
- target image workflow：amd64/arm64 构建、GHCR push、SBOM、BuildKit
  provenance 与 GitHub artifact attestation；
- 公开镜像：
  `ghcr.io/suixinlei/opencode-v1-to-v2-target@sha256:f96a27c656ae754f7ecfd2064ca5ab9b523c0acba34a129ded34fcb8fd8b75f7`；
- 匿名 pull：使用空 Docker credential directory 成功；
- 完整验收：official replay、legacy cleanup、旧上下文进入 mock model、同 session
  assistant write、重启读回和未创建新 session 全部通过；
- 发布前扫描：Gitleaks、常见内部元数据模式、大文件、Markdown link、YAML 和
  Python 语法检查。

镜像 digest 是一次已验证证据，不是永久别名。tag 重新构建后，应解析新 digest
并重跑相同验收。

## 工程与社区状态

| 状态 | 内容 |
| --- | --- |
| 已补充 | `CONTRIBUTING.md`：开发、测试、隐私和 PR 约束 |
| 已补充 | `SECURITY.md`：私密报告方式与安全边界 |
| 已补充 | `CODE_OF_CONDUCT.md` |
| 已补充 | GitHub CI、PR 模板和结构化 bug/feature issue forms |
| 已补充 | `.gitignore`、`.gitattributes`、`.editorconfig` 与 changelog |
| 已补充 | CLI 无参数、`-h`、`--help` 安全输出使用说明，并有回归测试 |
| 已补充 | 中英文 README、架构、兼容性、安全模型与第三方归属文档 |
| 已补充 | GitHub Dependabot、CODEOWNERS 与仓库设置清单 |
| 已补充 | 公开、可审计、digest-pinned target image 与完整匿名验收脚本 |
| 待处理 | TypeScript formatter/linter 和确定性格式检查 |
| 待处理 | Python ops 的独立测试、lint 和更通用的 integration 边界 |
| 待处理 | 测试覆盖率基线和关键 fail-closed 分支清单 |
| 待处理 | 深层维护文档的英文版 |
| 账户设置 | About/topics、private vulnerability reporting、`main` ruleset、关闭 Wiki |
| 发布页面 | GitHub Release 页面和 source archive checksum |

这些待处理项不阻断 `0.1.0` source preview，但在扩大真实数据库使用范围前，应优先
补齐 Python ops 测试和覆盖率基线。

## 外泄面处理结果

发布前发现的风险包括：

- `ops/` 曾包含公司域名、内网 IP、root SSH 默认值和固定生产存储布局；
- live continuation adapter 曾与组织 app/user/cookie/controller 契约强耦合；
- 原本地历史曾包含 `.DS_Store`、私有 registry 和组织 package scope。

处理结果：

- 公共 tree 已移除私有默认值，组织相关参数改为显式输入；
- 公开 GitHub 历史从净化后的 tree 新建，没有推送原本地历史；
- `runs/` 只保留 `.gitignore`，数据库、WAL、backup 和报告均未发布；
- candidate tree 的专业 secret scan 未发现泄漏。

扫描结果只能证明当前公开 tree 和新历史的已检查状态，不能替代未来每次发布前的
持续扫描。

## 后续优先级

1. 用 owner 登录态完成 About/topics、安全开关、`main` ruleset 和 Wiki 设置；
2. 在 GitHub Release 页面补充 `v0.1.0` 说明与 source archive checksum；
3. 增加 TypeScript formatter/linter 和覆盖率基线；
4. 给 Python ops 增加独立测试并继续抽离固定基础设施假设；
5. 让外部用户只用匿名 fixture 或 backup 做 canary，收集兼容性反馈；
6. 只有决定发布 npm package 后才移除 `"private": true`。
