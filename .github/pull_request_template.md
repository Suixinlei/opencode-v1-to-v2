## 问题与范围

<!-- 说明为什么需要这项改动，以及明确不包含哪些内容。 -->

## 数据安全与回滚

<!-- 是否接触数据库、会话正文、凭证、candidate、backup 或 live replacement？ -->

## 兼容性

<!-- 是否改变 recipe、target profile、OpenCode 版本、CLI 或产物 schema？ -->

## 验证

- [ ] `bun run verify`
- [ ] 未提交真实数据库、run 产物、用户数据、内部地址或凭证
- [ ] 行为变化已补测试
- [ ] CLI、产物或操作步骤变化已同步更新文档
- [ ] 涉及 Docker replay 时已记录 image/binary digest 与验收结果
