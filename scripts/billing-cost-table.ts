import { writeFile, mkdir } from 'node:fs/promises';
import toolLabels from '../apps/web/messages/zh/tools.json';
import { tools } from '@filemorph/core/catalog';
import {
  creditsForMicroCny,
  microCny,
  initialPriceBook,
  findRate,
} from '@filemorph/core/billing-model';
const samples: Record<string, string[]> = {
  'video-compressor': [
    '1 分钟 / 720p / H.264',
    '10 分钟 / 1080p / H.264',
    '60 分钟 / 4K / H.265 / 两遍',
  ],
  'video-converter': ['1 分钟 / MP4', '10 分钟 / 1080p WebM', '60 分钟 / 4K H.265'],
  'video-cutter': ['保留 30 秒 / 1 个片段', '保留 5 分钟 / 10 个片段', '保留 60 分钟 / 50 个片段'],
  'video-cropper': ['1 分钟 / 720p', '10 分钟 / 1080p', '60 分钟 / 4K'],
  'audio-compressor': ['1 分钟 / 单声道', '10 分钟 / 双声道', '120 分钟 / 双声道'],
  'audio-converter': ['1 分钟 / MP3', '10 分钟 / FLAC', '120 分钟 / WAV'],
  'audio-cutter': ['1 分钟 / 1 个片段', '10 分钟 / 10 个片段', '120 分钟 / 50 个片段'],
  'video-to-mp3': ['1 分钟 / 128 kbps', '10 分钟 / 192 kbps', '120 分钟 / 320 kbps'],
  'image-compressor': ['1 张 / 1 MP', '1 张 / 12 MP', '250 MP 总像素动画'],
  'image-converter': ['1 张 / 1 MP JPG', '1 张 / 12 MP WebP', '1 张 / 100 MP AVIF'],
  'pdf-compressor': ['10 页文字 PDF', '100 页混合 PDF', '1000 页 / 50 MiB 图片 PDF'],
  transcription: ['10 分钟', '30 分钟', '120 分钟'],
  'video-translator': ['10 分钟字幕', '30 分钟字幕 + MP4', '120 分钟字幕 + MP4'],
  'document-translator': ['1000 字 TXT', '10 页文字文档 / 1 万字', '100 扫描页 / 每页 20 修复区'],
  'image-translator': ['1 MP / 1 个修复区', '12 MP / 10 个修复区', '20 个修复区'],
  'image-watermark-remover': [
    '纯色填充 / 1 个选区',
    '复杂背景 / 1 次云修复',
    '复杂背景 / 10 次云修复',
  ],
  'pdf-watermark-remover': [
    '10 页 / 独立对象移除',
    '10 扫描页 / 10 次云修复',
    '100 扫描页 / 100 次云修复',
  ],
  'word-watermark-remover': [
    '1 页 / 独立水印对象',
    '10 页 / 独立水印对象',
    '100 页 / 独立水印对象',
  ],
  'ppt-watermark-remover': ['1 张 / 独立水印对象', '10 张 / 独立水印对象', '100 张 / 独立水印对象'],
};
let md =
  '# 全功能成本与积分样本矩阵\n\n本表是可复现的样本规格与已知成本分解，不是未经实测的销售价。完整积分必须加上资源、存储、传输及其他 AI 环节；未核价时不得启用付费。\n\n固定基础设施 300 元/月；100 积分 = 1 元；20% 风险缓冲、70% 贡献毛利、10% 支付预留，对应每元核算成本 600 积分。包月内资源分摊只用于定价，月报不重复扣除。\n\n| 功能 | 档位 | 样本 | 已知模型部分成本 | 模型部分积分 | 完整价格 / 证据 |\n|---|---|---|---:|---:|---|\n';
for (const tool of tools)
  for (let i = 0; i < 3; i++) {
    let cost: number | null = null,
      evidence = '生产资源未校准，完整价格待核';
    if (['transcription', 'video-translator'].includes(tool.id)) {
      cost = [600, 1800, 7200][i] * 0.00022;
      evidence =
        tool.id === 'transcription'
          ? 'ASR 官方价格；资源部分待核'
          : '仅 ASR；文本网关、视频导出另计';
    }
    if (tool.id === 'image-translator') {
      cost = [1, 10, 20][i] * 0.03;
      evidence = '仅修复站内额度；现金兑换、OCR、翻译另核';
    }
    if (tool.id === 'image-watermark-remover') {
      cost = [0, 1, 10][i] * 0.03;
      evidence = '修复站内额度；本地处理也有资源成本';
    }
    if (tool.id === 'pdf-watermark-remover') {
      cost = [0, 10, 100][i] * 0.03;
      evidence = '仅示例云修复；OCR 和资源另计，现金兑换待核';
    }
    if (tool.id === 'document-translator' && i === 2) {
      cost = 100 * 20 * 0.03;
      evidence = '仅 2000 次修复的站内额度；严禁按整份文档固定低价';
    }
    md += `| ${toolLabels[tool.id].name} | ${['小', '中', '大'][i]} | ${samples[tool.id][i]} | ${cost === null ? '待测' : cost.toFixed(4) + ' 元'} | ${cost === null ? '待测' : creditsForMicroCny(microCny(1, cost), false)} | ${evidence} |\n`;
  }
md +=
  '\n## 附加操作\n\n| 操作 | 小 / 中 / 大样本 | 计价要求 |\n|---|---|---|\n| 摘要 | 1000 / 10000 / 100000 字 | 分段请求与汇总全部输入输出 Token，按实际阶梯结算 |\n| 思维导图 | 1000 / 10000 / 100000 字 | 分段及汇总 Token，包含本地 PNG/SVG 渲染 |\n| 问答 | 短文首轮 / 万字第 3 轮 / 长文第 6 轮 | 正文、问题、历史消息与输出 Token |\n| 预览 | 1 页 / 10 页 / 15 秒视频烧录 | 首次处理计量，相同版本复用不重复收费 |\n| 导出 / ZIP | 单个文本 / 20 文件 ZIP / 4K 字幕 MP4 | 文本导出不重复调用 AI；格式处理与读写计量 |\n\n## 核价证据\n\n- ASR、OCR、阅读：[阿里云原价](https://help.aliyun.com/zh/model-studio/model-pricing)，核对日期 2026-09-16。免费额度不用于制定长期底价。\n- 修复：`docs/image-repair-pdhlzy-evaluation.md`，约 0.03 元/调用是当前分组的站内额度，不等于已经验证的现金成本。\n- 文本网关：实际结算价未知，不套用同名官方模型价格。\n- 资源：通过真实任务 `cost_usage.runtime_ms` 收集子进程墙钟毫秒；该数值不是 CPU 核秒，也不是等待 AI 返回的时间。生产硬件、线程和并发固定后，用账单和有效容量校准每毫秒分摊单价。\n- 无生产环境规格和账单时，不能把本机运行时间写成生产验收；上述未测项保持待核价。\n';
await mkdir('docs', { recursive: true });
await writeFile('docs/pricing-cost-matrix.md', md);
console.log('docs/pricing-cost-matrix.md: 19 tools × 3 sample sizes plus ancillary operations');
