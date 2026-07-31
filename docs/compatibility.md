# 兼容性

这个项目采用“固定 target profile + schema/语义检查”，不承诺任意 OpenCode
版本之间的通用迁移。

## 当前支持矩阵

| 项目 | 当前范围 |
| --- | --- |
| 迁移 recipe | `opencode-v1-history-to-v2-events@6` |
| Mixed recipe | `opencode-v1-history-to-v2-events@6+mixed-splice@3` |
| V2 target profile | `opencode-v2@1.18.9+4da7bb44.official-musl-v1` |
| OpenCode version | `1.18.9` |
| OpenCode commit | `4da7bb44c84e013fa53e9c5d02ac753d1435c81a` |
| OpenCode `linux/amd64` musl binary SHA-256 | `fcd56e4ea76e80b08b936cd2fb3dff18a1eaf8c871180e66e2e7424c3634c188` |
| OpenCode `linux/arm64` musl binary SHA-256 | `6f08a8a1e91dfe0720d2b6eae8767c10d236c808b7147c5c1944da2862b0b0ce` |
| Runtime | Bun `1.3.x` |
| Database | 已 checkpoint、无非空 WAL 的 SQLite `opencode.db` backup |
| 平台 | macOS、Linux；Windows 未验证 |

source session 是否可迁移由实际 schema、event 和 projection 语义决定，不只看
数据库里记录的版本号。无法完全识别的数据会被阻断。

## Session 分类

| 分类 | 默认行为 |
| --- | --- |
| `legacy-only` | 可进入普通 inventory、plan、migration 和 cleanup |
| `legacy-and-v2` | 普通流程保护，不会因为仍有 `message/part` 就误判为纯 V1 |
| `v2-only` | 保护，不参与 V1 migration |
| `neither` | 无迁移内容 |

显式传入 `--session` 只缩小选择范围，不会绕过 schema、owner、sequence、V2
state 或投影一致性检查。

## Mixed session

高级 mixed migration 当前识别：

- `bootstrap-v2-then-legacy`；
- `legacy-then-v2`；
- `v2-then-legacy-tail`；
- `v2-dual-write-cleanup`。

它会在需要时把生成的 V2 events 插入已有 V2 前缀/后缀之间，并同步调整
`session_message`、`session_input` 和 context baseline sequence。只有已知的
历史 optional-field 投影差异可以规范化；其他差异仍然阻断。

`v2-dual-write-cleanup` 要求每条 legacy message 都已有同 ID、同 role、同创建
时间的 V2 message，且所有 legacy parts 都从属于这些已覆盖 message。该形态
不生成 event、不移动 sequence，只清理 V2 已完整覆盖的旧双写 projection。

Mixed migration 应先对单 session 做 canary，不能用普通 V1 批处理的成功经验
替代验证。

## OpenCode image

需要 Docker 的 official replay 和 local continuation proof 使用同一个
OpenCode target image。这个镜像只提供固定 projector/API，不包含迁移程序或
任何用户数据。公开构建定义位于
[`docker/opencode-target`](../docker/opencode-target/README.md)，发布地址为：

```text
ghcr.io/suixinlei/opencode-v1-to-v2-target
```

tag 只用于发现。执行迁移时必须通过以下任一方式提供 digest 引用：

```bash
--image <registry>/<repository>@sha256:<digest>
```

或：

```bash
export OPENCODE_MIGRATION_IMAGE=<registry>/<repository>@sha256:<digest>
```

tag-only 镜像会被拒绝。容器启动前后还会校验：

- 镜像引用包含 SHA-256 digest；
- `opencode --version` 等于 `1.18.9`；
- 容器架构为 `x86_64` 或 `aarch64`；
- 容器内 OpenCode binary SHA-256 等于对应架构的固定值。

续聊证明的本地 mock model 单独运行在 digest-pinned
`oven/bun:1.3.13-alpine` helper image 中，不要求 target image 携带 Bun。
`--direct-replay` 不需要 Docker image，但它不能代替首次 canary 的 official
replay 和续聊证明。

本 profile 从旧的组织内镜像身份切换到 OpenCode 官方 release musl 资产时增加
了 `.official-musl-v1` 后缀。旧 plan 会因 target profile 不同而失效，必须重新
inventory，不能手工改写。

## 为什么 plan 会失效

plan 同时绑定：

- migration recipe；
- target profile；
- source schema fingerprint；
- source session 内容摘要；
- 受保护 session 语义摘要。

其中任何一项变化，旧 plan 都会被拒绝。不要手工编辑 plan 来绕过失效检查。

## 扩展新版本

支持新的 OpenCode target 不是只改版本常量。至少需要：

1. 审核目标 commit 的 V1 lowering、durable event 和 projector 语义；
2. 新建 recipe / target profile 标识，使旧 plan 失效；
3. 增加人工 fixture 和未知形态的 fail-closed 测试；
4. 通过 official replay、数据库 verifier、cleanup 和 continuation proof；
5. 更新本文件与 release notes。
