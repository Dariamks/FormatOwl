# FormatOwl

**压缩、剪辑、转换、翻译，一站完成。**

Next.js + TypeScript 文件处理平台。当前可在本地使用四类压缩工具，以及视频剪切、画面裁剪、音频剪辑、视频转 MP3，以及视频、音频和图片格式转换、音视频转文字、三类翻译及四类去水印，共 19 个工具。包含中英双语页面、分片直传、独立处理进程、工作台、预览和下载。图片、PDF、音频压缩和三种格式转换支持批量与 ZIP 下载，三个翻译工具支持真实百炼调用、服务端校正保存和按版本导出。

账号认证已改用 Better Auth，包含邮箱密码注册、验证、登录、密码重置和游客任务接续；本地邮件保存在 `.data/auth-mail`。Google OAuth 和 Resend 真实邮件待凭据 / 域名配置后验收，详见 [注册登录与申请步骤](docs/authentication.md)。游客仍可在本地试算模式使用；积分报价、用量账本和结算控制已接入，默认不扣款，真实支付尚未接入。

## 本地启动

要求：Node.js 22+、pnpm 10.32.1、Python 3.12、Docker Compose、原生 FFmpeg / ffprobe（包含 libx264、libx265、libmp3lame、aac、libvpx-vp9、libopus、flac、libass subtitles 过滤器）、LibreOffice、Pillow Raqm 和 Cairo。

```bash
pnpm install
cp .env.example .env
pnpm setup:python
pnpm setup:documents
pnpm check:dependencies
pnpm infra:up
pnpm setup:local
# macOS / Linux；当前工作区已经建立此链接
ln -s ../../.env apps/web/.env.local
pnpm dev
```

Windows 可将 `.env` 复制到 `apps/web/.env.local` 并保持同步。打开 [中文首页](http://127.0.0.1:3000/zh) 或 [English](http://127.0.0.1:3000/en)。所有本地服务只绑定 loopback；MinIO 用于本地 S3 兼容性验证，云端目标仍为私有 Cloudflare R2。

`setup:python` 在 `.data/venv` 安装锁定依赖，不修改系统 Python。若 Python 3.12 不在 PATH：

```bash
PYTHON_BOOTSTRAP=/absolute/path/to/python3.12 pnpm setup:python
```

`setup:documents` 在独立的 `.data/docling-venv` 安装 PDF 结构解析依赖，并预下载锁定版本的 Heron／TableFormer 模型到 `.data/docling-models`；文档任务期间离线运行，不下载模型。文档重排说明见 [文档排版升级](docs/document-layout.md)。

worker 默认使用项目虚拟环境，也可通过 `PYTHON_PATH` 指定解释器。依赖检查包含真实 HEIC 编解码、PDF 写入、libass、LibreOffice、Raqm 和中日韩／阿拉伯字体检查。macOS 可安装 `brew install ffmpeg-full libraqm cairo`，将 `.env` 中的 `FFMPEG_PATH` / `FFPROBE_PATH` 指向 `ffmpeg-full`。如果 Pillow 的预编译包没有 Raqm，`setup:python` 会在已安装本地开发库的前提下重编译 Pillow。`SOFFICE_PATH` 可指定 LibreOffice。`setup:local` 按顺序执行带记录和事务锁的 SQL 迁移，升级保留历史视频任务。

`pnpm dev` 启动网页与 worker，Ctrl+C 停止。`pnpm infra:down` 停止本项目的 Docker 服务并保留数据卷。

## 管理员后台

本地入口：`http://127.0.0.1:3000/admin`，默认账号 `admin`，密码 `admin123`。后台使用独立会话，不显示在普通用户导航中。支持注册用户搜索与详情、手动充值（人民币金额 + 积分 + 唯一凭证）、封禁与恢复，以及全部 19 个工具的上下架。

升级先运行 `pnpm setup:local` 应用迁移。账号可由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 覆盖；`ADMIN_SESSION_SECRET` 留空时使用 `BETTER_AUTH_SECRET`。修改认证配置后重启 web，旧会话失效。

操作规则、记录口径和测试说明见 [管理后台](docs/admin-console.md)。

## 已实现

| 工具       | 输入与能力                                                                   | 输出                         |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------- |
| 视频压缩   | MP4、MOV、MKV、WebM；质量、目标大小两遍编码、H.264/H.265、分辨率、码率、速度 | MP4                          |
| 图片压缩   | JPG/JPEG、PNG、WebP、GIF、HEIC；三档预设、透明和动画保留、前后预览           | 保持原格式，包括 HEIC        |
| PDF 压缩   | 轻度结构优化、均衡与强力内嵌图片优化，保留文字和页面结构，PDF.js 翻页预览    | PDF                          |
| 音频压缩   | MP3、WAV、AAC、M4A、FLAC、OGG；质量预设、码率、采样率、声道、试听            | MP3 或 M4A（AAC）            |
| 视频剪切   | MP4/MOV/MKV/WebM；毫秒起止、多选区保留/移除、缩略图时间轴                    | MP4 / MKV / MOV（H.264/AAC） |
| 画面裁剪   | 自由与固定比例、拖动/缩放、像素输入、方向/SAR 校正、实时预览                 | MP4 / MKV / MOV（H.264/AAC） |
| 音频剪辑   | 音频及视频音轨、多素材与片段排序、淡入淡出、波形、完整成品试听               | MP3 / WAV / M4A / M4R        |
| 视频转 MP3 | MP4/MOV/MKV/WebM；选择音轨、时间段和 128/192/320 kbps                        | MP3                          |

- 视频格式转换支持 MP4/MOV/MKV/WebM，音频支持 MP3/WAV/AAC/M4A/FLAC/OGG（Opus），图片输出 JPG/PNG/WebP/AVIF。每批最多 20 个文件，共用参数；图片每个 50 MiB，音视频每个 1 GiB，单个转换输出最多 4 GiB。
- 转换结果重新解码验证后才发布；视频、音频浏览器预览与下载文件独立。动画转静态需要明确选择首帧，AVIF 不输出动画。JPG 可选透明背景填充色。
- 音视频转文字已接入百炼 `fun-asr`，包含独立队列、2 小时分段恢复、说话人/时间/文字编辑与五种导出。已完成中英双语、带噪声及两小时合成语音的真实调用与导出验收，可从首页进入。跨段说话人、边界文字及识别错误仍需人工核对。

- 编辑工具最多 20 个源文件、50 个片段，输入总计 1 GiB、输出最长 24 小时；M4R 最长 30 秒。视频剪切/裁剪每次使用一个源文件。
- 原件与预览分开存储，编辑导出始终读取原始文件。编辑源与预览按原件有效期清理，删除试听或导出不会提前清除可继续编辑的源。
- 编辑草稿仅在本浏览器保存源文件引用和参数；刷新或返回编辑可以恢复，未完成上传重新选择原文件续传。

- 图片、PDF、音频每批最多 20 个文件，同一批使用一组参数，每个文件独立处理、取消、重试和下载。
- 上传并发为 3，支持暂停、继续、失败重试；重新选择原文件可恢复已有分片。全部所选文件上传成功后创建持久化批次。
- ZIP 仅包含成功文件，重名自动编号；重试、删除或过期会让旧打包失效。
- 工作台包含进度、结果、失败原因、历史记录和批次入口。页面关闭不影响已提交的处理任务。
- PostgreSQL 保存任务事实，事务发件箱补偿入队，BullMQ 调用独立处理进程。
- 文件和下载按匿名会话或账户校验归属；写接口校验 Origin，处理参数采用白名单。
- 默认 24 小时有效期，可主动删除；清理包括原件、结果、预览、ZIP、未完成上传和临时处理文件。

当前本地额度：图片/PDF 每个 50 MiB，音视频每个 1 GiB；每会话最多 20 个待完成任务、24 小时最多 20 次上传。默认一个 worker 处理并发。积分报价按用量试算；未核实的完整价格显示待核价，默认 shadow 模式不扣款。

## 翻译工具

- 视频：选择原音轨，转写、翻译、字幕校正；导出原文／译文／双语 SRT、VTT、ASS、TXT、DOCX、PDF，以及 H.264/AAC MP4 和 15 秒烧录预览。
- 文档：PDF（含扫描与混合页）、DOCX、TXT、EPUB；原格式译文／双语导出，PDF 可搜索译文；DOCX 独立 LibreOffice 版式预览。
- 图片：JPG、PNG、WebP、SVG；OCR、局部背景修复、文字区域移动／缩放／旋转，导出 PNG、JPG、WebP、TXT。修复缓存与文字排版分开保存。
- 11 种翻译语言，单文件。视频 1 GiB／2 小时，文档和图片 50 MiB，文档 100 页（PDF／DOCX）或 10 万字符，24 小时有效期。
- 百炼密钥只在服务端读取，默认模型见 `.env.example`；地域和模型可在服务端调整。首页可用状态表示工具已实现，未配置密钥或 worker 时设置页会提示。
- 图片背景修复可独立使用 `gpt-image-2`：设置 `TRANSLATION_IMAGE_PROVIDER=openai`、`TRANSLATION_IMAGE_MODEL=gpt-image-2`，并配置 `AI_IMAGE_GATEWAY_BASE_URL` / `AI_IMAGE_GATEWAY_API_KEY`。本地已启用 `https://pdhlzy.art/v1`，接口适配与其他文本网关密钥分开；现有修复和导出继续复用。效果、计费口径及验收见 [图片网关实测](docs/image-repair-pdhlzy-evaluation.md)。
- 编辑自动保存并检查版本冲突；修改原文会标记译文待更新。溢出阻止发布并定位文字框。每个导出冻结保存版本。调用结果不确定时必须显式重试，已完成的识别、段落翻译和背景修复不会自动重复收费。
- PDF 结果页默认原文／译文等宽双栏连续阅读，双向同步滚动；分页与共同缩放控件在对应文档悬停或键盘聚焦时显示，触屏始终可用。“仅译文”自动切换为左侧译文、右侧 AI 阅读，两栏等宽；右侧可切换摘要、思维导图和问答。PDF 摘要支持详细／默认／全面三档，以及 AI 笔记、摘要、会议纪要、分析、评述五种模板。右下角进入校正，译文栏提供下载。其他翻译结果仍默认文件与 AI 左右各半。小于 1024px 使用文件／AI 全宽切换，小屏双语通过原文／译文标签阅读。PDF 和图片使用 worker 的实际渲染，DOCX 内嵌阅读预览。
- 三个工具均支持摘要、可折叠思维导图和连续问答；出处可定位页码、字幕时间或图片区域。AI 只依据保存的文字，默认使用 `qwen3.7-plus`，支持独立输出语言、停止、重试以及 Markdown／PNG／SVG 下载。
- AI 结果按文字内容复用，修改文字后提示更新，单纯改样式不重复调用。AI 失败不影响翻译下载。模型请求在数据库中统一控制 RPM／TPM，明确的限流按 `Retry-After` 等待恢复。

详见 [翻译实现与验收](docs/translation-tools.md)，包括版式保真范围和本地复验方法。

## 去水印工具

图片、PDF、Word（DOCX）和 PPT（PPTX）共用去水印工作区，支持候选确认、手动选区、撤销、版本化保存、预览对比与导出。PDF 保留原生文字和结构，Office 直接编辑原 ZIP/XML；复杂背景修复复用图片网关。

默认单文件 50 MiB、文档 100 页／张、24 小时有效期。独立对象删除和纯色填充可在本地使用。真实 OCR 验收被服务商欠费阻塞，复杂背景真实效果仍有待复验项；具体能力边界、测试命令和实测结果见 [去水印实现与验收](docs/watermark-removal.md)。

## 验证

先启动网页、worker 与 Docker 服务：

```bash
pnpm fixtures
pnpm fixtures:editors
pnpm test
pnpm test:processors
pnpm test:python
pnpm test:batches
pnpm test:integration
pnpm test:editors
pnpm test:converters
pnpm test:editor-api
pnpm test:e2e
pnpm typecheck
pnpm build
```

`test:processors` 为每种新格式运行三档真实处理；`test:python` 检查动画、透明、PDF 文字/书签/表单、HEIC 主图关系并生成 50 MiB PDF 样本。按上述顺序运行。浏览器测试使用本机 Google Chrome；测试样本由 FFmpeg、Pillow、pillow-heif 与 ReportLab 合成，不使用用户私人文件。

Windows 可把脚本中的 `.data/venv/bin/python` 替换为 `.data/venv/Scripts/python.exe`。

故障恢复测试需要先停止普通 worker，保持网页与 Docker 运行：

```bash
pnpm test:resilience
pnpm test:transcription
pnpm fixtures:translation
pnpm test:translation
pnpm test:document-layout
pnpm test:reading
# 测试结束后恢复正常 worker
pnpm --filter @filemorph/worker dev
```

测试只终止自身创建的进程组。覆盖视频、50 MiB PDF、多来源音频剪辑的处理中取消/重试与 SIGKILL 恢复，并检查编辑预览准备的发件箱补偿和中断恢复。报告和处理文件位于忽略的 `.data/`、`playwright-report/`、`test-results/`。

翻译与 AI 的真实调用验收在普通 worker 运行时执行：先运行 `pnpm test:translation:e2e:live` 生成三种工具的合成任务，再运行 `pnpm test:reading:live`，最后运行翻译和阅读浏览器测试。前两步会产生百炼调用费用。阅读测试包含无答案问题、跨语言回答、引用、缓存和下载；`scripts/check-reading-injection-live.ts` 另验证文件中的恶意指令不被执行。

## 实现边界

- 视频编辑首版支持 SDR，HDR 画面编辑明确拒绝；HDR 视频仍可提取音轨。多轨混音和多视频拼接暂未开放。视频格式转换同样拒绝 HDR。

- 普通图片最大 100 百万像素，动画最多 500 帧且总计 250 百万像素；HEIC 图像集合最多 100 张且总计 250 百万像素；PDF 最多 1000 页。
- APNG 暂不支持；不能完整重建的 HEIC 特殊辅助层保留原文件。HEIC 浏览器预览是 JPG，实际下载仍为 HEIC。
- 图片/PDF 无法进一步缩小时返回原件并明确说明；音频始终按所选格式输出，变大时显示提示。
- PDF 加密和数字签名文件明确拒绝。复杂色彩空间、蒙版等保持原样；不新增 OCR，不承诺 PDF/A 或特殊交互内容重新认证。
- 图片处理限时 5 分钟，Python 处理限时 10 分钟，音视频与 ZIP 最多 1 小时；统一取消、超时和临时文件清理。
- 1 GiB 为应用上限，不代表已完成 1/5/10 GB 压测。云端部署、真实 Google OAuth / Resend / R2、生产容器资源隔离及计费仍未完成；百炼真实转写已按本地样本验收。

目录、完整路线及运行边界见 [产品路线](docs/roadmap.md)、[运行说明](docs/operations.md) 、[压缩验收记录](docs/acceptance.md) 、[编辑验收记录](docs/acceptance-editors.md) 与 [转换及转写验收记录](docs/acceptance-conversion-transcription.md)。没有 push、PR、远程 CI、Tag、Release 或部署。

## 转写工作区

转写结果采用正文与 AI 笔记双栏布局，手机端通过标签切换。正文默认阅读模式，可按片段编辑文字、时间、说话人，以及拆分、合并。底部播放器支持时间跳转、上一／下一片段、倍速、静音和自动滚动；高亮精度为段级。

“全部复制”读取完整的已保存版本；导出入口保留 TXT、DOCX、PDF、SRT、VTT。AI 笔记复用摘要、思维导图和问答服务，点击生成后读取完整转写快照，出处支持定位回听。修改文字或说话人后，旧分析会提示更新。音视频转写尚未包含示例库、链接导入或网页录音。

新增 `pnpm test:transcript-reading`：在普通 worker 停止时运行，使用固定 AI 响应验证真实数据库、任务处理、Markdown 下载、权限、版本、分页后的引用与过期控制，不调用云端。测试完成后重启 worker。浏览器回归使用 `pnpm exec playwright test tests/e2e/conversion-transcription.spec.ts`。

## 转写服务配置

在本地 `.env` 配置，网页与 worker 共用；更改后重启这两个进程：

```dotenv
TRANSCRIPTION_PROVIDER=dashscope
DASHSCOPE_API_KEY=在本地填写北京地域的密钥
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/api/v1
TRANSCRIPTION_MODEL=fun-asr
```

当前接入阿里云百炼北京地域 `fun-asr` 的原生异步录音识别接口，启用说话人分离，使用服务返回的句级毫秒时间戳。无需配置 OpenAI 或 CC Switch。旧版北京地域地址仍获官方支持；凭据无效时页面显示明确错误，未配置时禁止提交。

本地验收通过百炼临时上传接口发送单声道音频。**本地任务有效期为 24 小时，百炼临时云端副本由服务商在 48 小时后自动清理。** 删除本地任务不等于提前删除该云端副本。该临时上传能力只用于本地测试；生产使用需要接入自有 OSS 并定义清理策略。[阿里云接口](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)、[临时上传说明](https://help.aliyun.com/zh/model-studio/get-temporary-file-url/)。

云端任务 ID 和服务配置随分段持久化。查询中断后，重试复用已有云端任务，已完成分段不会重新识别。提交结果不确定、没有拿到任务 ID 时不自动重发，用户重试可能产生再次调用费用。取消停止本地处理和查询，已被云端接收的识别可能继续完成；再次重试优先读取该结果。云端任务已失败或结果过期时，明确重试才重新提交。

可选 OpenAI 接口仍保留：设置 `TRANSCRIPTION_PROVIDER=openai`、`OPENAI_API_KEY`、`OPENAI_BASE_URL=https://api.openai.com/v1`、`TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize`。自定义中转地址必须真实支持音频转写、`diarized_json` 和说话人/时间戳；兼容聊天接口不代表兼容语音接口。密钥只填写在 `.env`，`.env.example` 必须留空。

`pnpm test:transcription` 使用固定识别响应验证真实媒体分段、数据库、导出、两小时恢复与 SIGKILL，**不调用云端、不验证识别质量**。运行时停止普通 worker，结束后恢复。

`pnpm test:transcription:live` 会使用真实 API 并可能产生费用。macOS 默认由本机语音生成中英双人样本；其他平台用 `TRANSCRIPTION_TEST_FILE=/absolute/path/to/sample.wav` 指定可发送的语音文件。命令验证上传、音轨准备、排队识别和合法时间戳，保留任务供试听核对，报告写入忽略的 `.data/transcription-live/`。识别质量仍需对照参考文本人工验收。超时和不确定结果不会自动重发。

三种格式转换与五种文本导出均不额外调用 AI。分段原始结果和用量仅保存在服务端；跨段说话人分别标识并提示核对，字幕提供段级时间和人工调整。导出锁定已保存的文档版本，后续编辑不会改变旧文件。

真实转写完成后，运行 `pnpm exec tsx --env-file=.env scripts/check-live-transcript-exports.ts`，复用报告中的任务验证保存修改及五种文件下载、读回；此命令不会重新调用语音模型。两小时样本可用 `TRANSCRIPTION_TEST_FILE` 指定，并以 `TRANSCRIPTION_TEST_OUTPUT=.data/transcription-live-long` 分开保存验收报告。仅保留的浏览器测试会话能访问对应匿名任务。

### 按功能接入模型网关

文本翻译可单独使用 OpenAI 兼容的 `/chat/completions`：设置 `AI_GATEWAY_BASE_URL`（含 `/v1`）、`AI_GATEWAY_API_KEY`、`TRANSLATION_TEXT_PROVIDER=openai` 和 `TRANSLATION_MODEL=qwen3.6-plus`。AI 阅读独立使用 `AI_READING_PROVIDER` 和 `AI_READING_MODEL`；OCR、语音转写、图片修复继续走原配置。修改 `.env` 后重启 web 和 worker。

网关凭据不会发送给旧任务的百炼地址；已保存步骤继续使用其原模型、协议和地址。限流按地址、凭据与模型隔离。超时等结果不确定的请求不会自动换模型重发。需要恢复原文本翻译时，设置 `TRANSLATION_TEXT_PROVIDER=dashscope`、`TRANSLATION_MODEL=qwen-mt-plus` 后重启；保留网关密钥以完成已经保存的网关任务。

`scripts/evaluate-model-gateway.ts` 是显式付费对照测试，使用 `EVAL_GATEWAY_BASE_URL`、`EVAL_GATEWAY_API_KEY`，支持 `reading`、`translation`、`languages` 三组样本；默认两轮、两个并发，原始响应写入忽略的 `.data/model-evaluation/`。`EVAL_MODELS` 可限定模型，`baseline` 固定为迁移前模型。脚本不会修改生产配置；自动检查只是第一层，仍需核对漏译、事实和实际渲染效果。

2026-09-16 实测后仅将本地文本翻译切换为网关 `qwen3.6-plus`，阅读、OCR、修复和转写保留原模型。逐项结果、测试范围和恢复方法见 [模型网关实测记录](docs/model-gateway-evaluation.md)。

## SEO

已添加 25 种语言的工具说明、格式转换与文件压缩分类页、四个格式转换入口和三篇含本地实测样例的教程，共 550 个公开 URL。默认 `SEO_INDEXABLE=false`，页面禁止索引、sitemap 为空；正式 HTTPS 域名及公开工具验收后再开启。配置、Search Console 上线步骤、内容复现和测试命令见 [SEO 说明](docs/seo.md)。

## 成本与积分

新增 [全功能成本样本矩阵](docs/pricing-cost-matrix.md) 和 [积分计费实现与运维](docs/billing.md)。价格与账单位于 `/zh/pricing`、`/en/pricing`。Pricing 展示免费 $0 与一次性 $9/$29/$59 USD 积分包；美元结算尚未接入，默认销售关闭。内部 CNY 成本与原积分核算口径保持不变，正式收费前须按美元方案重新核价。

`pnpm setup:local` 应用新计费迁移；`pnpm test:billing` 在独立本地数据库验证事务、并发、预算与退款；`pnpm billing:report` 导出经营成本报告。生产资源和两个网关现金成本尚需核验，不把站内额度或本机运行时间当作生产成本验收。

### 网站语言

支持 25 种界面语言，词典按语言与功能加载。新增语言、加载边界、切换保护和验收说明见 [国际化维护文档](docs/i18n.md)。使用 `pnpm check:i18n` 校验，生产构建自动更新词典导入表和版本。
