# Fleet operations adapter

`ops/` 不是 V1 → V2 转换算法本身。它是一套面向“很多远端
`opencode.db`”的参考运维 adapter，用来把本地迁移核心接入停写、SSH、checkpoint、
backup、原子替换、外部验收和回滚流程。

只迁移一个本地 backup 的用户不需要使用这里的脚本，应从根目录 README 的
`inventory → migrate-local → cleanup-local` 开始。

## 它负责什么

| 脚本 | 作用 |
| --- | --- |
| `production_storage_inventory.py` | 远端只读扫描，下载 checkpoint snapshot 并生成普通 V1 inventory |
| `production_storage_migrate.py` | 单库/批量停写、backup、candidate、验收、原子替换和失败回滚 |
| `prepare_parallel_manifest.py` | 冻结纯 V1 数据库清单并按工作量分配 worker |
| `prepare_mixed_manifest.py` | 冻结并分类 mixed session 清单 |
| `production_mixed_migrate.py` | 对已批准的 mixed session 执行 canary/batch |
| `final_storage_audit.py` | 批次完成后的 WAL-aware 全盘只读收口 |
| `remote/*.py` | 通过 stdin 发往远端执行的最小 Python helper |

## 环境假设

这组 adapter 当前假设：

- 通过 SSH/SCP 访问远端主机；
- canonical database 位于
  `/data/sandbox-storage/<scope>/<owner>/opencode/opencode.db`；
- 外部 controller 能暂停/恢复 writer，并返回可验收的 session messages；
- 本地已安装 Bun、Python 3、SSH、SCP、Docker 和本项目依赖；
- operator 能提供真正的独占租约，而不只依赖“当前进程看起来 idle”。

这些是假设，不是公共迁移核心的要求。其他部署布局应实现自己的 adapter，不应
放宽 core planner/verifier 的不变量。

## 必填配置

脚本不提供主机或 controller 的默认值。涉及远端操作时必须显式传入：

```bash
--host <ssh-target>
--controller-base <https-url>
```

需要 official replay 时，还必须通过 `--image` 或
`OPENCODE_MIGRATION_IMAGE` 提供 digest-pinned OpenCode image。

## 风险边界

- 所有变更命令继续要求 `--execute`；
- 每个 database 都必须有独立 backup、candidate、receipt 和回滚证据；
- 任一未知数据库形态只阻断该 database；
- global pause 只能阻止 worker 继续，不能替代真实 admission pause；
- 在适配自己的环境前，必须逐行审核远端路径、controller 契约和原子替换语义。

这套脚本目前作为参考 adapter 保留，不属于 `0.1.0` 的通用兼容承诺。
