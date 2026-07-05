# pxpipe-cn

> 本仓库 fork 自 [teamchong/pxpipe](https://github.com/teamchong/pxpipe)，是更适合中国宝宝体质的中文适配版本。
> 上游对 CJK 内容仅做保守处理，本 fork 的目标是补齐中文场景：CJK 字形渲染、中文 token 密度校准与中文文档（见[中文适配 Roadmap](#中文适配-roadmap)）。当前代码同步至上游 v0.8.0。
> English original: [README.en.md](README.en.md)

**把 Claude Code 请求里臃肿的上下文渲染成图片，从而削减输入 token —— 同样的系统提示词、工具文档和历史记录，只花一小部分 token。**

图片的 token 费用由像素尺寸决定，与图里装了多少文字无关。在真实的
Claude Code 流量上，密集内容（代码、JSON、工具输出）以图片计费约合
3.1 字符/token，而按文本计费约为 1 字符/token。pxpipe 是一个本地代理，
利用的正是这个差价：它在每个请求离开你的机器之前，把其中臃肿的部分改写成
高密度 PNG。按当前 Fable 定价，端到端账单约能降低 **59–70%** ——
但价格会变、负载各异，真正可靠的指标是 token 削减量本身：每个请求都会
与一次免费的 `count_tokens` 反事实探测对照，逐条记录在
`~/.pxpipe/events.jsonl` 中。

模型实际看到的不是文本，而是这样的页面：

![示例：一次真实的 transformRequest 输出——系统提示词 + 工具文档重排为一张 1573×1248 的密集页面，顶部是指令横幅，↵ 标记原始换行](https://raw.githubusercontent.com/teamchong/pxpipe/main/docs/assets/example-render.png)

*约 4.8 万字符的系统提示词 + 工具文档：按文本计费约 2.5 万 token，
渲染成这张页面后约 2700 个图片 token。这是真实管线的输出；模型阅读
这类渲染页的准确率为 100/100（见下文基准测试）。*

## 演示

**Fable 5（默认启用，阅读准确率 100/100）—— 左边原生，右边 pxpipe：**

https://github.com/user-attachments/assets/1c8ee63a-fcd7-4958-917b-da788d718349

pxpipe 一侧在 39 个已图片化的填充文件中数出了精确的 token 计数
**10/10**（与 `grep` 逐行一致），多步账目算术也全部正确，
会话结束时花费 **$6.06**、上下文余量充足（73.5k/1M）；原生一侧花费
**$42.21**、上下文占用 96%。片中可见的一个瑕疵：pxpipe 一侧需要
提醒一次才按要求输出单行格式。

**Opus 4.8（默认关闭）—— 相同布局：**

https://github.com/user-attachments/assets/f4e50137-31b5-426f-a6ed-b83f829b4a2c

文本 needle 两侧都能正常读出；图片化的短语计数在 Opus 上读不出来 ——
此时 pxpipe **会明说读不出，而不是编造一个数字**。正是这个误读率
让 Opus 被设为需手动开启。

## 上手（30 秒）

```bash
npx pxpipe-proxy                                  # 代理监听 127.0.0.1:47821
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude  # 让 Claude Code 走这个代理
```

仪表盘在 <http://127.0.0.1:47821/>：已节省的 token、每次文本→图片
转换的逐条对照、总开关、实时模型芯片。响应正常流式返回 ——
pxpipe 只压缩*请求*，从不动模型的输出。最近的对话轮保持文本；
系统提示词、工具文档和较早的大块历史会被图片化。

## 有话直说

- **这是有损压缩。** 在密集图片化内容里回读精确的 12 位十六进制串：
  Fable 5 为 **13/15**，Opus 为 **0/15** —— 而且读错时是*悄无声息的
  编造*，不会报错。要求逐字节精确的值（ID、哈希、密钥）必须留在文本里；
  最近的对话轮本来就是文本。专门的逐字风险防护尚未实现。
- **逃生通道：** 运行在允许列表之外模型上的子代理会以纯文本直通 ——
  把逐字节精确的工作路由过去即可
  （`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6`，或在 agent
  frontmatter 里写 `model: sonnet`）。
- **真实任务：** SWE-bench Lite 试点两侧均 **10/10**，请求体积 −65%；
  SWE-bench Pro 开启 **14/19** vs 关闭 **15/19**，体积 −60%，19 例中
  18 例判定一致，唯一的分歧样本复测 3/3 全部解出 —— 属于运行间方差，
  不是压缩所致。样本量小；凭据在 `eval/`。
- **收益取决于负载。** 在 token 密集内容（约 1 字符/token）上赚，
  在稀疏散文（约 3.5 字符/token）上赔；一个盈利性闸门
  （基于 N=391 条生产数据校准）只在数学上划算时才图片化。
- **模型范围：** 默认 `PXPIPE_MODELS=claude-fable-5,gpt-5.6`。
  Opus 4.7/4.8 约有 7% 的渲染页误读，GPT 5.5 在图片化上下文上表现
  下降，因此两者都需通过 `PXPIPE_MODELS` 或仪表盘芯片手动开启。
  `PXPIPE_MODELS=off` 可完全禁用图片化。其余一切逐字节直通。
  GPT 路径上，工具定义保持原生 JSON，也不会使用 Anthropic 的
  `cache_control` 标记。

## 基准测试（可复现）

使用模型不可能背过的新造随机数题目测得：

| 测试 | N | 文本 | pxpipe（图片） | token |
|---|---:|---:|---:|---|
| 新造算术题，`claude-fable-5` | 100 | 100% | **100%** | **−38%** |
| 新造算术题，`claude-opus-4-8` | 100 | 100% | 93% | −38% |
| 要点回忆 A/B（决策、数值、路径、名称、否定式；含干扰项；1.5万–4.5万字符会话），Fable 5 | 98/组 | 98/98 | **98/98** | - |
| 状态跟踪（值被改写 3 次，问最终值/初始值/次数），Fable 5 | 18/组 | 18/18 | **18/18** | - |
| 对从未陈述过的事实的编造率（越低越好），Fable 5 | 16/组 | 0/16 | **0/16** | - |
| 逐字回读 12 位十六进制，密集渲染页，Opus | 15 | 15/15 | **0/15** | - |
| 逐字回读 12 位十六进制，密集渲染页，Fable 5 | 15 | - | **13/15** | - |

SWE-bench 完整数据、凭据与注意事项：
[`eval/swe-bench/`](eval/swe-bench/) ·
[`eval/swe-bench-pro/`](eval/swe-bench-pro/) ·
[`eval/needle-haystack/`](eval/needle-haystack/) ·
[`eval/gist-recall/`](eval/gist-recall/) · 分析见
[`FINDINGS.md`](FINDINGS.md)。（GSM8K 图片化后得分 96%，但它在训练
数据里 —— 背下来的答案抗误读 —— 所以我们以新造数字的评测为准。）

## 工作原理

```
tool_result 字符串 ──► 按 1928px 宽分栏折行 ──► 每页装填约 92,000 字符 ──► PNG[]
```

代理拦截 `/v1/messages`，把符合条件的大块内容改写为图片块，再以
缓存友好的方式拼回去（静态前缀保持不变，prompt caching 继续生效），
然后转发。一张 1928×1928 的图片约花费 4761 个视觉 token、可容纳约
92,000 字符，因此只有当文本超过约 19 字符/token 时文本才更划算 ——
而 Claude Code 的实际流量约为 1.91（N=391）。每个请求由估算器逐一
判断；稀疏散文保持文本。事件记录在 `~/.pxpipe/events.jsonl`。

## 作为库使用（不经代理）

```ts
import { renderTextToImages, transformAnthropicMessages } from "pxpipe-proxy";

const { pages } = await renderTextToImages(toolResultText);     // pages[i].png: Uint8Array
const { body, applied, info } = await transformAnthropicMessages({
  body: requestBytes,
  model: "claude-fable-5",
});
```

`options.keepSharp(block)` 可将指定块固定为文本；`options.emitRecoverable`
会返回被图片化块的原文。纯 JS 运行时（Node 及 edge/Workers）；
`@napi-rs/canvas` 仅在构建期使用。完整 API 见 `src/core/index.ts`。

## 开发

```bash
pnpm install && pnpm test
pnpm run build                # 重新生成 dist/
```

## FAQ

**标题里的省钱比例是端到端的，还是只算被压缩的那些请求？**
端到端，算的是整张账单。多数压缩工具只在它们碰过的输入切片上报节省
比例，数字会因此虚高。这里的端到端分母是*所有*生产请求：pxpipe 正确
放行未动的小请求、全部缓存写入与读取、以及全部输出 token（代理从不
压缩输出）。在一份 13,709 个请求的快照上是 59%（$100 → 约 $41）；
之后一份含 8,904 个被压缩请求的记录测得约 70%。只统计被压缩请求则
更高（约 72–74%），该口径单独标注，从不用作标题数字。确切比例取决
于负载 —— 请在你自己的日志上复现。

**省钱是怎么算出来的？**
同一请求的两侧，在同一时刻测量。对每个 `/v1/messages` POST，代理在
真实转发的同时，对原始未压缩请求体并行发起一次免费的 `count_tokens`
探测（作为反事实基线），并从响应中读取 Anthropic 实际计费的 usage
数据。两者落在 `~/.pxpipe/events.jsonl` 的同一行里，因此不存在轮数
或运行间的混杂因素。折算美元使用 Fable 5 定价比例：输入 ×1.0、缓存
写入 ×1.25、缓存读取 ×0.1、输出 ×5。缓存定价对两侧一视同仁，缓存
折扣相互抵消，不可能被重复计入"节省"。你可以从事件日志自行重新推导：
公式与字段名记录在 `src/core/baseline.ts`。

**中转站不支持 count_tokens 怎么办？**
部分中转对 `/v1/messages/count_tokens` 返回 404，基线探测会一直
`failed`。可设 `PXPIPE_USAGE_PROBE_RATE=0.05`（默认 0 关闭）开启采样
兜底：count_tokens 失败后，按该概率把压缩前原文以 `max_tokens=1` 重放
到 `/v1/messages`，读计费 usage 块作基线。这不免费（按输入价计费），
故只采样；探测体会剥掉 `cache_control`，不污染缓存。事件行的
`baseline_probe_method` 字段区分两种测法。

**它到底压缩什么？**
三类*输入*块，每类都要过盈利性闸门：

1. 大体积 `tool_result`（文件读取、命令输出、日志），token 密集且
   超过约 6000 字符
2. 较早的折叠历史：活跃尾部之前的对话轮会被重新渲染为图片页，
   最近的对话轮始终保持文本
3. 静态的系统提示词 + 工具文档整块

其余一切逐字节直通：你的消息、最近的对话轮、模型的输出（那是响应，
代理从不碰它）、稀疏散文、以及体积太小不划算的内容。允许列表之外的
模型整体直通 —— 默认范围仅 Fable 5 和 GPT 5.6。Opus 4.8 和 GPT 5.5
阅读图片化内容的能力显著更差（FINDINGS.md 2026-06-16），所以它们
必须通过仪表盘或 `PXPIPE_MODELS` 明确开启，绝不会被悄悄图片化。

**在基准测试之外，它真实翻过车吗？**
翻过，数周日常使用中出过一次：模型从图片化的聊天历史里回忆一个人名，
自信地答错了。没有报错，只是一个貌似合理的错名字。这正是已记录在案
的失效模式：图片化内容中的精确字符串不保证逐字节正确。编码类会话能
容忍这一点，因为 agent 在编辑前会重新读文件；纯聊天式回忆则没有这层
校验。这个失效模式是被测量过的，不是轶事：
[可读性审计](docs/LEGIBILITY-AUDIT-2026-07-01.md)量化了从渲染页
回读精确字符串的能力（盲读在密集标识符上最高 63%，且每次误读都能被
字形混淆矩阵预测），并记录了已上线的缓解措施 —— 页面几何钳制到 API
的重采样上限，确保计费像素真正到达视觉编码器；精确标识符（SHA、
数字）以文本形式随行。

**为什么这份 README 读起来像 AI 写的？**
因为就是 AI 写的。本仓库的绝大多数提交 —— 代码和文档 —— 都出自
运行在 pxpipe 之后的 Opus/Fable agent 会话，它们一边工作，一边以
图片页的形式阅读自己被折叠的历史。

## 局限

- 有损（见上文）；从图片逐字回读不可靠（中英文皆然 —— 精确 ID 以文本随行）。
- 大请求在发出前要先做 PNG 编码，会增加延迟。
- 上游仅充分测试 ASCII/Latin-1；本 fork 已完成中文适配（专用 2× 几何 +
  闸门重校准，见下节），但中文图片化毛利天然较薄，gist 召回低于纯文本
  （75% vs 100%，失败模式为诚实的 UNKNOWN 而非虚构）。

## 中文适配 Roadmap

上游对 CJK 只做保守处理（见上一节最后一条），而这恰是本 fork 存在的
理由。完成一项勾一项（数据与方法见 `docs/FINDINGS-cn.md`）：

- [x] **CJK 字形渲染**：三层图集 Spleen → Fusion Pixel 8px（OFL-1.1）→
  Unifont 兜底，CJK 统一表意区全覆盖、真实语料 0 丢汉字；CJK 重度块走
  2× 最近邻放大 + 2px 行距专用几何（8px 汉字受限于视觉编码器分辨率，
  且紧排行会视觉咬合 —— 见 FINDINGS-cn §2/§4）
- [x] **中文 token 密度重新校准**：闸门图片侧格数化（CJK=2 格）、文本侧
  混合密度 CPT_CJK=1.5（真实流量回归实测确认，R²=0.996）、阈值 token
  等效化；4k 字中文 tool_result 从上游「直通」翻为「图片化」，纯英文
  决策逐位不变
- [x] **中文可读性评测**：L1 OCR（Unifont 76.3% → Fusion 81.7% → 2×
  93.7%）、needle（中英同为 ~0，与上游「图片属 gist 层」结论一致）、
  gist-recall（行距剂量-响应 28→53→75→86%，虚构 0）—— 同口径数据齐全
- [ ] **中文文档**：README（本文件）✓、FINDINGS-cn ✓；docs/ 其余关键
  文档的中文化未做
- [ ] **持续跟进上游**：定期同步 teamchong/pxpipe 的修复与发布

## 上游 Roadmap

假设而非承诺 —— 要么带着样本量以数字形式落地，要么砍掉：
更锐利的字形渲染（`eval/glyph-matrix/`，运行中途暂停）、图片化的
大块内容能否拉伸有效上下文（同一个 1M 窗口装下约 2 倍的真实内容）、
以及更小的活跃上下文是否能提升长任务的准确率。

## 许可证

MIT。
