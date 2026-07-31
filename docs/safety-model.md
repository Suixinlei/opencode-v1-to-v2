# 安全模型

## 保护对象

迁移处理的 `opencode.db` 可能包含：

- 用户 prompt、assistant 回复和 reasoning；
- tool input/output、attachment 和 provider metadata；
- session、用户或业务标识；
- 可继续写入真实系统的模型和 agent 选择。

因此数据库、WAL/SHM、backup、candidate、调试导出和 run 产物都按敏感数据
处理。

## 主要风险

| 风险 | 项目中的控制 |
| --- | --- |
| 在活跃写入时复制出不一致数据库 | 要求停写并 checkpoint；拒绝非空 WAL |
| 覆盖唯一 live database | source/candidate 必须不同；工具不执行 live replacement |
| 未知 V1 形态被静默丢弃 | 未知 role、part、tool state、compaction 等 fail closed |
| 把真实 V2 session 当成 V1 清理 | 识别 V2 events/projections/context state 并默认保护 |
| plan 生成后 source 被修改 | schema/content/target digest 变化使 plan 失效 |
| replay 只完成一部分 | sequence 前缀识别、确定性续跑和完整 verifier |
| cleanup 删除续聊后的 V2 数据 | 只删除 legacy `message/part`，验证 V2 连续后缀 |
| 报告泄露会话正文或凭证 | 报告只保留摘要、结构、计数和布尔结果 |
| 镜像 tag 被替换 | 要求 digest-pinned image，并校验 binary version/hash |

## 操作模式

### 只读

`inventory` 和 `mixed-inventory` 只读取 checkpoint 后的 backup，输出 plan 和
脱敏 inventory。建议所有首次使用都从这里开始。

### Candidate 写入

`migrate-local`、`cleanup-local` 和 mixed 对应命令只写独立 candidate。所有写
命令要求显式 `--execute`，用于防止把查看 help 或漏参数误当执行授权。

### 外部发布

把 candidate 替换为 live database 不属于本项目的接口。operator 必须在自己的
环境中实现：

- 独占租约和新任务 admission pause；
- 停止现有 writer；
- 可恢复 backup；
- 原子替换与 fsync；
- 启动后的业务验收；
- 失败自动回滚。

## 文件权限

- run 目录：`0700`；
- JSON report：`0600`；
- sentinel / Cookie 文件：不得对 group 或 others 开放；
- backup/candidate：应由 operator 设置等价的最小权限。

`.gitignore` 会忽略常见 SQLite、WAL、Cookie 和环境文件，但忽略规则不能替代
提交前人工检查。

## 信任假设

项目假设：

- operator 提供的 backup 来自正确的 OpenCode 实例；
- 本机、Docker daemon 和镜像 registry 可信；
- SHA-256 未被破坏；
- candidate 所在文件系统支持预期的 SQLite、fsync 和原子文件操作；
- operator 不手工修改 plan、receipt 或 candidate。

如果这些条件不成立，不应把 verifier 通过解释为生产发布许可。

## 事故处理

如果迁移失败：

1. 不要继续 cleanup 或替换 live DB；
2. 保留原 backup，不在其上重跑写命令；
3. 保存脱敏 failure/verification report；
4. 使用人工 fixture 或结构摘要复现，禁止提交真实数据库；
5. 安全问题按 [SECURITY.md](../SECURITY.md) 私下报告。
