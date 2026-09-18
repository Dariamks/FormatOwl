# FormatOwl SEO

## 当前交付

当前支持 25 种语言：11 个传统工具公开入口、4 个格式转换入口、2 个工具分类入口、3 篇教程以及首页和使用说明，共 22 × 25 = 550 个可索引 URL（仅在正式启用索引时进入 sitemap）。优先完善四类压缩、三类转换和视频转 MP3。AI 与去水印入口返回 noindex，等待生产依赖验收后再开放。

`apps/web/src/content/public-pages.ts` 汇总公开清单，工具事实、格式专页和教程分别保存在同目录的类型化数据文件中。只有清单中的页面进入 sitemap；导航、面包屑与相关内容链接直接指向各自语言的规范路径。新增格式页复用已有工具 ID、服务端校验和任务流程，不新增处理器。

所有公开页面具备独立 title、description、绝对 canonical、25 个语言标签（含 zh-Hans / zh-Hant）及 x-default、Open Graph 和 Twitter 分享卡片。x-default 指向对应英文页，每个语言版本各自 canonical。`/` 固定 308 跳转 `/en`，浏览器语言和语言 Cookie 不改变该默认入口。手动切换语言保留路径。

工作台、任务、批次、登录及密码重置页面继续 noindex，robots.txt 不拦截这些 HTML，以便爬虫读取 noindex。API 和认证接口仍限制抓取；任何 SEO 设置都不替代文件归属校验。

## 正式上线开关

默认 `SEO_INDEXABLE=false`。此时页面和代理响应禁止索引，sitemap 返回空 URL 集合，不以 robots.txt 的全站抓取禁令代替 noindex。

正式上线必须同时满足：

1. 确定品牌和自己控制的 HTTPS 域名；filemorph.io 是无关的同名网站，不是本站配置。
2. 公开工具完成部署环境端到端验收，确认额度、存储、清理与文案一致。
3. 将 APP_URL、认证地址及回调配置为正式地址，然后设置 `SEO_INDEXABLE=true` 并重启 web。
4. 验证正式 sitemap、canonical 和分享图片均使用同一域名，私有页面仍 noindex。

启用索引时配置拒绝 HTTP、IP、localhost、local/test/invalid/internal 域名以及含路径、用户信息、查询或片段的 APP_URL。该校验是防误配置，不能证明域名归属或服务已经上线。预览环境一直保持 false。URL 来源仅使用服务端 APP_URL，不使用请求 Host 构造 canonical。

sitemap 与 robots 是请求时路由；页面元信息也读取当前配置。修改开关仍应重启进程。只有教程有人工确认的内容更新时间，不给普通工具页编造 lastmod，也不在构建时刷新日期。

## 内容与样例复现

新增页面：`heic-to-jpg`、`webp-to-jpg`、`mov-to-mp4`、`m4a-to-mp3`，位于 `/{locale}/tools/`。专页限制对应输入扩展名、固定输出格式，仍可调整质量等参数；通用转换器保留完整的输入输出选择。

教程位于 `/{locale}/guide/`：`compress-video-to-target-size`、`webp-to-jpg-transparency`、`why-pdf-wont-compress`。每篇包含实测样例、操作方法、局限及对应工具链接。文字遵循真实能力，避免承诺无损、固定压缩比例、全格式或不上传文件。

运行：

```bash
pnpm fixtures:seo
```

脚本只生成合成内容并调用现有本地处理器，不发送第三方 AI 请求。结果在 `.data/seo-examples/report.json`，输入和输出均不提交。2026-09-16 实测：视频 1,871,082 → 313,365 字节，透明 WebP 58 → JPG 1,543 字节且角落为白色，文字 PDF 1,578 → 1,147 字节，合成扫描 PDF 1,590,807 → 531,720 字节。编码器与依赖版本改变后结果可能不同，更新教程时人工复核数字和日期。

使用现有 Next.js、next-intl、组件与样式，无 CMS、SEO 库或分析脚本。FAQ 是可见帮助内容，不添加 FAQ 富结果标记；不添加 llms.txt。

## 本地验收

启动 web、worker 与 Docker，按照 README 准备基本素材。新增测试需要 `.data/fixtures/photo.heic`、`animated.webp`、`.data/conversion-checks/fixtures/` 和教程样例：

```bash
pnpm fixtures:seo
pnpm test:converters
pnpm typecheck
pnpm build
pnpm exec vitest run tests/unit/seo-config.test.ts
pnpm exec playwright test tests/e2e/seo.spec.ts tests/e2e/seo-conversions.spec.ts
```

另外运行现有压缩、转换、剪辑浏览器回归。SEO 请求测试覆盖全部 550 个公开页面、私有页、未开放索引工具、404、查询参数、多语言、分享 PNG 和禁用 JavaScript 时的正文。

生产构建的默认安全配置可在独立端口启动：

```bash
SEO_INDEXABLE=false pnpm --filter @filemorph/web exec next start --hostname 127.0.0.1 --port 3100
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test tests/e2e/seo.spec.ts
```

启用模式在本地独立端口模拟，以下域名仅用于元信息断言，访问始终在 loopback；不提交给搜索引擎：

```bash
APP_URL=https://seo.example.com SEO_INDEXABLE=true pnpm --filter @filemorph/web exec next start --hostname 127.0.0.1 --port 3101
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3101 SEO_TEST_ORIGIN=https://seo.example.com SEO_TEST_INDEXABLE=true pnpm exec playwright test tests/e2e/seo.spec.ts
```

这些生产抓取测试不提交转换任务，原有 web 和 worker 不需要停止。故障恢复测试另按 README 要求停止普通 worker，本轮 SEO 不需要运行该类测试。

## 2026-09-16 本地验收记录

- `pnpm typecheck`、`pnpm build` 通过；SEO 配置单元测试 2 项通过。
- 同一生产构建分别以关闭、开启索引配置启动，SEO HTTP/HTML 检查各 6 项通过，覆盖 40 个公开 URL、私有页面、无效 slug、语言切换、无 JavaScript 正文和分享图片。
- 四个格式入口均完成真实上传、预设参数校验、转换与下载。动画 WebP 在未确认首帧时返回 `ANIMATION_REQUIRES_CHOICE`，确认后成功；不匹配的输入扩展名在入口被拒绝。
- 现有压缩、转换、编辑、视频压缩与断点续传浏览器回归共 20 项通过；登录弹窗移动端回归 1 项通过。没有调用第三方 AI 验收或远程 CI。
- `pnpm test:converters` 的报告确认 105 次真实格式转换和 5 项拒绝检查通过；教程样例也已通过本地处理器生成并核对。

复现浏览器回归：

```bash
pnpm exec playwright test tests/e2e/compression-tools.spec.ts tests/e2e/media-editors.spec.ts tests/e2e/video-editing-controls.spec.ts tests/e2e/conversion-transcription.spec.ts --grep-invert 'transcript edits'
pnpm exec playwright test tests/e2e/filemorph.spec.ts
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test tests/e2e/auth.spec.ts --grep 'mobile dialog'
```

本轮最终生产构建在 390 × 844 视口下的单次本地测量：

| 页面                                      |     TTFB |    LCP | CLS |
| ----------------------------------------- | -------: | -----: | --: |
| `/en`                                     | 203.2 ms | 280 ms |   0 |
| `/en/tools/webp-to-jpg`                   |  10.6 ms | 192 ms |   0 |
| `/en/guide/compress-video-to-target-size` |    15 ms |  80 ms |   0 |

测量使用 `agent-browser vitals`、loopback 服务和同一浏览器会话，没有网络或 CPU 限速，可能使用缓存；这些数字不代表真实移动设备或海外网络。未取得有效的 INP 样本，也没有现场第 75 百分位数据，不能宣称通过线上 Core Web Vitals。原始结果保存在忽略的 `.data/seo-vitals-*.json`。

根据首屏资源检查，将登录弹窗改为点击后加载。教程首屏脚本的压缩资源体积合计从 213,927 字节降到 204,971 字节，减少约 4.2%；这是两次本地构建样本，不是承诺的页面提速比例。手机端价格入口移入折叠菜单以避免英文导航溢出，教程表格在窄屏可直接阅读三列；中文字号规则兼容 `zh-Hans`。

本轮只完成本地交付。正式域名、部署环境功能验收、Search Console 验证与收录仍留待上线阶段，`SEO_INDEXABLE` 默认保持关闭。

## 上线后 Search Console

在 Google Search Console 添加 Domain property，使用域名 DNS TXT 验证所有权；通过后提交正式 `/sitemap.xml`。抽查首页、传统工具、格式专页及教程，确认 Google 可抓取 HTML、选定 canonical 正确、25 种语言的双向关联有效，并检查私有 URL 的 noindex。域名与 DNS 尚未提供，因此本地交付不代表已验证、已收录或已部署。

第 1 周看抓取和 sitemap；第 2 周看收录与 canonical；第 4、8 周按页面、查询、国家和设备比较非品牌展示、点击、CTR。展示多而点击少时检查标题与意图；重复页面争夺同一意图时检查定位和内链；使用真实查询决定下一批页面，不按固定数量批量生成。

首期不接 GA4，不把搜索点击等同于任务完成或下载。无付费关键词工具数据，不声称这些关键词低竞争。社区案例和演示素材须基于真实功能，对外发布另行授权；不购买或批量制造外链。

性能先记录生产构建的移动端实验室结果；上线后有足够现场数据再以第 75 百分位 LCP ≤ 2.5 秒、INP ≤ 200 毫秒、CLS ≤ 0.1 评估。开发模式测试或单次浏览器测量不代表通过现场 Core Web Vitals。

参考：[canonical](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)、[noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)、[内容政策](https://developers.google.com/search/docs/essentials/spam-policies)、[Search Console](https://support.google.com/webmasters/answer/7576553?hl=en)、[Web Vitals](https://web.dev/articles/vitals)、[Google 文档更新](https://developers.google.com/search/updates)。用户提供的 X 帖子因访问失败未作为已核实依据。

## 2026-09-18：格式与压缩搜索入口

首页标题改为 `File Format Converter & Compressor Online | FormatOwl`，其余 24 种语言使用对应本地表达。修复通用工具页丢弃 `ToolContent.title`、误用菜单短名称的行为，例如视频转换页现在输出 `Online Video Converter — MP4, MOV, MKV & WebM | FormatOwl`。短菜单和操作标题继续便于浏览；搜索标题补充具体用途与格式。

新增 `/{locale}/convert` 与 `/{locale}/compress`，展示已上线工具的输入、输出、大小限制和参数取舍。转换页包含四个格式专页入口；分类页链接相关教程及价格页，首页链接两类目录，工具及格式专页的可见面包屑和 BreadcrumbList 也返回对应分类。分类内容由现有工具事实和服务端词典生成，不扩大上传格式或更改处理流程。

| 搜索意图                                                      | 主要承接地址（英文示例）   | 页面作用                           |
| ------------------------------------------------------------- | -------------------------- | ---------------------------------- |
| file format converter / file compressor                       | `/en`                      | 品牌总览和两类入口                 |
| format converter / convert files online                       | `/en/convert`              | 按媒体类型比较真实支持的输入和输出 |
| compress files online / file compression                      | `/en/compress`             | 按文件类型比较限制和质量设置       |
| video converter / image converter / audio converter           | `/en/tools/*-converter`    | 可直接上传使用的通用转换器         |
| compress video / compress PDF / image compressor              | `/en/tools/*-compressor`   | 可直接设置参数和处理文件的压缩器   |
| HEIC to JPG / WebP to JPG / MOV to MP4 / M4A to MP3           | `/en/tools/<from>-to-<to>` | 已有的四个固定格式转换入口         |
| target video size / transparent WebP / PDF compression limits | `/en/guide/<slug>`         | 有实测依据的教程与工具链接         |

这些是与功能匹配的目标意图，不是已经取得的排名、搜索量或低竞争词结论。没有新增格式组合的批量页面。品牌里的 Format 有助于表达定位；具体页面内容和工具能否满足需求仍是重点。

### 调研采用与取舍

- [Google 标题指南](https://developers.google.com/search/docs/appearance/title-link)：标题应清晰、具体并与内容一致，因此使用已有工具的描述性标题，避免所有页面只用短菜单名。
- [Google 多语言指南](https://developers.google.com/search/docs/specialty/international/localized-versions)：保留每种语言独立 canonical 和完整互指 hreflang。HTML 与 XML 两种语言标注没有叠加收益，所以继续由 HTML 输出语言关联，sitemap 只列规范 URL，避免重复维护。
- [next-seo](https://github.com/garmeeh/next-seo)：其当前 README 也建议 App Router 的标准 metadata 使用 Next.js 内建能力。本项目已有 Metadata API 和 BreadcrumbList，不增加 SEO 依赖或虚构评分、作者、免费价格等结构化信息。
- [next-sitemap](https://github.com/iamvishnusankar/next-sitemap)：参考其动态 sitemap、URL 排除与语言替代配置思路；本项目规模适合继续复用 `publicPages()` 和 Next.js 原生路由，不引入第二套 URL 清单生成器。
- [Google 内容政策](https://developers.google.com/search/docs/essentials/spam-policies)：分类页提供实际选择信息，并直接链接可用工具，不为了关键词排列组合生成低价值入口。

25 种语言新增文案已通过键、ICU 和技术标识检查。自动化检查不能代替母语审校，尤其应继续复核原有机器辅助生成的长文；优先按 Search Console 有展示的语言安排审校和当地查询词优化，不把英文关键词硬塞进所有语言标题。

### 本地验证

`pnpm check:i18n`、`pnpm typecheck`、`pnpm build` 及 SEO / i18n 相关的 4 项单元检查通过。生产构建分别使用启用、关闭索引的本地服务，各通过 31 项 SEO 浏览器和 HTTP 回归：逐一检查全部 550 个页面的独立标题、单一 H1、自引用 canonical、26 条语言关系（25 语言 + x-default）、分享元信息，以及 sitemap、私有页和 404。浏览器另验证分类入口跳转、面包屑、无 JavaScript 内容和移动端语言切换。

使用 agent-browser 检查英文桌面与阿拉伯语手机页面，RTL 页面在 390px 视口没有横向溢出。这里是本地功能和抓取验证，不是线上收录或排名证明；未 push、部署或提交搜索引擎。索引环境开关保持现有设置，上线仍按前文的域名验证与 Search Console 流程操作。
