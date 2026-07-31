# 安全策略

## 报告安全问题

请不要通过公开 issue 报告漏洞、真实数据库内容、内部地址或凭证。优先通过
[GitHub Security Advisory](https://github.com/Suixinlei/opencode-v1-to-v2/security/advisories/new)
私下联系维护者；如果该入口不可用，请先通过维护者 GitHub 主页请求一个私密
联系方式，不要在公开内容中附带漏洞细节。

报告中请只提供复现所需的最小信息：

- 受影响版本或 commit；
- OpenCode target profile；
- 问题类型、影响和最小复现步骤；
- 已匿名化的 schema、计数、摘要或人工 fixture。

不要附带真实 `opencode.db`、Cookie、AK、prompt、reasoning、tool output、用户
ID 或生产主机信息。维护者确认安全传输方式前，不要发送敏感附件。

## 支持范围

当前为源码预览阶段，仅 `main` 的最新代码和
[兼容矩阵](docs/compatibility.md)列出的 target profile 接收安全修复。正式
release 后，将只支持最新受支持 release。

## 安全设计边界

本工具应始终：

- 只从已 checkpoint 的一致性备份读取；
- 在独立 candidate 上执行写入；
- 对未知数据形态 fail closed；
- 要求显式 `--execute` 才执行写操作；
- 对报告进行脱敏，并将 run 目录和文件限制为私有权限；
- 在替换 live database 前保留可验证、可恢复的 backup。

绕过上述边界的问题应按安全问题处理。
