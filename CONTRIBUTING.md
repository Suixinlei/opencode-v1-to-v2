# 参与贡献

感谢你帮助改进 OpenCode V1 → V2 session migration。这个工具会处理包含用户
对话历史的 SQLite 数据库，正确性、隐私和可恢复性优先于迁移速度。

## 开始之前

- 先阅读 [README.md](README.md) 的迁移语义和安全 Gate。
- 非小型改动请先提交
  [issue](https://github.com/Suixinlei/opencode-v1-to-v2/issues)，说明目标
  OpenCode 版本、数据库形态和失败恢复方案。
- 安全漏洞或可能暴露真实用户数据的问题不要提交公开 issue，请按
  [SECURITY.md](SECURITY.md) 私下报告。

## 本地开发

要求 Bun `1.3.x`。安装依赖并执行完整验证：

```bash
bun install --frozen-lockfile
bun run verify
```

`bun run verify` 必须同时通过 TypeScript 类型检查和全部测试。涉及 `ops/`
Python 脚本时，还应执行：

```bash
PYTHONPYCACHEPREFIX=/tmp/opencode-v1-to-v2-pycache \
  python3 -m compileall -q ops
```

official replay 与 continuation proof 属于 Docker 集成测试，不应被普通单元测试
隐式触发。提交相关改动时，请在 PR 中记录使用的 OpenCode image digest、
binary digest、平台和验收结果。

## 数据与 Fixture

- 禁止提交真实 `opencode.db`、WAL/SHM、backup、run receipt、Cookie、AK、
  prompt、reasoning、tool output 或用户标识。
- 测试数据必须是人工构造或经过不可逆匿名化的最小 fixture。
- 失败消息、snapshot 和调试工具默认只能输出结构、计数和摘要，不得输出消息
  正文。
- 新增文件格式或报告字段时，应补测试证明其中不包含会话正文和凭证。

## 改动原则

- 保持 fail closed：未知 schema、event、part、tool state 或投影偏差必须阻断，
  不能静默跳过。
- 保持可恢复：写操作只面向独立 candidate，并继续要求显式 `--execute`。
- recipe、OpenCode 版本、binary digest 或投影语义变化时，必须使旧 plan 失效。
- 行为变化必须补测试；CLI 参数、产物字段或操作步骤变化必须同步更新文档。
- 不要把组织专用地址、账号、目录布局或凭证读取方式加入公共核心。

## Pull Request

PR 描述至少应包含：

- 问题与改动范围；
- 支持或拒绝的 session 形态；
- 数据安全和回滚影响；
- 执行过的验证命令与结果；
- 是否改变 recipe、target profile 或产物 schema。

请保持提交聚焦，不要把无关重构与迁移语义变化混在一起。

除非贡献者明确另行说明，提交到本项目的贡献按
[Apache License 2.0](LICENSE) 授权。
