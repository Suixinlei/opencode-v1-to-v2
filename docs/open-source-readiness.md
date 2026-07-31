# 开源就绪度盘点

更新日期：2026-07-31

当前结论：GitHub 仓库
[`Suixinlei/opencode-v1-to-v2`](https://github.com/Suixinlei/opencode-v1-to-v2)
已经创建且为空。当前 tree 已具备发布 **source-only `0.1.0` preview** 的基础，
但**不能把当前本地 Git 历史直接推入公开仓库**。首次推送前还要完成最终 tree
扫描并创建干净 initial commit。公开 target image 的可审计构建、发布 workflow
和本地 digest-pinned Docker 端到端验证已经完成；首次推送后仍需确认 GHCR
workflow 成功、package 已设为 public，并从匿名客户端按 digest 拉取。更通用的
fleet adapter 仍是“生产就绪”缺口，不阻止带明确限制的源码预览。

## 建议的公开边界

| 层级 | 建议 | 当前内容 |
| --- | --- | --- |
| 公共核心 | 保留并持续泛化 | inventory、planner、recipe、projector、verifier、candidate migration、cleanup、匿名 fixture |
| 公共集成 | 改成显式可配置 | official replay、local continuation proof、OpenCode target profile |
| 组织适配 | 移出公共默认路径或独立私有包 | live continuation proof、生产 SSH/SCP 编排、固定存储布局和 controller API |
| 运行证据 | 永不发布 | `runs/`、数据库、WAL/SHM、backup、receipt、生产扫描和调试导出 |

公共核心不应依赖组织 package scope、私有 OCI registry、内部域名、生产 IP、
root SSH、固定 `/data/sandbox-storage` 布局或 Cookie/session 鉴权。

## Source preview 发布 Gate

| 状态 | 缺口 | 完成标准 |
| --- | --- | --- |
| 已完成 | 开源许可证和版权主体 | Apache-2.0；`LICENSE` / `NOTICE` 已加入，copyright 为 Suixinlei |
| 已完成 | 第三方来源与许可证兼容 | OpenCode 固定 commit 为 MIT，AI SDK 6.0.168 为 Apache-2.0；已加入 `THIRD_PARTY_NOTICES.md` |
| 进行中 | OpenCode image | 双架构构建与 ARM64 完整 replay/cleanup/continuation 已通过；还需首次 GHCR 发布后设为 public 并匿名拉取 |
| 已满足预览 | Fleet adapter | 主机/controller 私有默认值已移除，`ops/README.md` 明确其固定布局和非通用兼容承诺；后续可继续抽成独立 integration |
| 已定方案 | Git 历史清理 | 公开仓库为空；完成净化后创建全新首个 commit，不推送当前含内部标识的 5 个本地历史 commit |
| 已定方案 | 发布形态 | 首发 source-only；仓库与 package metadata 已指向 GitHub，`private: true` 继续阻止 npm 发布 |
| 部分完成 | 维护与安全渠道 | owner 为 Suixinlei，使用 GitHub Security Advisory；仍需在仓库设置中启用 private reporting |
| 已完成 | 公共兼容矩阵 | 固定 profile、Bun、双架构资产摘要已记录；AMD64/ARM64 build identity 与 ARM64 完整端到端已验证 |

源码预览阶段 `package.json` 必须保持 `"private": true`，避免仓库公开被误解为
npm package 已发布。生产就绪前，README 必须保留 image 和 fleet adapter 限制。

## 工程与社区完善项（P1）

| 状态 | 内容 |
| --- | --- |
| 已补充 | `CONTRIBUTING.md`：开发、测试、隐私和 PR 约束 |
| 已补充 | `SECURITY.md`：私密报告方式与安全边界 |
| 已补充 | `CODE_OF_CONDUCT.md` |
| 已补充 | GitHub CI、PR 模板和结构化 bug issue 模板 |
| 已补充 | `.gitignore`、`.gitattributes`、`.editorconfig` 与 changelog 骨架 |
| 已补充 | CLI 无参数、`-h`、`--help` 成功输出使用说明，并有回归测试 |
| 已补充 | README 的作用、适用场景、输入输出、安全保证和快速开始 |
| 已补充 | 架构、兼容性、安全模型与第三方归属文档 |
| 已补充 | GitHub Dependabot 配置 |
| 已补充 | CODEOWNERS 与公开仓库 Settings/首次推送清单 |
| 待处理 | TypeScript formatter/linter 和确定性格式检查 |
| 待处理 | Python 脚本的独立测试、lint 和公开/内部边界拆分 |
| 已补充 | `scripts/verify-target-image.ts` 用匿名 fixture 完成 official replay、cleanup、续聊和重启读取，不接触生产服务 |
| 待处理 | 测试覆盖率基线和关键 fail-closed 分支清单 |
| 已补充 | 英文 README；深层维护文档仍以中文为主 |
| 已补充 | Target image workflow 生成 SBOM、BuildKit provenance 和 GitHub artifact attestation |

## 当前已发现的具体外泄面

公开前必须处理而不是只在 README 中隐藏：

- `ops/` 中的公司域名、内网 IP、root SSH 默认值和固定生产存储布局；
- `prove-continuation-live` 中与 Runtime Coworker 强耦合的 app/user/cookie/controller
  契约；
- 已从当前工作树删除、但仍存在于历史 commit 的 `.DS_Store`；
- 本地 Git 历史中的私有 registry、组织 package scope、域名和 IP。公开仓库当前
  为空，应从净化后的 tree 创建新历史，不能 push 这 5 个本地 commit。

当前 tracked 文件的轻量模式扫描未发现明显私钥或常见云 token，但这不能替代
发布前的全历史专业 secret scanning 和人工审阅。

## 推荐推进顺序

1. 完成当前 tree 的 secret/PII/内部元数据扫描；只从净化后的 tree 创建公开
   initial commit。
2. 确认 GitHub CI 与 target image workflow 通过，把 GHCR package 设为 public。
3. 从未登录环境按 manifest digest 拉取镜像并重跑匿名 target image 验收。
4. 增加覆盖率基线、关键 fail-closed 分支清单和 Python ops 独立测试。
5. 继续把固定存储布局的 fleet adapter 抽成独立 integration。
6. 发布 source-only `0.1.0`；只有决定发布 npm package 后才移除 `private`。
