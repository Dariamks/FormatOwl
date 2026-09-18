# 管理员后台

入口 `/admin`，登录页 `/admin/login`。默认用户名 `admin`、密码 `admin123`，只有一组管理员凭据，没有注册或添加管理员入口。前台 Better Auth 用户不能通过普通登录获取后台权限。

## 本地配置与启动

先启动本地 PostgreSQL、存储等依赖并执行 `pnpm setup:local`，应用 `0014_admin_console.sql`。本次新增四张表：`admin_sessions`、`admin_user_profiles`、`admin_recharges`、`tool_visibility`。

可在项目 `.env` 中配置：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ADMIN_SESSION_SECRET=
```

`ADMIN_SESSION_SECRET` 留空时复用 `BETTER_AUTH_SECRET`，至少 32 个字符。认证配置只在服务端使用；改动后重启 web。凭据或会话密钥变更会使旧会话失效。会话使用随机 token，数据库仅保存 HMAC 哈希，HttpOnly、SameSite=Strict，HTTPS 环境设 Secure，12 小时过期。登录接口共享数据库限流，每分钟最多 10 次尝试；写接口严格校验 Origin。退出删除服务端会话。

## 用户与充值

用户列表仅列注册账号，支持邮箱/用户名搜索、状态筛选、分页。游客不进入用户列表。后台显示可用积分、预留积分、累计到账及累计消耗；账户尚未有积分记录时显示 0。

用户详情包括账号资料、充值记录、积分流水、任务记录、计费操作与成本用量。充值金额汇总只统计本后台记录的人民币充值；历史 CLI 发放没有人民币凭证，因此只进入累计到账积分。任务文件仍遵循原有到期清理规则，删除的任务不会重新生成；账单保留其操作记录。各类记录每页 50 条，可翻页查阅；累计指标取全部记录。

手动充值填写人民币金额（非负、最多两位小数）、到账积分（1 至 10 亿的整数）、唯一凭证编号和选填备注。允许金额 0 的赠送积分。积分不自动按人民币兑换，按填写值发放。

充值以唯一凭证编号去重，同一编号、用户、金额、积分、备注重试返回原记录；内容不一致返回冲突。事务内写入充值记录、积分账户和账本，并以充值记录 ID 关联 grant 幂等键。并发重复提交只入账一次，任一步失败全部回滚。这里记录管理员确认的线下收款，不会触发第三方收款，也不会开启前台支付。

封禁后，用户仍可登录、读取账本和历史任务、下载已有结果、取消或删除任务。新上传（包括签署分片和完成上传）、报价、处理、预处理、批处理、导出、阅读和重试均拒绝。已提交的任务继续处理。解封后允许新请求；不自动取消历史工作，也不调整积分。

## 工具上下架

静态 catalog 是工具信息来源；数据库保存发布状态。新迁移默认上架全部现有工具，重复运行初始化不会覆盖已保存的状态。

下架立即作用于后续请求：隐藏首页卡片、分类入口及列表、示例、格式转换快捷入口、相关工具链接、价格页工具列表及 sitemap 条目；对应工具页与格式别名页返回 404。分类无可见工具时返回 404 并从 sitemap 移除。已打开页面可能仍显示旧内容，但后端拒绝新处理与重试。历史结果继续可查看和下载。

上架恢复这些入口。不会改变 worker 能力或供应商配置；上架表示允许使用，实际处理仍遵循原有能力检查。恢复发布不自动重跑旧任务。

## API

所有 `/api/admin/*`（登录除外）要求管理员会话，响应禁止缓存。管理接口不会使用普通用户的 owner 参数。

- `POST login`、`POST logout`、`GET session`：独立管理员会话。
- `GET overview`：用户数量、积分及近 30 天充值/使用统计。
- `GET users?query=&status=all|active|blocked&page=1&pageSize=20`：用户分页查询。
- `GET users/:id?historyPage=1`：资料、积分、充值、账本、任务和用量明细。
- `POST users/:id/recharge`：`receipt`、`amountCny`、`credits`、可选 `note`。
- `PATCH users/:id/status`：`blocked`、可选 `reason`。
- `GET tools`、`PATCH tools/:id`：工具列表与 `published` 开关。

未认证返回 `ADMIN_REQUIRED`，封禁返回 `USER_BLOCKED`，下架返回 `TOOL_UNPUBLISHED`，冲突返回 `IDEMPOTENCY_CONFLICT`。

## 验证

```bash
pnpm test:admin
pnpm test:admin:e2e
pnpm test:billing
pnpm test
pnpm typecheck
pnpm build
```

`test:admin` 在独立本地数据库中执行并销毁数据库，覆盖迁移、8 路并发相同凭证、冲突、金额验证、余额隔离、注入账本失败后的整笔回滚、查询汇总、封禁及上下架。

浏览器测试要求本地 web 与数据库运行，创建专用测试账号和记录。结束时清理测试数据并恢复此前工具发布状态；截图保存在忽略的 `.data/`。覆盖未登录/普通用户越权、Origin、会话过期/注销、充值、封禁/恢复、下架/重新上架、转换别名、空分类、桌面和 390px 手机布局。
