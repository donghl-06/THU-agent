# THU Assistant Agent — 新手开发路线图（框架流程详解）

> 这份文档是给 **Agent 开发纯新手** 的落地指南。
> 它把 `plan4ai.md`（架构原则）和 `plan4me.md`（阶段规划）翻译成
> “每一步具体做什么、为什么这么做、怎么验证做对了”。
>
> 读完本文你应该能回答三个问题：
> 1. 我在做一个什么东西？（概念）
> 2. 它由哪几层组成，每层干什么？（架构）
> 3. 下一步具体敲什么命令、写什么代码？（行动）

---

## 第一部分：先搞懂概念（10 分钟）

### 1.1 什么是 Agent？和 Chatbot 有什么区别？

**Chatbot（聊天机器人）**：用户问 → 模型直接生成文字回答。模型只有“嘴”。

**Agent（智能体）**：用户问 → 模型判断“我需要先查点数据/做点事”→ 调用工具 →
拿到真实数据 → 再综合成回答。模型有“手”（工具）和“决策能力”（判断用哪只手）。

本项目的 Agent 长这样：

```text
用户: "我今晚没课的话想打羽毛球，帮我看看什么时候合适。"
                        │
                        ▼
              DeepSeek（大脑，负责推理）
                        │
            "我得先查他今天课表"  ← 模型自己决定的，不是我们写死的
                        │
                        ▼
              get_schedule（工具1）→ 真实课表数据
                        │
            "他 19 点后没课，再查羽毛球场地"
                        │
                        ▼
              get_sports_resources（工具2）→ 场地数据
                        │
                        ▼
              DeepSeek 综合两个结果：
              "你 19 点后没课，气膜馆 19:30-21:00 还有 2 片羽毛球场……"
```

**关键认知**：上面的流程里，"先查课表、再查场地"这个**计划是 LLM 临时推理出来的**，
不是我们写的 if-else。这就是 Agent 和传统 App 的本质区别。

### 1.2 三个核心术语

| 术语 | 是什么 | 本项目里对应 |
|---|---|---|
| **Skill（技能/工具）** | 一个原子能力：输入参数 → 返回结构化数据。如 `get_schedule` | 对 `@thu-info/lib` 某个 API 的薄封装 |
| **Function Calling（工具调用）** | LLM 的一种输出模式：模型不回答文字，而是输出"我要调用 get_schedule，参数是 {date: '2026-08-28'}"这样的结构化请求 | DeepSeek API 原生支持 |
| **Harness（运行时/支架）** | 我们自己写的调度代码：把工具清单告诉模型 → 收到模型的工具调用请求 → 执行对应 Skill → 把结果塞回对话 → 让模型继续。这个循环叫 **Agent Loop** | `src/harness/`（后期才写） |

### 1.3 为什么采用 Bottom-up（自底向上）开发？

新手最容易犯的错：**先搭一个花哨的 Agent 框架，再往里填功能**。
结果是框架很热闹，但每个工具都不靠谱，整体不可用。

本项目反着来：

```text
先把最底层的校园 API 跑通（能登录、能查课表）
        ↓
封装成稳定、可独立测试的 Skill
        ↓
最后才接 LLM（此时工具都已验证，出了问题容易定位）
```

**调试哲学**（plan4ai.md 第 9 节，非常重要）：

```text
Skill 单独测试失败      → 问题在 Skill / ThuClient / @thu-info/lib
Skill 单独测试成功但 Agent 失败 → 问题在 Harness / Prompt / 模型

分层测试让你永远知道"锅在哪一层"，不要把各层问题混在一起调。
```

---

## 第二部分：架构全景（四层职责）

```text
┌─────────────────────────────────────────────┐
│  第4层  DeepSeek Model                       │
│  职责：推理、决定调用哪个 Skill、组织自然语言回答  │
│  我们写什么：Prompt 和 API 调用（最后阶段）       │
├─────────────────────────────────────────────┤
│  第3层  DeepSeek Harness（src/harness/）       │
│  职责：注册工具、跑 Agent Loop、管理会话、       │
│        写操作前找用户确认                       │
│  我们写什么：调度循环代码（第 3 批工作）          │
├─────────────────────────────────────────────┤
│  第2层  THU Skills（src/skills/）             │
│  职责：校验输入 → 调 ThuClient → 规范化输出      │
│  我们写什么：5 个薄封装（第 2 批工作）★当前重点   │
├─────────────────────────────────────────────┤
│  第1层  ThuClient（src/client/）              │
│  职责：登录、Session 保活、重试、超时、错误归一化  │
│  我们写什么：对 @thu-info/lib 的统一包装         │
├─────────────────────────────────────────────┤
│  第0层  @thu-info/lib（参考仓库，我们不写）       │
│  职责：真正和清华服务器通信的 SDK               │
│  来源：reference/thu-info-app/packages/thu-info-lib │
└─────────────────────────────────────────────┘
```

**职责红线**（违反任何一条都会让项目迅速失控）：

- Skill **绝不**自己处理登录/Cookie/Session —— 那是 ThuClient 的事；
- Skill **绝不**包含 LLM 推理、Prompt、对话状态 —— 那是 Harness 的事；
- 我们**绝不**重写清华 Portal 的 HTTP 请求和页面解析 —— 那是 `@thu-info/lib` 已经做好的事；
- Harness **绝不**直接调 `@thu-info/lib` —— 必须经过 Skill。

---

## 第三部分：Skill 的统一长相（写代码前先看懂）

所有 Skill 遵循同一个接口（TypeScript）：

```typescript
// src/skills/base/types.ts —— 整个项目最重要的一个文件
interface Skill {
    name: string;           // 给模型看的名字，如 "get_schedule"
    description: string;    // 给模型看的说明，模型靠它决定何时调用
    inputSchema: object;    // JSON Schema，描述参数，模型靠它填参数
    execute(input: unknown): Promise<SkillResult>;
}

interface SkillResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
}
```

**为什么 `description` 和 `inputSchema` 这么重要？**
因为将来 Harness 会把它们原样发给 DeepSeek。模型**只通过这两个字段认识你的工具**。
description 写得含糊 → 模型乱调用；schema 写得含糊 → 模型乱填参数。

**什么能做 Skill / 什么不能**：

```text
✅ 原子能力：get_schedule / get_campus_card_info / get_library_seats
❌ 业务目标：plan_my_day / help_me_choose_course
   （这些是模型组合多个 Skill 完成的任务，不是一个 Skill）
```

**Read vs Write 安全边界**：

- **Read Skill**（查课表、查余额）：模型可以自主调用；
- **Write Skill**（预约、充值、选课、退课）：模型只能"提议"，
  必须由 Harness 把具体操作展示给用户、用户明确确认后才执行。
  第一版只实现 Read Skill。

---

## 第四部分：开发路线图（14 步，每步有验证标准）

> 严格按顺序做。每一步都有"完成标准"，达不到就不进下一步。

### 🟦 阶段 A：跑通底层（Step 0–3）— 证明"能和清华服务器说话"

**Step 0 · 环境初始化（本次已完成）**
- WSL2 + Node 22 + pnpm ✔
- 克隆参考仓库到 `reference/thu-info-app` ✔
- 初始化 `thu-assistant` 项目骨架 ✔

**Step 1 · 跑通 @thu-info/lib**
- 做什么：阅读 `reference/thu-info-app/packages/thu-info-lib/README.md`，
  按其说明在 Node 里创建 `InfoHelper` 实例。
- 完成标准：`new InfoHelper()` 不报错。

**Step 2 · 登录成功**
- 做什么：把清华账号密码放进 `.env`（**绝不写进代码、绝不提交 git**），
  写一个 `scripts/test-login.ts`，调用库的登录方法。
- 完成标准：终端打印"登录成功"并能看到自己的用户信息（如姓名/学号）。
- ⚠️ 遇到验证码/双因子：查库里有没有对应处理（参考仓库 demo 里有线索）。

**Step 3 · 拿到真实课表**
- 做什么：登录后调用 `getSchedule()`，把返回的 JSON 打印出来。
- 完成标准：终端看到本学期真实课程数据。
- 至此阶段 A 完成：**底层链路已通，且完全没碰 LLM**。

### 🟩 阶段 B：封装 Skills（Step 4–9）— 当前项目的核心工作

**Step 4 · 建立 ThuClient**
- 做什么：写 `src/client/ThuClient.ts`，把 Step 1–3 里散落的登录/调用逻辑收进一个类：
  `login()`、`getSchedule()`，统一处理错误和重试。
- 完成标准：把 Step 3 的脚本改成走 ThuClient，结果不变。

**Step 5 · 定义 Skill 接口**
- 做什么：写 `src/skills/base/types.ts`（上文第三部分的两个 interface）。
- 完成标准：文件能编译。这步代码很少，但它是全项目的"宪法"。

**Step 6 · 实现第一个 Skill：get_schedule**
- 做什么：`src/skills/schedule/getSchedule.ts` —— 校验输入（日期格式）
  → 调 `ThuClient.getSchedule()` → 把库返回的原始数据裁剪成稳定、简洁的 JSON
  （模型读不懂也不需要原始 HTML 和冗余字段）。
- 完成标准：`execute({date: "2026-08-28"})` 返回 `{success: true, data: {courses: [...]}}`。

**Step 7 · 给 get_schedule 写独立测试**
- 做什么：`tests/skills/getSchedule.test.ts`，**不依赖 DeepSeek、不依赖 Harness**，
  直接调 execute 断言返回结构。
- 完成标准：`pnpm test` 通过。

**Step 8 · 按优先级扩展另外 4 个 Read Skill**

```text
get_campus_card_info  →  get_classroom_state  →  get_library_seats  →  get_sports_resources
```

- 每加一个，重复 Step 6–7 的模式（实现 → 独立测试）。
- 不确定库 API 时：**查 `reference/thu-info-app/packages/thu-info-lib/src/`，不猜**。

**Step 9 · 五个 Skill 全部独立测试通过**
- 完成标准：`pnpm test` 全绿；每个 Skill 都能用一行 execute() 拿到稳定 JSON。
- 至此阶段 B 完成：**Agent 的"手"全部造好且都验过货**。

### 🟨 阶段 C：接入大脑（Step 10–12）— 第一次成为真正的 Agent

**Step 10 · 最小 DeepSeek Harness**
- 做什么：`src/harness/`，只做六件事：工具注册 → 生成 Tool Schema →
  调 DeepSeek API（带 tools 参数）→ 识别模型的 tool_calls → 执行对应 Skill →
  把结果以 tool 消息塞回对话，循环直到模型输出文字。
- **明确不做**：多 Agent、Planner、长期记忆、RAG、向量库、工作流引擎。
- 完成标准：Agent Loop 闭环能跑。

**Step 11 · 单 Skill Agent（V0.1 里程碑 🎉）**
- 测试句："我今天下午有什么课？"
- 完成标准：DeepSeek 自主决定调 get_schedule → 拿到真实数据 → 用自然语言回答。
  **这就是 plan4ai.md 第 18 节定义的第一个成功 Demo。**

**Step 12 · 多 Skill Agent（V0.2 里程碑 🎉🎉）**
- 测试句："我今晚没课的话想去打羽毛球，帮我看看什么时候合适。"
- 完成标准：模型自主串联 get_schedule + get_sports_resources 并给出建议。
  **此时系统真正具有 Agent 特征，不再是 API Chatbot。**

### 🟥 阶段 D：安全与评估（Step 13–14）— 从能跑到可信

**Step 13 · Write Skills + 用户确认**
- 加 `book_library_seat` 等写操作 Skill，Harness 里实现确认流：
  模型提议 → 终端展示"我将为你预约 某某馆 19:00-20:00 的座位，确认？(y/n)" →
  用户同意 → 才执行。

**Step 14 · Evaluation**
- 建 `eval/cases.json`（30–50 条测试问题，覆盖单 Skill、多 Skill、模糊问题、
  不该调工具的问题、敏感操作），写 `eval/runner.ts` 批量跑分：
  工具选择准确率、参数准确率、多余调用率、安全违规次数。

### 🟪 阶段 E：功能扩充与产品化（Step 15–20）— 从可信到好用

> 2026-08-29 与用户讨论定案。原则：单用户 Web 形态（凭证不出 `.env`）；
> 小程序/多用户 SaaS 因凭证信任与合规问题排除，多用户只走"本机凭证 App"远期路线。

**Step 15 · Read Skills 扩充**
- 依托 thu-info 库新增读技能：`get_report`（成绩单）、`get_physical_exam`
  （体测成绩）、`get_dorm_score`（宿舍卫生）、`get_electricity`（电费余额/
  缴费记录）、`get_network_status`（校园网余额/在线设备）、
  `get_library_rooms`（研讨间查询）。

**Step 16 · 图书馆座位/研讨间预约（Write Skills）**
- 库里现成生产级接口：`bookLibrarySeat`/`cancelBooking`（座位）、
  `bookLibraryRoom`/`cancelLibraryRoomBooking`（研讨间）、`getBookingRecords`。
  走 Step 13 的确认流；加"我的预约查询"读技能配合取消场景。

**Step 17 · 性能优化（含基准实验）**
- LLM 流式输出（SSE，感知提升最大）；模型单轮多 tool_call 时并行执行；
  场馆列表/位置级联等元数据缓存（约 1 天 TTL）；登录态预热保活；
  工具执行事件暴露给调用方（为 UI 进度提示铺路）。
- 先跑基准测一遍现状（首字延迟/完整回答延迟/工具耗时占比），优化后对比。

**Step 18 · 单用户 Web UI**
- 本地 HTTP 服务（SSE 流式）+ 单页前端：对话界面、写操作确认弹窗、
  工具进度提示。Harness 层不动，新加 server 适配层。
- 定位：本人在自己设备上使用；不做多用户账号体系（凭证红线）。

**Step 19 · 支付链路（扫码半自动）**
- 预约下单（PAY_ONLINE）→ 探测 `placeOrder` 等支付端点 → 拿到微信支付
  二维码/链接 → Web UI 直接展示 → 用户扫码在手机确认。
  （微信支付安全模型决定全自动不可能，最后一步必须用户手机确认。）
- 同模式复用：校园卡充值（`cardRechargeFromWechatAlipay`）、
  电费充值（`getEleRechargePayCode`），做成 write skill 走确认流。
- 涉及真钱，用最小面额实测。

**Step 20 · 多模态**
- 语音输入（浏览器 WebSpeech/ASR）、图片输入（需确认模型端点支持 vision）、
  TTS 朗读回复、点击音效。依赖 Step 18 的 UI。

**远期（未定步骤号）· 多用户 App（本机凭证模式）**
- 若未来要给他人用：走 THU Info App 同款信任模型——登录页收学号密码 +
  LLM key，凭证只存用户设备、直连学校服务器，开发者服务器零凭证。
  技术路线：桌面（Tauri/Electron 内嵌现有 Node 栈，改动最小）或
  RN/Flutter 重写 client 层。**明确排除小程序**（信任模型不成立 + 审核风险）。

---

## 第五部分：项目目录（当前脚手架实际结构）

```text
THU-agent/                        ← 项目根（git 仓库）
├── plan4ai.md                    ← 给 AI 的架构约束（已存在）
├── plan4me.md                    ← 给人的阶段规划（已存在）
├── ROADMAP.md                    ← 本文档
├── reference/
│   └── thu-info-app/             ← 参考仓库（只读！已加入 .gitignore）
│       └── packages/thu-info-lib/ ← 第0层能力来源
├── src/
│   ├── client/                   ← 第1层 ThuClient（Step 4 建）
│   ├── skills/
│   │   └── base/types.ts         ← 第2层 Skill 接口（Step 5 建）
│   ├── harness/                  ← 第3层（Step 10 前保持空目录）
│   ├── config/                   ← 环境变量读取
│   └── index.ts
├── scripts/                      ← 一次性验证脚本（test-login.ts 等）
├── tests/                        ← Skill 独立测试
├── eval/                         ← 评估（Step 14 建）
├── .env.example                  ← 凭证模板（真实 .env 不进 git）
└── package.json
```

---

## 第六部分：新手避坑清单

1. **凭证安全**：密码/Cookie/Token 只放 `.env`；`.env` 必须在 `.gitignore` 里；
   日志里绝不打印敏感信息。提交前 `git status` 检查一遍。
2. **不猜 API**：`@thu-info/lib` 任何方法不确定，直接读
   `reference/thu-info-app/packages/thu-info-lib/src/` 和它的测试/demo。
3. **小步快跑**：每个 Step 完成就验证，不要攒三步再测。
4. **分层调试**：Skill 测试挂了查下层，Agent 挂了查上层，不混着查。
5. **抵制诱惑**：看到别人项目有 RAG/Memory/多 Agent 不要眼红 ——
   本项目 V0.2 之前一律不加，复杂度每加一层都要有真实需求证明。
6. **卡住时**：先确定卡在哪一层（用第五部分的目录对应），
   再把该层隔离出来单独复现。

---

## 附：速查 —— 我当前在哪一步？

```text
[已完成] Step 0  环境 + 脚手架
[已完成] Step 1  pnpm step1 — InfoHelper 实例化验证通过
[已完成] Step 2  pnpm step2 — 登录 + getUserInfo() 通过（2FA 信任设备、两处库补丁）
[已完成] Step 3  pnpm step3 — getSchedule() 真实数据链路打通（夏季学期无课属正常）
[已完成] Step 4  src/client/ThuClient.ts + auth.ts + errors.ts，step2/3 已改走 ThuClient
[已完成] Step 5  src/skills/base/types.ts（脚手架时已写）
[已完成] Step 6  get_schedule Skill（src/skills/schedule/getSchedule.ts）
[已完成] Step 7  独立测试 7 个全过（6 单测无网络 + 1 集成测试真实链路）
[已完成] Step 8  5 个 Read Skill 全部实现：
                  get_schedule / get_campus_card_info / get_classroom_state / get_library_seats / get_sports_resources
[已完成] Step 9  全部配双层独立测试（28 全过，含真实链路）
                  ⚠️ 旧体育系统（50.tsinghua.edu.cn）2026-08 整体下线，上游库无法修复。
                  已逆向对接新系统 www.sports.tsinghua.edu.cn（SportsClient，公网直连，
                  见 docs/sports-api-notes.md），真实场地数据验证吻合。
[已完成] Step 10 最小 Harness（src/harness/，OpenAI 兼容协议，纯 fetch 无 SDK）：
                  types.ts（消息/工具类型）→ toolRegistry.ts（Skill→Tool Schema、按名分发）
                  → llmClient.ts（chat.completions 调用）→ agentLoop.ts（Agent 闭环，
                  10 轮上限防失控）。LLM 配置泛化为 LLM_API_KEY/LLM_BASE_URL/LLM_MODEL，
                  Kimi/GLM/DeepSeek 任意切换（当前用 Kimi for Coding 端点 + k3-256k）
[已完成] Step 11 V0.1 里程碑 🎉：pnpm agent 命令行 Agent 上线，
                  真实验证三问全通过——"我今天下午有什么课？"（自主调 get_schedule）、
                  "现在图书馆还有座位吗？"（get_library_seats）、
                  "今晚气膜馆羽毛球还有场吗？"（get_sports_resources）
                  双层测试 40 个全绿（harness 单测用脚本化假 LLM + Kimi 真实链路集成测试）
[已完成] Step 12 V0.2 里程碑 🎉🎉：多 Skill 串联真实验证通过——
                  "我今晚没课的话想去打羽毛球，帮我看看什么时候合适"
                  模型自主连调 get_schedule + get_sports_resources，
                  综合两者给出建议（"今天没课随便安排；黄金时段已订完，
                  只剩 22:00 后夜场，气膜馆 12 片全空……"），还主动提出查明天。
                  至此系统真正具有 Agent 特征，不再是 API Chatbot
[已完成] Step 13 Write Skills + 用户确认流：
                  Skill 加 requiresConfirmation 标记，Harness 确认流
                  （模型提议→终端展示参数→用户输入 y→才执行；无确认回调时
                  失败关闭，拒绝结果回喂模型）；book_sports_field 预约 Skill 落地
                  （语义参数→uuid 解析、场景必须唯一匹配、按场次 payType 支付）。
                  验证码链路接超级鹰打码平台（单次约 0.01 元，自动过滑块）。
                  真实下单端到端验收通过 🎉（2026-08-30 06:00 气膜馆羽02，
                  生成待支付订单）。实测排掉四个只有真下单才暴露的问题：
                  ① drag/check 通过后须用服务端新 token 下单
                  ② formParam 须先查 brief 换 deployUuid
                  ③ 账号有未支付订单时一切新预约被拒（顺带发现用户旧抢场脚本
                     的计划任务还在跑）
                  ④ payType 须按场次 userFeeDetails.payType 数字码映射
                     {1:线上,2:线下,3:线上}，硬编码 PAY_OFFLINE 会被部分时段拒单
                  另：超级鹰识别有约半数误差率，靠"候选逐个试（6111 可续试）+
                  整链换 3 张图（6110 失效换新）"消化，实测 3 次内必过
[已完成] Step 14 Evaluation：eval/cases.json 36 条用例（单技能12/串联5/
                  不该调工具7/模糊5/写操作安全7）+ eval/runner.ts（真实 LLM +
                  罐头 skill 数据，绝不真实下单；确认流走 Harness 真逻辑）。
                  跑分：总通过率 97%（35/36），工具选择准确率 100%、参数准确率
                  100%、多余调用率 0、安全违规 0。四个指标：工具选择/参数/多余
                  调用/安全违规（安全违规一票否决）。
                  收获：评测先暴露的是自己断言/用例的问题（措辞过死、与 prompt
                  规则打架、低估读操作的合理加分），模型本身行为全部合规。
                  已知抖动：w02（模型偶尔漏问支付方式，有 PAY_TYPE_REQUIRED 兜底）
[已完成] Step 15 Read Skills 扩充：落地 3 个（get_report 成绩单 /
                  get_electricity 电费 / get_library_rooms 研讨间查询），
                  单测 12 + 真实链路集成 3 全绿，评测 single 类扩到 17 条全过。
                  实测砍掉 3 个（原因记录在案）：
                  ✗ 体测 getPhysicalExamResult：tyjx 系统有自己登录态，
                    lib 接口已失效（返回 jsp.timeout 页），需单独逆向，暂不做
                  ✗ 校园网 getNetworkBalance/getOnlineDevices：usereg 登录需
                    图形验证码，需先接打码，暂不做
                  ✗ 宿舍卫生 getDormScore：上游返回的是公示图片（base64 JPEG），
                    文本模型无法消费，等多模态（Step 20）再议
                  研讨间接口部分馆别（文图/法律馆等）持续报"操作失败"，
                  做了逐类别降级（failedKinds），北馆正常
[已完成] Step 16 图书馆预约/取消 Write Skills：落地 4 个（get_my_library_bookings
                  我的预约查询 / book_library_seat 座位预约 / book_library_room
                  研讨间预约 / cancel_library_booking 取消），全走确认流、写操作
                  匹配歧义一律拒绝（AMBIGUOUS）。单测 22 + 真链集成 2 全绿，
                  评测扩到 47 条（新增 s18/a06/w08-w11），safety 11/11。
                  ⚠ 真实订座+取消验证待做（订座系统 23:00 截止，需在白天进行）
                  实测踩坑（记录在案）：
                  ✗ bookLibrarySeat 的 status===1 才是成功（0 是失败），
                    一开始按常识写成非 0 失败，翻 thu-info-app 官方 UI 代码纠正
                  ✗ fuzzySearchLibraryId 实测只认完整学号——姓名/姓氏/学号前缀
                    全返回空，且返回的姓名是脱敏的（"董华*"），研讨间成员只收学号
                  ✗ 座位系统只能约今天/明天且按区域整段开放时段约，不能自选起止
                  ✗ 座位预约每天 23:00 截止（上游原文："系统结束预约时间为23:00"），
                    深夜的真实订座验证被挡——错误透传链路本身因此得到验证
                  ✗ 不存在"总馆"：真实馆名是 北馆(李文正馆)/西馆(逸夫馆)/文科图书馆等，
                    技能描述里的示例馆名已改成真实馆名
[已完成] 电费充值技能（Step 19 支付链路的第一块，用户提议提前做）：
                  recharge_electricity（write，确认流）——走 lib 现成的
                  getEleRechargePayCode（桌面 myhome + 支付宝通道），返回
                  https://qr.alipay.com/<payCode> 扫码付款链接。
                  关键结论：微信通道（m.myhome 微信页）在网页端无法完成支付
                  （必须回微信客户端），支付宝扫码通道完全绕开这个问题。
                  真链验证：0.01 元生成待支付订单成功（未扫码，自动过期）；
                  单测 6 个（含 500 元防手滑上限、金额非法拒绝）；
                  评测 safety 扩到 14 条（+w12/w13/w14），14/14 全过。
                  注意：余额上游仍间歇性"暂时无法查询"，与充值链路无关。
[已完成] 电费电量稳定源（用户反馈 m.myhome 微信页一直能查）：新建
                  src/client/myhome.ts（MyhomeClient）——m.myhome 接受 info
                  学号+密码直接表单登录（探针验证），绕开 lib 的 webvpn 漫游；
                  独立 cookie jar（lib 的 uFetch jar 不分域名，ASP.NET_SessionId
                  会互相顶）。get_electricity 升级为三源独立降级：
                  电量(度)/楼号/房间/抄表时间 ← m.myhome（稳），
                  缴费记录 ← lib 桌面通道（稳），金额余额 ← lib（间歇挂，null 兜底）。
                  单测 +2（m.myhome 正常/挂掉各一），真链集成 +1 全过。
[已完成] Step 17 性能优化（基准先行，eval/benchmark.ts）：
                  baseline 显示 LLM 占延迟 64~100%（无工具 4.5s / 单工具 19.1s /
                  串联 19.7s / 重查询 22.2s），据此落地四项：
                  ① LLM 流式输出（llmClient.chatStream 解析 SSE，agentLoop
                    带 onToken 走流式，假 LLM 自动回退 chat）——首字延迟可测，
                    回答逐 token 出现，不再盯空白
                  ② 单轮多 tool_call 纯读并行执行（含写操作的一轮仍串行，
                    确认顺序不乱）；串联用例工具墙钟从 7.1s → 6.3s
                  ③ ThuClient 元数据缓存（馆列表/楼层列表 24h TTL，位置级联
                    省往返；availability 不缓存）+ login 并发去重（inflight 共享）
                  ④ 启动预热登录（createAllSkills prewarm）+ 工具 start/end
                    事件暴露给调用方（CLI 显示进度与耗时，为 Web UI 铺路）
                  教训：LLM API 延迟波动极大（同问题 16.7s↔48.5s），总延迟
                  对比基本是噪声；结构性收益靠单测验证（并行/事件/回退各 1 个），
                  benchmark 的 timedLlm 包装一开始没转发 chatStream 导致 TTFB
                  测了个寂寞——包装器必须完整转发接口
[已完成] Step 18 单用户 Web UI（pnpm web → http://127.0.0.1:3457）：
                  原生 Node http（不引框架）+ 单页 HTML，只监听回环地址。
                  POST /api/chat 走 SSE：token 流式 / tool 进度 / confirm
                  确认请求 / qr 支付二维码（qrcode 包生成 data URL）；
                  POST /api/confirm 应答确认桥（5 分钟超时按拒绝）。
                  单用户并发=1（进行中返回 409）；确认桥用"构造期转发器 +
                  每轮换桥"实现（busy 互斥保证安全）。
                  前端：fetch+ReadableStream 读 SSE（EventSource 不支持 POST），
                  气泡对话/流式打字/工具进度胶囊/确认弹窗/二维码卡片，
                  深浅色自适应。服务端单测 8 个全绿（确认桥同意+拒绝、qr、
                  409、400）；真链冒烟：电费问答流式输出正常。
[已完成] Step 19 剩余支付链路（用户确认后进行）：
                  ① 体育场馆 PAY_ONLINE 支付（pay_sports_order，write，确认流）。
                    lib 里的体育支付端点全部指向已下线的旧系统 50.tsinghua.edu.cn，
                    从新系统前端 chunk 逆出用户侧支付主链路并用真实订单全链路探测
                    （下单→出支付参数→取消，不动钱，scripts/probe-sports-pay.ts）：
                    orderRecord 列表 → resv/order 详情（参数是预约 uuid，
                    不是订单 uuid——实测踩出的坑）→ trade/pay/type 渠道 →
                    trade/place/order 发起支付。关键实测结论：气膜馆唯一渠道
                    tsinghua_pc_9 返回 displayMode:"form"（自动提交到学校财务平台
                    fa-online.tsinghua.edu.cn 的 HTML 表单），不是二维码——
                    Web UI 为此加 payform SSE 事件，前端渲染"前往支付"按钮，
                    新窗口自动提交（与官方前端行为一致）。
                    列表层 orderStatus/payType 是数字码（1=待支付/线上），
                    权威状态以详情层字符串（TO_BE_PAID）为准，支付前必须复核。
                    单测 12 个（含 AMBIGUOUS/竞态取消复核/无渠道）。
                  ② 校园卡充值（recharge_campus_card，write，确认流）。
                    走 lib 的 rechargeCampusCard（微信/支付宝扫码通道）；
                    支付宝返回 alipayqr:// 深链，提取内嵌的 qr.alipay.com 链接。
                    实测发现学校硬性下限 10 元（<10 报 cardpay.inputtxamtgreater10，
                    且会把 lib 的错误解析路径搞崩成 undefined.substring）——
                    skill 内置 10~500 上下限。10 元真实链路验证通过（未扫码）。
                    单测 10 个。
                  评测 54 条（+w15~w18），53/54（w09 为已知模型措辞 flake），
                  安全违规 0；单测/集成共 149 个全绿。
                  教训：评测要串行跑——两轮评测首尾相接时 LLM API 会报
                  403 并发限制，整轮作废。
[已完成] Step 20 多模态（语音/图片/TTS/音效）：
                  ① 图片输入：harness 消息类型放宽为 OpenAI 多模态 parts
                    （ContentPart: text/image_url），agentLoop.ask 支持
                    opts.images（data URL）；webServer /api/chat 收 images
                    字段（≤4 张、每张 base64 ≤6M 字符、data URL 格式白名单
                    校验、总 body 25MB 上限），新增 GET /api/capabilities
                    供前端显隐入口；LLM_VISION=0 可关。
                    实测：k3-256k（Kimi for Coding）支持 vision——先发
                    1×1 PNG 探测返回 200 且正确识别颜色，再经 Web UI 全链路
                    验证（capabilities → 带图提问 → SSE answer 正确）。
                  ② 语音输入：浏览器 WebSpeech（zh-CN、interimResults），
                    识别结果进输入框由用户确认后发；不支持则隐藏按钮。
                  ③ TTS：顶栏 🔊 开关（localStorage 记忆），answer 事件
                    触发 speechSynthesis 朗读（优先中文语音）。
                  ④ 音效：WebAudio 振荡器合成（无音频文件），发送/工具完成/
                    工具失败/确认弹窗/错误各有提示音，顶栏 🔔 可关。
                  单测 156 个全绿（+7：多模态 parts 构造、默认提示语、
                  capabilities、图片校验四条）。
[进行中] Step 21 会话架构修复（2026-09-04 定案，现存问题：前端已多会话，
                  后端仍是单一共享 Agent——切换/新建会话不影响后端上下文，
                  跨会话串味；messages 只增不减；进程重启即失忆）：
                  ① [已完成] 会话隔离：/api/chat 带 sessionId（非法/缺省落
                    "default"），后端 Map<sessionId, Agent>（LRU 50 上限防泄漏）；
                    step18-web 的 ThuClient 提到 factory 外只建一次，所有会话
                    Agent 共享同一登录态，换会话不用重新登录；新增
                    POST /api/session/destroy（单个/all）删会话时销毁后端上下文；
                    logout 清全部；登录成功建的 Agent 落在 default 会话。
                    前端 ask 带活跃会话 id，删会话/清空历史时调 destroy。
                    单测 +4：跨会话不串味、destroy 单个、destroy all、非法 id 兜底。
                  ② 上下文裁剪：发送视图两级裁剪（不动存储本体）——
                    旧轮超长 tool 结果裁成一行摘要；超过轮数上限整轮淘汰
                    （保持 assistant.tool_calls↔tool 消息配对完整性）；
                    旧轮 base64 图片换占位文本。
                  ③ 会话持久化：messages 落 data/sessions.json（.gitignore），
                    重启恢复；恢复时换用新 systemPrompt（旧日期会过期）；
                    图片 parts 只留文字；step18-web 传存储路径，测试不落盘。
[计划中] Step 22 复活两个被砍技能（Step 15 时砍掉，前置障碍现已被扫清）：
                  ① get_dorm_score 宿舍卫生：上游返回公示图片，当时文本模型
                    无法消费；现在 vision 已通（Step 20）。Skill 保持零 LLM，
                    结果带 imagesBase64；agentLoop 在 tool 消息后追加带图
                    user 消息喂 vision 模型。
                  ② get_network_status 校园网（usereg）：当时卡图形验证码；
                    超级鹰通道已在体育预约跑通（复用）。UseregClient 独立
                    cookie jar（m.myhome 教训）：验证码图 → 识别 → 登录 →
                    余额/在线设备，识别失败换图重试 ≤3 次。
[计划中] Step 23 主动式能力（从被动应答到主动 Agent）：
                  核心设计：LLM 只负责"创建任务"（走确认流），到点执行走
                  确定性代码路径直接调 skill.execute，不再烧 LLM。
                  ① 任务模型 + 进程内 scheduler：reminder（到点提醒）/
                    monitor（条件查询如低电费）/booking（到点预约）三类，
                    JSON 文件存储重启恢复，不引任务队列。
                  ② 通知通道：前端轮询 /api/notifications + toast + 音效 +
                    浏览器 Notification API。
                  ③ 定时抢场：到点预热登录 → 直接走 bookSportsField 链路
                    （超级鹰过滑块）；执行前查未支付订单（Step 13 坑④：
                    有未支付订单时一切新预约被拒）。
[计划中] 小项（穿插在大步骤之间，不单独占步骤号）：
                  ① Token 统计：llmClient 解析 usage（流式加
                    stream_options.include_usage），SSE usage 事件，
                    前端气泡下方小字 + 会话累计；单价可配（LLM_PRICE_*，
                    元/百万 token），不配只显示 token 数。
                  ② 校历感知：.env 配学期第一周周一（SEMESTER_START），
                    system prompt 注入"X月X日 星期X · 第 N 教学周"。
                  ③ 快捷指令：输入框上方常驻常用问法胶囊，点按即发送（纯前端）。
[下一步] 远期：多用户 App（本机凭证模式）见上文；.ics 日历导出待用户单独确认
