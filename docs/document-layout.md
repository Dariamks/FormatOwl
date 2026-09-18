# 文档排版升级

## 运行环境与许可

运行 `pnpm setup:python` 和 `pnpm setup:documents`，再执行 `pnpm check:dependencies`。普通 worker 重启后，新 PDF 自动走结构解析和重排。Docling 使用独立 Python 环境，避免与媒体处理库冲突；模型只在安装时下载，工作进程强制 Hugging Face 离线模式。可用 `DOCLING_PYTHON_PATH`、`DOCLING_ARTIFACTS_PATH` 覆盖本地路径。

锁定 `docling-slim 2.127.0`，完整传递依赖在 `apps/worker/python/docling-requirements.lock`。只启用 PDF、Heron、TableFormer Accurate，不启用远程服务、VLM、公式改写、图片描述或自带收费 OCR。

| 组件                                     | 固定版本或 revision                        | 许可资料                                      |
| ---------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Docling / core / parse / IBM models 代码 | 见 lockfile                                | MIT                                           |
| Heron                                    | `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` | 模型卡 Apache-2.0                             |
| Docling models / TableFormer Accurate    | `2199320848bb9a8a519d22e4b528185a4f9a6f64` | 模型数据 CDLA-Permissive-2.0；代码 Apache-2.0 |
| ReportLab                                | 5.0.1                                      | BSD                                           |
| MathJax                                  | 4.1.3                                      | Apache-2.0                                    |
| Noto 字体                                | 仓库内静态字体及 SHA-256 清单              | SIL OFL，assets 内保留许可证                  |

模型地址和下载范围在 `document-models.json`。模型卡与权重一起保存在模型缓存；发布打包时须保留对应组件和字体的许可证。没有引入 PDFMathTranslate-next 或 BabelDOC。这些组件信息不替代产品最终分发包的许可核验。

## 数据和排版契约

没有新增数据库表。`TranslationData.layoutVersion=3` 表示流式 PDF；`layoutEngine` 记录结构解析引擎，`inlineVersion=1` 标识新的结构化文本定位方式。块增加阅读顺序、结构组、字体属性、保护片段、译文片段、表格单元格信息和图形归属。原始框保留在 `originalBox`；重排坐标存储在预览结果的 `pages[].regions[]`，每个区域携带稳定 ID 和成员 ID。一段可以跨多个目标页。

PDF 逐原文页排版，正文至少 10pt，超长段落和表格分页。原生粗斜体从 PDF 字体信息恢复；Latin/Cyrillic 提供衬线／无衬线四个字重样式，CJK／阿拉伯使用语言字体回退和真实粗体。没有对应斜体字面的语言使用常规字面。图形和公式裁取原始页面；已识别的图内自然语言作为说明。识别不确定、无译文、未匹配结构会进入检查列表；无译文预览有明确提示。Word／EPUB 对保护内容保留原对象。

预览和导出调用同一排版器。服务器 `translationRenderVersion` 与内容指纹共同隔离缓存；修改译文或样式重新渲染，不重新调用翻译。历史导出不可变。PDF 预览是完整 PDF 加页／内容位置清单，浏览器按可视范围绘制。同步滚动查找内容块及块内比例，不使用整份文件的总滚动百分比。

图文顺序由 `pdf_flow.py` 组合：保留识别器的文字分栏顺序，依据原始坐标把图片插回同栏的前置段落后；同一段落下连通的子图保留为完整图组，正文或图注会阻止跨组拼接。题干与紧随的配图优先同页，过大内容仍可分页。组合图中的每个原始内容 ID 都有独立目标框，避免滚动到 C 图时跳回整组开头。重复的边缘文字、明确页码在正文之外排序，不直接删除。旧任务可以再次执行“优化排版”，重复执行不会新增重复图块。

自动段落样式以主要字体为准，不因单个斜体变量改变整段。原 PDF 几何位置、字号和变量出现次数能一致匹配时，分离的上下标关联回父段落；译文变量不匹配时保留片段并标记检查，不猜测绑定位置。此机制不会改写已保存原文或译文。

“优化排版”通过原阅读队列执行 `kind=preview, optimizeLayout=true`，在 worker 下载原文件和预览、结构解析、重排后，用原 revision 做 CAS 保存。取消、过期、删除或并发校正会阻止发布。旧块 ID、原文、已保存译文和人工样式保留，识别不可靠的匹配要求检查。此操作不请求 OCR／翻译／AI 阅读，不创建收费承诺；失败或取消后的重试同样只做本地排版。原任务 `AI_RESULT_UNKNOWN` 状态不会被改成翻译成功。

## 扫描试卷和结构化翻译

`extractionVersion=2` 在提取时检查 PDFium 的文字渲染模式，排除不可见 OCR 字符；扫描页使用已保存 OCR，经 Docling `OcrMode.FULL_PAGE` 替换 PDF 文字单元。混合页保留可见原生文字，并合入不重叠的 OCR。Docling 的一基页码统一转换为内部零基页码，防止识别结果串页。OCR 字号按正文行的几何统计恢复，不读取隐藏文字层的字体信息。

LaTeX 公式在本地保存为保护片段，文本槽位通过一次结构化请求联合翻译。当前 OpenAI 兼容接口使用严格 JSON schema，返回字段必须恰好等于请求字段，值必须为非空字符串；真实内容 ID、公式和样式归属由本地映射恢复。持久化步骤使用 `structured-v3` 键，结构校验通过才进入 completed；无效的历史 completed 响应也会改为 failed，普通显式重试可重新请求。不会把坏响应、原文或空串当作成功译文。原生 MT 接口保留独立槽位契约，没有跨供应商自动切换。

行内公式使用 [MathJax](https://github.com/mathjax/MathJax-src) 的 base/ams 包在本机生成图片，并保留基线和比例；禁用远程加载及自动扩展。独立公式、选项图继续裁取原图。`pdf_visual_regions.py` 对具有明确选项标签、至少两个同排图块且无正文穿插的图组选取整行原始可见内容，防止检测器只找出 A/B/C 而丢掉 D。无法满足条件的区域不会扩展。相关行为参考 [Docling OCR mode](https://github.com/docling-project/docling/blob/main/docs/reference/cli.md)，没有复制整个 PDF 翻译工程。

重排引擎版本为 `filemorph-reflow-4`，缓存版本为 9。旧任务需重新结构提取才能修正已经存储的错误原文；单纯换渲染器不会改写旧文档。人工修改过的文档不可直接覆盖。用户文件和恢复快照只放在忽略目录 `.data`。

## 复验

```sh
pnpm check:dependencies
pnpm test
pnpm test:python
pnpm typecheck
pnpm build
# 停止普通 worker 后运行；之后恢复 worker
pnpm test:translation
pnpm test:reading
pnpm test:document-layout
```

新增 Python 回归覆盖长段落续页、双语页序、重复表头、页面区域边界、字体名称、11 种语言、稳定 ID／人工修改、DOCX／EPUB 标识与对象、嵌套列表和 TXT 编码。Docling 回归实际调用本地模型，对原生双栏／合同文字、扫描页、混合页的持久化 OCR 进行去重检查。测试需先安装文档环境。

`tests/python/test_pdf_flow.py` 额外覆盖图片被识别器放在页尾、两行选项图、跨栏图文、短题干配宽图、图注隔断、页脚/脚注区分、重复优化及上下标匹配失败保护。仅测试不代表任意扫描都能正确识别；几何和语义无法可靠关联的区域仍保留原图与校正入口。

桌面和手机回归 `tests/e2e/document-reflow.spec.ts` 使用忽略目录 `.data/reflow-qa/browser-fixture.json` 指向本地已优化的 PDF；未准备样本时明确跳过。现有阅读、翻译浏览器测试保持独立。用户文档、会话和产物不进入代码库。

本次实际物理试卷复用了已保存的部分译文，原有 854 个内容 ID 和对应文字保留。完整试卷尚有未完成的翻译，因此仅验证其离线重排和双向阅读，不将其标记为翻译完成。真实模型验证使用额外的短 PDF 和混合粗体 DOCX；预览／下载字节一致、改字号后缓存更新及旧下载保持不变另行验证。

模糊扫描、手写、跨栏关系不可靠和图内文字仍须人工核对。样本测试不代表任意输入都能无损自动转换。
