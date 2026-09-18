# 翻译工具：本地版本

## 用户流程

首页三个翻译入口 → 单文件上传 → 选择源／目标语言 → 后台处理 → 阅读 → 按需校正或 AI 分析 → 顶部下载。结果工作区占满窗口，提供版式／文字与原文／译文／双语切换。PDF、图片使用 worker 渲染产物，DOCX 原文和译文直接内嵌阅读。文字视图保持完整内容，搜索、页码和待检查导航用于定位。

校正面板只在需要时打开。新 PDF 使用 Docling 结构解析和 ReportLab 流式重排，可修改译文、字号、字体、粗斜体和对齐，保存后重新分页；不提供绝对坐标拖动。图片和未优化的旧 PDF 保留区域编辑。新 PDF 正文至少 10pt，空间不足增加续页，不恢复中文掩盖溢出。双语阅读等宽，按内容 ID 和块内比例双向同步；原文页数与译文页数独立。底部控件在悬停或键盘聚焦时显示。仅译文模式保持左侧文件、右侧独立 AI 面板；手机使用文件／AI 切换。历史 PDF 提供“优化排版”，复用已保存内容，不重发翻译。

视频保留所选音轨的声音；翻译和字幕烧录不会生成配音。字幕参数按 1080p 的字号单位设置，再按视频尺寸缩放。浏览器字幕是即时参考，15 秒烧录预览用于确认最终字体、换行和位置。

## 处理与存储

- `packages/core/src/translation.ts`：语言、参数、内容块与导出契约。
- `packages/core/src/translations.ts`：归属检查、版本保存、局部重试和快照导出。
- `migrations/0006_translations.sql`：内容、持久化步骤、导出快照及 worker 能力心跳。
- `migrations/0007_translation_access.sql`：翻译表和复用的语音表开启行级访问保护，浏览器不直接访问数据库。
- `apps/worker/src/translation-worker.ts`：独立翻译队列、数据库租约、分步恢复、取消和导出。
- `apps/worker/src/translation-provider.ts`：百炼原生接口、OCR 坐标转换、限流处理与不确定请求状态。
- `apps/worker/python/translate_file.py`：文件结构解析、版式、旋转区域合成和导出。
- `apps/web/src/components/translation-entry.tsx`、`translation-editor.tsx`：上传、对照编辑与下载。
- `migrations/0008_translation_reading.sql`：模型速率桶、等待时间、阅读快照、生成任务和聊天记录。
- `packages/core/src/reading.ts`、`reading-jobs.ts`：阅读契约、引用及树校验、文字指纹缓存、归属和版本检查。
- `apps/worker/src/ai-rate-limit.ts`：数据库共享 RPM／TPM 调度，遵守服务端限流等待。
- `apps/worker/src/reading-worker.ts`：摘要、导图、问答、按页预览、持久化恢复和导出；独立队列也处理翻译导出，避免长文档占满处理槽后阻塞下载。
- `apps/worker/python/translation_layout.py`：按栏、段落和表格组织 PDF 文字，在相邻内容边界内扩展区域；旧任务仅在阅读和渲染时合并，保留 ID、已完成步骤和人工调整。

文件字节和模型请求在 worker 处理。Web 只返回状态、编辑数据和带归属校验的签名下载地址。三个工具复用现有匿名会话、上传、取消、删除、过期清理和事务发件箱。修复图、原文预览和导出都在 `translations/{job}/` 下，24 小时到期或主动删除后清理。取消清除运行临时文件，已完成的收费步骤保留供用户重试，直到任务删除或到期。

## AI 阅读

- 摘要支持简明／详细和 AI 笔记／重点提要／章节摘要。标题、段落、列表和表格使用经过校验的结构化数据，列表项和表格行有独立出处；复制与 Markdown 下载使用相同结构。旧版文字摘要仍可阅读。
- 导图占满右栏，首次自动适配并居中；支持拖动、缩放、展开／收起和 PNG／SVG／Markdown 下载，导出不受当前画布位置影响。
- 问答保留上下文，支持建议问题、停止、重试和复制；输入框固定底部。重新生成最后一个问题只增加回答版本，不重复插入问题。
- 默认输出语言跟随界面，可独立于文件翻译语言调整。首次打开摘要或导图时生成；摘要缓存区分文字指纹、语言、详细程度、模板和结果结构版本。样式变更不会触发重新调用，文字变更会提示更新。
- 右栏顶部提供语言、复制、下载和重新生成。生成中及失败时保留上次成功内容；显式重新生成创建独立快照，旧文件继续可下载。
- 每条事实引用稳定内容 ID 和原文／译文中的实际引文，服务端验证 ID、引文、树结构与数量。出处定位到文档页或段落、视频字幕时间、图片文字区域。
- 仅使用已提取并保存的文字，不推断未识别图形或视频画面。问题没有依据时明确说明；文件内容和模型输出不执行为指令、脚本或工具请求。
- 长文件按输入预算分块，完成分块结果持久化后再汇总。明确的 429 等待后继续，已完成部分不重发；请求结果不确定时必须显式重试。AI 失败与翻译下载状态独立。

## 文件效果边界

- 新 PDF 的 Docling Heron／TableFormer Accurate 在本地识别阅读顺序、标题、段落、列表、图形、公式和表格；复用持久化 OCR 框，与原生文字去重。ReportLab 单栏排版，原文每页可产生多个续页；表格允许跨页、行高增长和重复表头。
- 图形、公式及识别出的保护片段保留原图或原字符，图内识别到的自然语言单独呈现译文。识别不可靠的区域有待校正标记，不宣称完全自动转换成功。扫描清晰度和结构识别仍影响结果。
- 新 PDF 预览和下载使用相同版本的排版器、字体和内容快照，回归验证 PDF 字节一致。双语下载按“原页、该页全部译文续页”组织。旧产物及下载快照不覆盖，未完成的翻译仍受原有下载和重试保护。
- 图片翻译和未优化旧 PDF 保留原处理链路：OCR、区域修复、固定位置绘制和溢出待校正。优化旧 PDF 后停用文字框移动及背景修复，不对新 PDF 调用图像修复模型。
- DOCX 与 EPUB 使用稳定行内标识，对应替换文字槽位；样式、链接、图片、公式及包内资源保留。OpenAI 兼容接口按整段联合生成严格 JSON 字段，校验字段完整性后才缓存完成，文字槽位与保护片段由本地映射；无效响应保存为失败，显式重试重新请求。旧译文或整段人工修改无法反推出语义强调位置，会保留结构并放入首个可写文字槽，需要核对强调范围。
- EPUB 嵌套列表的父级文字与子级段落分别处理，保留章节和目录。旧任务保留原定位方式。TXT 保留段落分隔、UTF-8／UTF-8 BOM／UTF-16 编码。
- SVG 拒绝外部引用、脚本和动态元素后栅格化；导出位图。只接受单帧图片。
- 阿拉伯文使用 Raqm／HarfBuzz 和 Noto 字体。新 PDF 使用 HarfBuzz 成形及 ReportLab 的 RTL 流式段落；旧固定布局保留 ActualText 逻辑文字层。PDF 阅读器的文本提取顺序可能有差异。
- 字体随项目提供，许可证位于 worker assets 和 web public/fonts 下。DOCX 在不同阅读器和字体环境中可能重新排版。

## 配置与依赖

使用 `.env.example` 中的 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`TRANSLATION_MODEL`、`TRANSLATION_OCR_MODEL`、`TRANSLATION_IMAGE_MODEL`。默认分别为 `qwen-mt-plus`、`qwen3.5-ocr`、`qwen-image-2.0-pro-2026-06-22`；模型权限与地域必须匹配。

AI 阅读使用 `AI_READING_MODEL=qwen3.7-plus`。`.env.example` 提供各模型的 RPM／TPM 限制；默认值留有余量，可按账号额度调整。等待状态保存到数据库，页面显示恢复时间。纯数字及标点区域保留原样，不发送无意义的翻译请求。

macOS 安装 `ffmpeg-full`、`libraqm`、`cairo`，设置 FFmpeg 路径，安装 LibreOffice 或设置 `SOFFICE_PATH`。Linux 安装带 libass 的 FFmpeg、LibreOffice、Raqm、HarfBuzz、FriBidi、Cairo 及开发头文件。然后运行 `pnpm setup:python`、`pnpm setup:documents` 和 `pnpm exec tsx --env-file=.env scripts/check-dependencies.ts`。worker 更改后重启。

官方参考：[Qwen-MT](https://help.aliyun.com/zh/model-studio/machine-translation)、[OCR](https://help.aliyun.com/zh/model-studio/qwen-vl-ocr)、[图像编辑](https://help.aliyun.com/en/model-studio/qwen-image-edit-api)、[Fun-ASR 语言能力](https://help.aliyun.com/zh/model-studio/fun-asr)。

## 验证与复验

```sh
pnpm fixtures:translation
pnpm test
pnpm test:python
pnpm typecheck
pnpm build
```

停止普通 worker，再运行 `pnpm test:translation`、`pnpm test:transcription` 和 `pnpm test:reading`。测试只结束自己创建的进程组；模型响应由测试注入，FFmpeg、文件处理、LibreOffice、数据库、对象存储和下载为真实执行。阅读测试覆盖引用拒绝、版本缓存、聊天幂等、取消、分块恢复、结果不确定、限流等待和过期拒绝。完成后恢复普通 worker。

```sh
pnpm --filter @filemorph/worker dev
# 另一个终端；只使用合成样本，会产生模型调用费用
pnpm test:translation:live
pnpm test:translation:e2e:live
pnpm test:reading:live
pnpm exec tsx --env-file=.env scripts/check-reading-injection-live.ts
pnpm exec tsx --env-file=.env scripts/check-translation-cleanup.ts
pnpm exec playwright test tests/e2e/translation.spec.ts tests/e2e/reading.spec.ts tests/e2e/reading-layout.spec.ts --workers=1
# 等上面的编辑测试完成后再执行，避免同时修改同一合成文件的版本
pnpm exec tsx --env-file=.env scripts/check-reading-layout-live.ts
```

真实全流程脚本在 macOS 使用系统语音合成测试视频，另处理合成菜单和 DOCX。它将报告、成品及浏览器状态保存在被忽略的 `.data/translation-live` 中；不提交会话状态或生成文件。浏览器中的真实结果测试在尚未运行该脚本时跳过；入口检查始终运行。

2026-09-15 已验证：三种真实百炼能力；三个工具真实处理和下载；TXT／DOCX／EPUB／扫描及原生 PDF 输出；原文／译文／双语字幕与 MP4；多音轨、两小时转写分段恢复；阿拉伯双语烧录、PDF 搜索和旋转区域边界；保存冲突、局部重试、取消、进程退出后的不确定请求保护；桌面和手机的校正、预览及下载。最终 29 项浏览器、35 项单元、31 项 Python 测试通过，typecheck 和 build 通过；原工具另外通过 105 次真实格式转换及 15 项上传／任务集成检查。

这些样本验证实现链路，不能替代各种真实海报、复杂论文、表格和电子书的人工效果检查。

### 2026-09-16 体验升级复验

- 原有 40 页、1,521 个区域的数学 PDF 已从限流中恢复并完成翻译，保留原内容 ID 和完成步骤；修正公式周围区域后成功导出 40 页 PDF。下载目录的 12 页物理 PDF 也已完成处理、校正和导出，译文文字可搜索复制。
- 下载目录中的 2880×2000 网页截图完成原生 OCR、翻译、背景修复和人工措辞校正。实际 PNG 的文字区域外像素及透明度逐像素保持一致。原英文叠字问题经纯色区域清除复验解决。
- 合成 DOCX、字幕视频、菜单图片完成摘要、导图、问答及无依据跨语言问题的真实百炼调用；合成 EPUB 完成翻译、双语打包、章节／目录验证及带出处摘要。40 页 PDF 的最终校正版摘要完成分块及汇总的 5 个步骤，校正后网页截图的摘要也已更新；更早文字版本的历史分析会提示更新。
- 加强服务端出处验证：只接受引用块内的实际连续引文；仅当省略号两侧字串在同一个短内容块中按顺序出现时，才用该块完整原句恢复引文。摘要与导图使用各自的结构约束，错误引用或无效树不会发布。
- 45 项单元、38 项 Python、全站 33 项桌面／手机浏览器测试通过；翻译和 AI 阅读集成／故障恢复通过，故障测试期间停止普通 worker，测试后恢复。typecheck 与生产 build 通过。最终阅读模型再次通过真实提示注入与跨语言出处测试。

### 双栏与重新生成接口

`POST /api/jobs/:id/reading` 的摘要参数增加 `template: notes | takeaways | chapters`（默认 notes）。显式重新生成传 `regenerate: true` 和 UUID `requestId`；问答还传 `regenerateOf` 指向最后一个问题的回答，问题文字和同一轮标识由服务端确定。重发同一请求 ID 返回同一任务，即使文件已产生新保存版本。普通打开继续复用已有结果；失败的新生成不取代成功缓存。

结构化摘要使用 `version: 2` 与段落／列表／表格内容块，服务端校验每条出处及表格列数。存储沿用现有活动表的 JSON 字段，无需新增数据库迁移；旧活动和下载文件保留。生成和导出仍在 worker，web 仅处理短请求。

2026-09-16 双栏升级复验：三种工具真实生成结构化摘要，文档三种模板均完成引用校验和 Markdown 下载；实际重新生成返回新任务，原文件仍可下载；问答重新生成保持同一问题。桌面 1440／1920／1024px 和手机 768／390px 检查等宽布局、独立视图、导图操作、失败保留旧内容及校正返回。复验产物位于忽略的 `.data/translation-live/reading/`。

新文档数据、模型版本、验收范围见 [文档排版升级](document-layout.md)。
