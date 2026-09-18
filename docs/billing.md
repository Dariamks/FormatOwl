# 成本、报价和积分账本

本地默认 **shadow（试算）**，销售关闭。生产环境在 shadow 下默认只允许样例和复用已有结果；受控成本测试才可显式设置 `BILLING_SHADOW_EXECUTION=true`。本地开发模式允许试算处理用于校准与测试。不是已接入支付，不会自动赠送积分，不追溯扣历史任务。完整价格缺少生产资源或网关结算证据时显示“待核价”，不显示零费用或伪造完整上限。

## Pricing 展示

Pricing 页面参考四档卡片展示：免费 $0、基础 $9、专业 $29、高级 $59，均标明 USD。免费档仅提供工具／示例入口，不赠送积分；三个付费档调整为 900 / 2,900 / 5,900 积分，仍为一次性积分包，不承诺包月、优先队列或不同上传上限。

美元展示价集中在 `billingDefaults.packDisplayUsd`，所含积分集中在 `billingDefaults.packCredits`，经 billing overview 返回，页面加载时使用同源默认值。它们是待启用的展示方案，不是按实时汇率换算；充值保持关闭。现有 CNY 成本、报价、账本及下述原经济口径未随本次展示改动调整，不能用旧 CNY 收入口径验收这些 USD 售价。正式开放销售前须确定美元结算、汇率与支付费用并重新核价。

所有工具新增处理前费用栏，参考估算与正式报价区分显示；核价依据及边界见 [处理前积分提示](credit-estimates.md)。

## 经济口径（旧 CNY 核算方案）

- 固定基础设施暂按 300 元/月；100 积分 = 1 元；积分包 29/99/299 元，不折扣、不赠送、不自动续费。
- 目标贡献毛利 70%，支付费预留 10%，直接与分摊成本加 20% 风险缓冲。积分 = ceil(成本微元 × 3 / 5000)，每个成功收费操作最低 1 分；取消且没有已发生用量不扣分。
- 消费收入 3000 元/月、变动成本及支付占 30% 时，扣固定 300 元后利润 1800 元，约 60%。没有销量仍有固定费用；429 元是该情景的近似保本收入，不是任何业务量下的盈利保证。
- 以已消耗积分对应收入计算，不把充值额全部当利润；失败释放冻结与已消费收入分开。包月内资源使用 category=allocated，月报只列分摊值，不再从 300 元固定成本之外重复扣除。
- 20% 缓冲是定价政策，不是供应商实际成本。月报缺少价格或用量时抑制利润数值。支付未核实前，报告里的支付成本始终标为预算。

全部 19 工具 × 小中大样本及附加操作见 [成本样本矩阵](pricing-cost-matrix.md)，通过 `pnpm billing:cost-table` 重新生成。矩阵明确区分官方价格、站内额度观察和未完成的生产实测。

## 数据和接口

### Waffo Pancake 支付

项目已接入 `@waffo/pancake-ts` 的服务端托管收银台：

- `POST /api/billing/checkout` 只接受 `basic`、`pro`、`premium` 三个服务端套餐标识，并根据环境变量映射到 Pancake 商品 ID；私钥不会进入浏览器。
- `POST /api/webhooks/waffo` 使用 Pancake 的原始请求体和签名校验，只处理指定店铺、指定环境的 `order.completed`，并用账本幂等键给已登录用户入账。
- 测试环境可设置 `WAFFO_TEST_CHECKOUT_ENABLED=true`；生产环境仍必须经过 `billing_settings.sales_enabled`、价格核验和生产审核，不会仅靠环境变量开放销售。
- 所有 Pancake webhook 都要配置为 Raw payload，并指向部署域名下的 `/api/webhooks/waffo`。本地联调需要能保留自定义请求头的 HTTPS 隧道。

所需服务端变量见 `.env.example`：`WAFFO_MERCHANT_ID`、`WAFFO_STORE_ID`、`WAFFO_PRIVATE_KEY`、`WAFFO_ENVIRONMENT`，以及各套餐的 `WAFFO_PRODUCT_*_ID`。

新增迁移 `0011_billing.sql`、`0012_billing_reports.sql` 和 `0013_billing_config_audit.sql`，不改旧迁移。

- 价格目录不可变版本：基础设施、ASR 秒数、模型输入/输出 Token、图片修复次数；记录路由、模型、价格阶梯、单位、证据及是否核实。报价和操作保存价格快照，发布新版本不会更改旧报价。
- `POST /api/quote` 接受 `{ operation: { path, body } }`。path 是现有 POST API 的相对路径，如 jobs、assets/:id/prepare、jobs/:id/reading、translation/transcript 导出、watermark runs、各 retry 和 batches/:id/archive。原单文件报价输入继续支持。
- 返回 id、state、estimatedCredits、maximumCredits、knownCredits、lines、stage、priceVersion、expiresAt、balance、mode。未知全价的 estimated/maximum 为 null，knownCredits 只是已知部分。有效期最多 15 分钟且不超过文件有效期。
- `GET /api/quotes/:id` 轮询分析状态。媒体探测在 worker，网页不读取媒体字节、运行 FFmpeg 或执行 OCR。单次探测限时 60 秒，每账户每日最多 20 个源文件；现有上传与并发限额继续执行。
- 所有收费 POST 在原请求 JSON 加 `billingQuoteId`。服务器剥离此字段，校验原始参数、输入归属、文件版本和报价指纹，再调用原业务校验。新增任务/attempt 与预留、账本、入队事实处于同一个数据库事务中。
- `GET /api/billing` 返回当前用户余额、积分包、最近操作与流水；`GET /api/billing/receipts/:id` 返回本人账单明细。没有接受客户端积分数、账单金额或管理员授权的写接口。
- `/zh/pricing`、`/en/pricing` 提供套餐、计费规则、全部工具计费依据与个人账单。所有收费调用共用确认弹窗，包括预览、AI 问答、再次导出。试算模式不弹付费授权、不扣款。

## 计量与生命周期

共享计费模块由业务服务在现有事务中调用。客户端先以 `billingReuseOnly=true` 尝试复用；缓存命中直接返回原结果，不新增账本预留。需要新任务时事务回滚并返回 BILLING_NEW_WORK_REQUIRED，随后才获取报价并确认；因此待核价或余额不足不会阻挡已有结果的复用。批次共用一次预留，各文件分别记录用量；失败文件不计入应扣部分。

上传完成时另记原件存储、上传字节和 multipart 请求分摊；报价探测记录占用时间和读取成本。确认前开销先记平台成本；首次实际处理时按已确认报价归属到对应任务，后续复用不重复归属。账单中的 attributed 行引用原成本事件，只用于该任务计价；经营报表只扣原始费用，避免重复扣除。未开始任务的上传与探测成本仍由平台承担。worker 通过当前任务上下文记录子进程墙钟毫秒、对象读写、传输、24 小时输出保留分摊及模型用量。墙钟毫秒不是 CPU 核秒；远端 AI 等待时间不会作为 FFmpeg 运行时间收费。原生下载的实际外部下载字节数需要生产存储访问日志与账单对账，签发下载 URL 不代表已传输字节；该部分不得被表述为已经准确计量。

AI 请求前预留本次最高用量，明确 429/鉴权/请求拒绝释放对应预留，收到响应先记录用量再验证结果内容。无法确认是否被服务商接收、进程中断、缺少 usage 的记录进入待核账；不能把它们当零成本。重试不自动切换服务商。

计费操作状态：open → settled/refunded/needs_quote；有不确定用量时进入 reconciling，保留冻结。授权阶段之外或预算不足，在下一项收费工作之前抛出暂停错误；界面通过现有重试入口确认新报价，原有阶段结果复用。处理时间超出预算时，重试报价会参考上次实测时间提高可确认的上限；FFmpeg 编码本身不具备断点续编能力，该步骤需要重新运行。已确认最高积分是用户扣款硬上限；供应商异常超计量产生告警，平台承担上限之外的损耗。

- 成功：按已计量成本和原价格快照汇总结算，只在操作合计取整，退回余量。
- 用户取消：结算已执行部分，退回未执行部分。
- 失败且无可交付结果：释放/退款；已发生供应商费用留在成本记录。
- 多文件部分成功：成功与取消/已完成阶段按用量计费，失败部分为平台损耗。
- 系统终止/不确定：先核账，不自动重新付费提交。通过管理员对账命令完成原用量，再幂等释放或结算。
- 删除和过期保留财务流水；游客任务登录接续只迁移归属，不赠送积分。

纯色背景翻译修复已前移到云调用之前；保留原有局部合成和缓存。复杂背景仍使用原配置模型，不因成本自动换模型。

## 核价与运维

```sh
pnpm setup:local
pnpm billing:admin price-template
pnpm billing:admin publish-prices /absolute/path/verified-prices.json
pnpm billing:admin configure /absolute/path/billing-config.json
pnpm billing:report 2026-09
```

价格文件必须使用新 version，并逐条保存证据；未知价格保留 null/verified=false。运行模式配置包含 mode、productionVerified、paymentVerified、paymentFeeRate、paymentFixedCny、evidence。enforced 需要生产资源实测及支付证据、所有基础设施价格可用，并验证所有套餐的真实支付费用不超过 10%。未知 AI 线路依然被报价/请求前检查阻止。configure 始终保持 salesEnabled=false；支付提供商尚未选定，不能仅修改标志宣称已接通充值。

服务端人工入账与对账，仅通过受控本地 CLI，无网页管理入口：

```sh
pnpm billing:admin grant user:USER_ID 2900 UNIQUE_RECEIPT_ID "已核对的收款或测试说明"
pnpm billing:admin reconcile USAGE_EVENT_UUID ACTUAL_QUANTITY "服务商账单及核对依据"
pnpm billing:admin balance PROVIDER CNY_BALANCE "余额证据来源"
```

grant 是幂等的账本管理操作，不是支付验收或自动收款。不要把测试积分发入真实账户。reconcile 使用原操作价格版本，不允许客户端指定收费额；已经结算的事件不重复处理。余额记录是带时间的人工观察，未配置连接时报告显示“余额不可用”，不伪造实时余额。

日报包含每天的报价偏差和按工具、计量单位汇总的实测用量。worker 每分钟刷新当天累计报告，跨天自然生成新日期记录（Asia/Shanghai），并记录超预算和待核账告警。报告文件写入忽略目录 `.data/billing/`。尚无外部通知渠道，不发送消息或创建额外自动化。

## 验证和正式启用门槛

```sh
pnpm test
pnpm test:billing
pnpm exec playwright test tests/e2e/billing.spec.ts tests/e2e/filemorph.spec.ts tests/e2e/compression-tools.spec.ts
pnpm typecheck
pnpm build
```

`test:billing` 创建并删除独立本地 PostgreSQL 数据库，验证真实事务、并发、幂等、价格快照、预算和退款，不调用云 AI、不修改当前业务库余额、不终止普通 worker。现有故障恢复测试仍遵循 README：先停止普通 worker，测试只终止自己创建的进程组。处理逻辑变更后重启 worker。

正式收费之前还需：确认 300 元配置的真实硬件和容量，用矩阵样本采集生产数据；验证文本网关现金单价、修复网关现金兑换、OSS/R2/流量实际账单；接通并验收真实支付费率和签名通知；用全部积分被消费的场景验证价格；生产资源隔离和账户/IP 限流遵循现有上线门槛。当前实现不代表这些外部条件已满足。
