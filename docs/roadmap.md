# FormatOwl 产品与交付路线

本文件记录用户确认的完整产品范围。阶段 1 的本地验收完成不代表完整网页产品交付。

## 产品

- 一站式 AI 文件处理工具，海外优先、中英双语。
- 首页：**FormatOwl，让文件变成你需要的样子。**
- 首页介绍：视频、音频、图片和 PDF，在线压缩、剪辑、转换与 AI 翻译，轻松完成。
- 中文标语：压缩、剪辑、转换、翻译，一站完成。
- 英文标语：Compress. Edit. Convert. Translate.
- 网页先行，macOS / Windows 后续使用 Tauri 2 + React + FFmpeg sidecar。
- 基础限额免费；大文件、高用量、AI 任务消耗积分；订阅补充积分。

## 分阶段交付

### 1. 平台基础与首条链路（本次）

- [x] monorepo、Next.js、双语品牌首页和工具入口。
- [x] 私有 S3 兼容存储直传、分片恢复、匿名会话授权。
- [x] PostgreSQL / Drizzle、BullMQ / Redis、事务发件箱、独立 FFmpeg worker。
- [x] 视频压缩参数、真实处理、任务进度、预览、下载、取消、重试、删除。
- [x] Better Auth 邮箱注册、验证、登录、密码重置及游客任务归属；替换原 Supabase 认证代码。
- [ ] Google OAuth / Resend 真实验收：等待用户配置凭据与发信域名；[本地流程与申请清单](authentication.md)。
- [ ] 真实 R2 / PostgreSQL / Railway / Vercel 环境验证与部署：没有部署授权，暂不执行。

### 2. 全部基础工具

| 工具       | 完整能力                                                                         | 当前状态                                                 |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 视频压缩   | 比例 / 质量预设、目标大小、H.264/H.265、分辨率、码率、编码速度、兼容性、预览对比 | 本地首条链路可用；大文件压测与不兼容输入的服务端预览待补 |
| 图片压缩   | 批量 JPG/PNG/WebP/GIF/HEIC，透明与动画保留，单个 / ZIP 下载                      | 已完成本地真实处理、批量及 ZIP 验证                      |
| PDF 压缩   | 批量、轻度 / 均衡 / 强力、保留文字与页面结构                                     | 已完成本地真实处理、批量及 ZIP 验证                      |
| 音频压缩   | 质量预设、码率、采样率、声道、批量输出                                           | 已完成本地真实处理、批量及 ZIP 验证                      |
| 视频剪切   | 时间轴、精确时间、保留 / 移除选区、拼接剩余片段                                  | 已完成本地真实处理；详见编辑验收记录                     |
| 视频裁剪   | 自由 / 固定比例 / 自定义尺寸、实时预览、MP4/MKV/MOV 输出                         | 已完成本地真实处理；详见编辑验收记录                     |
| 音频剪辑   | 波形、片段操作、淡入淡出、音视频输入、M4R                                        | 已完成本地真实处理；详见编辑验收记录                     |
| 视频转 MP3 | 音轨提取、质量、试听与下载                                                       | 已完成本地真实处理；详见编辑验收记录                     |
| 视频转换   | MP4/MOV/MKV/WebM，编码 / 分辨率 / 帧率                                           | 待开发                                                   |
| 音频转换   | MP3/WAV/AAC/M4A/FLAC/OGG                                                         | 待开发                                                   |
| 图片转换   | JPG/PNG/WebP/AVIF 输出，HEIC 输入                                                | 待开发                                                   |

同时完成统一文件类型识别与工具推荐、批量处理、文件直链、Google Drive / Dropbox 导入。直链导入必须限制内网地址与重定向。

### 3. 全部 AI 工具

视频、文档、图片翻译已完成本地真实处理、校正与导出，详见 [翻译实现与验收](translation-tools.md)。本次范围不含 AI 阅读、账户、支付和云部署。

| 工具         | 完整能力                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| 音视频转文字 | 文件 / 链接 / 录音，识别语言、说话人、时间戳，编辑并导出 TXT/DOCX/PDF/SRT/VTT                              |
| 视频翻译     | 保留原音、字幕翻译、原译文对照、编辑和显示控制，原文 / 译文 / 双语字幕及烧录视频；TXT/DOCX/PDF/SRT/VTT/ASS |
| 文档翻译     | PDF/Word/TXT/EPUB，扫描件 OCR、语言检测、双语阅读、译文 / 双语下载                                         |
| 图片翻译     | JPG/PNG/WebP/SVG，OCR 坐标、重绘排版、人工校正、双语 / 译文 / 文本视图，图片下载与文字复制                 |

AI 阅读包含文档 / 图片摘要、思维导图、内容问答，附页码或片段引用。统一 `TranscriptSegment` 和 `DocumentBlock` 数据，让编辑内容进入最终导出。

规划接入 OpenAI 转写 / 翻译 / 结构化输出、Azure OCR / Document Translation，长音频分段与说话人校正、大 PDF 拆分合并、Word/EPUB 结构保留、pgvector 检索。具体模型版本和服务额度在实际接入时重新核实。本阶段未安装 AI SDK、未发起 AI 付费调用。

### 4. 商业化与完整验收

- Paddle Billing：订阅、结账、变更 / 取消、客户门户、Webhook 去重；正式收款以商户审核通过为前提。
- 积分账本：发放 / 预留 / 结算 / 释放，在数据库事务内保证幂等。
- 运营后台：用户、任务、失败原因、成本、积分调整、套餐配置。
- 中英内容：工具 SEO、FAQ、博客、反馈、完整政策页面。
- Sentry、生产资源限制、限流、监控、告警、文件清理与处理步骤恢复。

### 5. 桌面端

Tauri 2 + React + FFmpeg sidecar，复用参数与界面；本地离线处理、批量队列、硬件加速、视频转 GIF、录音、变速 / 倒放。

## 完整产品验收门槛

- 15 工具均完成真实导入 → 设置 → 处理 → 预览 → 下载，各格式有样本。
- 适用媒体工具覆盖 1 / 5 / 10 GB，文档覆盖 50 MB；格式支持与使用限额分开定义。
- 覆盖 HEIC、透明图、GIF、旋转 / 可变帧率 / 无音轨视频、扫描 PDF、损坏文件。
- 覆盖上传中断、页面刷新、进程退出、AI 限流、取消、支付重复通知、积分退还。
- 字幕时间轴正确、PDF 可读、图片译文无明显溢出，预览与导出一致。
- 表格 / 分栏 / 扫描件 / 长译文 / RTL 版式测试，无法恢复区域显式标记。
- Vitest / pytest / Playwright 与真实媒体 / AI 质量验收；Python 测试在 Python 处理模块引入时增加。

## 技术路线

Next.js + TypeScript + Tailwind + shadcn/ui + next-intl；Uppy / PDF.js / wavesurfer；PostgreSQL + Better Auth / Drizzle；私有 R2；BullMQ / Redis；原生 FFmpeg / ffprobe；Sharp/libvips（HEIC 能力需验证镜像）；必要的 Python pikepdf / Pillow / OpenCV；OpenAI + Azure；Paddle；Vercel + Railway Docker + Sentry。

没有为后续功能预建空接口、假数据或空账本。按每条可运行链路逐步增加依赖与数据模型。

完整网页版本的 12–18 周与基础设施 150–400 美元/月是用户原方案的规划值，本次未重新估算或作成本承诺。

参考范围：[压缩工具](https://videocompress.ai/)、[音频剪辑](https://videocompress.ai/audio-cutter)、[转写](https://videocompress.ai/video-to-text-converter)、[视频翻译](https://videocompress.ai/video-translator)、[文档翻译](https://videocompress.ai/pdf-translator)、[图片翻译](https://videocompress.ai/image-translator)。本次工程实现未实测参考站的付费账户行为。
