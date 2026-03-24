# 飞书私聊 - 基础设施配置

## 项目列表

当前管理的项目（Jenkins 任务以项目名为前缀区分）：
- hotd
- kbn
- mc
- mrlh
- yxtf

## 基础设施

### GitLab
- URL: http://gitlab-cd.youzu.com/
- 用户: bot-nanoclaw
- Token: `1_b63oPYjzBsdJDbfCpB`

### Jenkins（临时凭据，后续会替换）
- URL: http://172.26.30.88:8080/
- 用户: bot-nanoclaw
- API Token: `1141eb19cf7f8d77e21445871f7ff213f4`

### Harbor
- URL: docker-cd.youzu.com
- 用户: robot$bot-nanoclaw
- 密码: `udD0jqfL9nAXuFZebAybpgGxzfBAkFiA`

### Rancher
- URL: rancher.jooyoo.com
- Bearer Token: `token-2t8mp:5s6p9gdgw99dql6knbgn9snkmbcs4s2nsxckvz5l5vbgvctx6mpp6g`

### Chart
- 不需要单独配置，Jenkins 构建完成后自动推送

## CI/CD 链路

```
需求描述 → 分析代码(GitLab) → 写代码/修Bug → 创建分支 → Push → 创建MR
    → 触发Jenkins构建 → 打包 → 推送Harbor → 生成Helm Chart
    → 更新Rancher部署 → 汇报结果
```

## 飞书消息格式

- 使用富文本格式，支持 **加粗**、*斜体*
- 不使用 Markdown 标题语法（##）
- 使用 • 作为列表符号
