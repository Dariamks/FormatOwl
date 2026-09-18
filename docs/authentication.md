# Better Auth 注册与登录

FormatOwl 使用 Better Auth 1.7.5 + 现有 PostgreSQL / Drizzle。无需申请 Better Auth 托管服务或 Supabase Auth。当前统一本地入口为 http://127.0.0.1:3000；APP_URL、BETTER_AUTH_URL 和 Google 回调使用同一个主机名，避免 localhost 与 127.0.0.1 的 Cookie 不互通。

## 当前流程

- 顶部按钮打开登录 / 注册弹窗，直接访问 `/zh/login` 或 `/en/login` 也可使用。
- 邮箱 + 密码注册；密码 12–128 字符，由 Better Auth 哈希。验证链接 1 小时有效，验证后需主动登录，避免打开别人的验证链接就切换账户。
- 邮箱验证重发、登录错误、倒计时、忘记密码、重置确认。重置链接 30 分钟有效，用后失效；密码更新撤销全部既有会话。
- Google OAuth 已接入，配置 Client ID / Secret 后显示可用。尚未完成真实 Google 账号回调验收，不包含截图右上角的 Google One Tap。
- 服务器逐次核验会话；登录有效期 30 天、每日刷新。HttpOnly / SameSite=Lax Cookie，HTTPS 下启用 Secure；没有浏览器 Cookie 数据缓存。
- 登录后的首个业务请求，在数据库事务中把当前游客的文件、任务、批次和编辑预览归入账户。已领取的游客 Cookie 被作废，不能用另一账户重复领取；并发创建使用同一事务锁。
- 游客继续可用。登录不赠送积分，也不改变文件 24 小时有效期。

## 现在需要申请什么

### 1. Google 登录（没有正式域名也可先申请）

打开 [Google Cloud Console](https://console.cloud.google.com/)，创建或选择 FormatOwl 项目。在 Google Auth Platform 配置 Branding / Audience，填写应用名、支持邮箱和开发者联系邮箱。面向公众使用 External；测试阶段将自己的 Google 邮箱加入 Test users。

创建 OAuth Client，类型选 **Web application**：

| 项目                          | 本地填写值                                       |
| ----------------------------- | ------------------------------------------------ |
| Authorized JavaScript origins | `http://127.0.0.1:3000`                          |
| Authorized redirect URIs      | `http://127.0.0.1:3000/api/auth/callback/google` |

将 Client ID 和 Client Secret 填入本地 `.env`，不放入聊天、Git 或 `NEXT_PUBLIC_*`：

```dotenv
GOOGLE_CLIENT_ID=你的客户端ID
GOOGLE_CLIENT_SECRET=你的客户端密钥
```

重启 web，打开上述本地地址点击 Google 登录。拿到正式域名后增加 `https://你的域名/api/auth/callback/google`，并把 APP_URL / BETTER_AUTH_URL 一起改为该 HTTPS 地址。不要使用旧的 `/auth/callback` 或 Supabase 回调。

依据：[Better Auth Google 配置](https://better-auth.com/docs/authentication/google)、[Google Web 客户端配置](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)。

### 2. Resend 邮件

已选择 Resend。先在 [Resend](https://resend.com/signup) 创建账号；有自己的域名后，在 Domains 添加用于发信的域名或子域，例如 `mail.你的域名`。按 Resend 显示的值到域名 DNS 控制台添加记录，等待域名显示 Verified。

创建仅有 Sending access、限定该域名的 API Key。设置发件人邮箱，例如 `FormatOwl <hello@mail.你的域名>`：

```dotenv
AUTH_EMAIL_MODE=resend
RESEND_API_KEY=你的发送密钥
AUTH_EMAIL_FROM=FormatOwl <你的发件邮箱>
```

重启 web 后测试注册验证和找回密码的实际收件。当前没有域名，不必为了本地开发临时购买邮件套餐。Resend 的默认测试发件域名不能作为面向所有用户的正式发信配置。

依据：[Resend 域名验证](https://resend.com/docs/dashboard/domains/introduction)、[发送邮件](https://resend.com/docs/send-with-nodejs)。

## 本地邮件与开发

`.env.example` 默认 `AUTH_EMAIL_MODE=local`。`pnpm setup:local` 顺序执行新迁移 `0010_better_auth.sql`，并在 BETTER_AUTH_SECRET 为空时生成随机密钥到被忽略的 `.env`；不会输出密钥。

本地测试邮件存入项目 `.data/auth-mail/*.json`，包含收件人、正文与验证 / 重置链接。用编辑器打开对应邮件文件，复制 `url` 到浏览器即可验证；不会真的发送邮件。该目录无 HTTP 访问入口，文件权限为 600，目录为 700，不提交到 Git。开发结束可清理这些本地测试邮件。

本地模式同时要求非 production 且认证地址为 loopback。生产构建 / 启动绝不启用本地邮件模式；未配置 Resend 时邮箱入口不可用。发信使用 Next.js `after` 执行，错误只记录不带地址或令牌的日志；页面的“检查邮箱”表示请求被接受，不保证服务商已经投递，可稍后重发。

```bash
pnpm setup:local
pnpm --filter @filemorph/web dev
pnpm test:auth
pnpm typecheck
pnpm build
```

`test:auth` 要求 web 已启动、AUTH_EMAIL_MODE=local、BETTER_AUTH_URL=http://127.0.0.1:3000。它创建随机 example.test 账号并清理自身账号和任务，不访问 Google、不向真实邮箱发信、不收费。

## 验收与上线剩余项

2026-09-16 本地验收：80 项单元测试、15 项媒体集成检查、类型检查和生产构建通过。4 项认证浏览器 / API 用例与 4 项原有压缩浏览器回归经分组复验全部通过；并行构建时曾出现机器负载导致的加载超时与连接重置，单独复验已通过。

覆盖注册 / 验证 / 登录 / 刷新 / 登出、密码重置与旧密码拒绝、重置令牌重放、撤销所有会话、数据库密码哈希、游客转移与跨账户隔离、过时游客并发请求、Origin / 回调地址校验、接口限流、中英文与手机弹窗。

尚需配置后验收：Google 真实登录、同邮箱 Google / 密码账户连接、Resend 实际送达与垃圾箱表现、正式域名 HTTPS Cookie、生产邮件告警。原始数据库及服务迁移遵循项目部署审批，不会由注册功能自动部署。

生产只允许从可信代理访问 web，代理须覆盖客户端提交的 IP 转发头，再按实际平台配置 Better Auth `ipAddressHeaders` / `trustedProxies`。当前数据库中的认证限流已启用，但本地可直接访问的开发服务器不能替代生产入口的防滥用控制。来源：[Better Auth 限流](https://better-auth.com/docs/concepts/rate-limit)。

正式开放前还需提供平台自己的服务条款、隐私政策和账号删除 / 数据保留方案；当前弹窗不放空链接或引用竞品条款。本次未接入计费，未 push、创建 PR、运行远程 CI 或部署。
