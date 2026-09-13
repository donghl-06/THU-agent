# 清灵 / THU-agent 当前架构

本文描述当前源码的实际结构；历史开发步骤与排障记录见 [ROADMAP](../ROADMAP.md)，
开发约定见 [AGENTS.md](../AGENTS.md)。工具名称、参数和确认标记以
`pnpm --silent skill list` / `describe <name>` 的运行时输出为准。

## 1. 总体设计：一套能力，多个入口

清灵既是一个可独立使用的校园 Agent，也是供其他 Agent 调用的校园工具集。
只有内置自然语言对话需要本项目的 LLM；直接工具调用和定时任务执行不经过模型。

```text
终端用户 ── pnpm agent ───────────────────────┐
浏览器 / 桌面启动器 ── Web HTTP + SSE ────────┤
                                             ▼
                                  Harness ↔ OpenAI 兼容 LLM
                                             │
外部 Agent ── 项目级 Agent Skill ── JSON CLI ──┤
外部 Agent ── MCP stdio（默认只读）────────────┤
                                             ▼
                                  createAllSkills() 统一装配
                                    │                  │
                           18 个校园原子工具       4 个任务工具（可选）
                                    │                  │
                              领域客户端       Web 常驻 TaskScheduler
                                    │                  │
                              清华校园服务      到点直接调用工具 / 通知
```

JSON CLI 的任务调用通过本机 HTTP 桥接到已运行的 Web 服务；它不创建自己的调度器。
以上共享的是代码与工具契约，不表示不同进程自动共享登录 Cookie。

## 2. 入口与能力边界

| 入口 | 实现 | 使用本项目 LLM | 当前能力 | 写操作确认 |
| --- | --- | --- | --- | --- |
| `pnpm agent` | `scripts/step10-agent.ts` | 是 | 18 个校园工具：11 读、7 写；无任务调度器 | 终端展示参数，输入 `y` / `yes` |
| `pnpm web` | `scripts/step18-web.ts` → `src/server/webServer.ts` | 对话需要；任务执行不需要 | 18 个校园工具 + 4 个任务工具 | 浏览器确认交互 |
| `pnpm --silent skill …` | `src/skillCli.ts` | 否 | 22 个工具；任务依赖 Web | 宿主先取得用户明确同意，再逐次传 `--confirmed-by-user` |
| `pnpm --silent mcp` | `scripts/mcp-server.ts` → `src/mcp/server.ts` | 否 | 默认 11 个校园读工具 + `thu_login` / `get_user_info` | 当前不支持写操作确认，拒绝执行写工具 |

`pnpm dev` 的 `src/index.ts` 仍是提示入口，不是 Agent 或 Web 启动命令。
Windows EXE / macOS 应用封装的是同一套本地 Web 服务及启动、托盘、通知能力，
并不是另一个后端。独立 MCP 发布包只提供 MCP 通道。

### CLI：人机对话与机器接口分开

交互式 CLI 使用 readline 收集自然语言，由 Harness 调模型、选择工具，流式打印回答和
工具耗时。对话保存在当前进程内存中，没有装配 Web 的会话存储和任务调度器。

机器 CLI 提供 `list`、`describe`、`call`：前两者只读工具定义，不登录校园服务；
`call` 校验命令输入与确认标记后分发给工具。标准输出是一份 `SkillResult` JSON，
退出码为 `0` 成功、`1` 工具失败或拒绝执行、`2` 命令/输入错误。

```bash
pnpm --silent skill list
pnpm --silent skill describe get_sports_resources
pnpm --silent skill describe schedule_sports_booking
```

### Web：对话适配层与常驻任务宿主

服务端使用 Node.js HTTP，前端主体是 `src/server/public/index.html` 中的原生
HTML/CSS/JavaScript；`POST /api/chat` 以 SSE 返回文本、工具进度、确认请求和结果。

Web 层还提供图形化登录与二次认证、停止生成、多会话与历史恢复、标题生成、图片输入、
支付二维码/链接/表单展示、预约日历 `.ics` 导出、Token 用量，以及任务和通知界面。
生成支付订单或付款入口不等于支付成功，用户仍需完成相应支付流程。

每个聊天会话有独立的 Agent 消息数组，但同一服务实例共享清华登录态与调度器；
聊天/登录交互通过全局忙碌锁串行处理。这是**单用户、多会话**设计，不是多租户后台。
会话持久化由 Web 的 `SessionStore` 负责，Harness 仅提供快照与恢复接口。

默认端口为 `3457`。非 WSL 环境默认绑定 `127.0.0.1`；WSL 默认绑定 `0.0.0.0`，
`HOST` / `PORT` 可覆盖。绑定所有网卡不等于仅本机可访问，部署时应核对网络可达范围，
按需配置 `UI_TOKEN`，不要把这个单用户 HTTP 服务直接暴露到公网。

## 3. Skills 的两个含义

### 内部原子工具：`src/skills/`

[Skill 接口](../src/skills/base/types.ts) 定义 `name`、`description`、`inputSchema`、
`requiresConfirmation` 和 `execute(input)`。工具只负责参数校验、调用客户端、规范化结果，
返回 `{success, data?, error?}`；不包含 Prompt、模型推理、聊天状态或完整登录流程。

[createAllSkills](../src/skills/index.ts) 是统一装配入口，向 CLI、Web 和 MCP 提供同一套实现。
注入客户端、验证码求解器和调度器也使工具可以脱离网络、模型和 UI 独立测试。

- 11 个校园读工具：课表、校园卡、教室、图书馆座位/研讨间、体育资源、成绩单、
  宿舍电费、宿舍卫生、校园网状态、我的图书馆预约。
- 7 个校园写工具：体育预约、图书馆座位/研讨间预约、取消图书馆预约、电费充值、
  体育订单支付、校园卡充值。
- 4 个任务工具：`create_reminder`、`schedule_sports_booking`、`list_my_tasks`、
  `cancel_task`；其中仅任务查询为只读，其余均要求确认。

宿舍卫生成绩工具返回公示图片 `imagesBase64`，不是已识别的分数。
体育资源查询要求明确 `resourceName`；不要把“工具存在”理解为无参数即可遍历全校资源。

### 外部 Agent Skill：`.agents/skills/thu-agent/`

这是**一个**供兼容宿主发现和加载的 Skill 包，不是 22 份独立 Skill：

- `SKILL.md`：触发场景、工具发现流程、逐次确认和敏感数据处理规则。
- `scripts/thu-agent.mjs`：从任意工作目录定位本仓库，再启动机器 CLI。
- `scripts/extract-images.mjs`：校验工具返回图片，将其解码为私有临时文件，供宿主看图。
- `references/runtime.md`：凭证、任务服务、调用示例及故障处理。
- `agents/openai.yaml`：兼容宿主的展示元数据；业务调用本身不绑定 OpenAI 模型。

外部 Agent 负责理解用户与规划，清灵只执行结构化能力，因此无需再配置清灵的 `LLM_*`。
宿主必须支持读取 Skill 指令并执行本地命令，或使用已连接的 MCP；只有纯聊天能力的
模型不能直接运行它。当前脚本依赖完整仓库和已安装的 Node.js / pnpm 依赖，
单独复制 Skill 文件夹不是独立分发包。详见 [Skill 运行说明](../.agents/skills/thu-agent/references/runtime.md)。

MCP 是另一种协议适配，不是 Agent Skill 本身。当前 MCP 不装配任务工具；
`THU_MCP_INCLUDE_WRITE_TOOLS=1` 只改变工具列表，不会解除写操作执行限制。
连接方式见 [MCP 说明](codex-mcp.md)。

## 4. 共享的 Harness 与客户端

[Harness](../src/harness/agentLoop.ts) 使用 OpenAI 兼容的 Chat Completions 协议完成
“用户消息 → 模型 → 工具调用 → 结果回填 → 模型回答”闭环。它负责工具路由、确认、
流式事件、取消、上下文发送视图裁剪和 Token 统计；一轮问题最多执行 10 轮工具调用。
同一轮纯读工具可以并行；包含写工具时顺序执行，避免确认和操作顺序交错。
图片是否交给模型还取决于 `LLM_VISION` 与所选模型能力。

客户端并不是 `ThuClient → SportsClient → SDK` 的串联关系，而是按校园系统分开的适配器：

| 客户端 | 职责 |
| --- | --- |
| `src/client/ThuClient.ts` | 封装 `@thu-info/lib`，管理 Info 登录、二次认证、缓存及错误归一化 |
| `src/client/sports/SportsClient.ts` | 独立对接新版体育系统，处理资源、预约和支付接口 |
| `src/client/myhome.ts` | 使用独立 Cookie 会话读取宿舍电量，补充 SDK 电费数据 |
| `src/client/usereg.ts` | 校园网自助服务，独立 Cookie 会话、RSA 登录与字符验证码；登录名从 Info 的 `emailName` 获取 |
| `src/client/taskSkillClient.ts` | 仅供外部任务调用连接本机 Web 服务，不连接校园系统 |

SDK 的 Node.js 兼容性修复通过 `patches/` 和 pnpm patch 应用。新增能力优先复用客户端；
只有 SDK 缺失或现有链路确实不适用时才补专用适配器，不在 Harness/UI 重写校园业务。

## 5. 定时任务与外部调用链路

`TaskScheduler` 随 `pnpm web` 启动，每 30 秒检查任务；`TaskStore` 将状态保存到
`data/tasks.json`。提醒/抢场在创建时确认；到点直接执行确定性代码，不再次调用 LLM，
也不再次弹出确认。抢场创建时必须明确目标、执行时间与支付方式。

机器 CLI 的调用路径是：

```text
宿主取得本次确认 → JSON CLI 确认闸门 → taskSkillClient
  → POST /api/skills/tasks → 服务端校验 → 共享 TaskScheduler / TaskStore
  → 到点执行 → NotificationHub → Web 通知与 external_skill 会话结果
```

任务桥接要求 CLI 与 Web 使用相同的非空 `UI_TOKEN`、Web 已登录；仅接受本机回环来源、
无浏览器 Origin、正确 Bearer 口令的请求。服务端只允许 4 个任务工具，并再次检查写确认。
默认连接 `http://127.0.0.1:3457`（或 `PORT`）；`THU_SKILL_SERVER_URL` 只允许回环 HTTP 地址。

这是单进程轮询，不是后台云服务或高精度抢场系统：必须保持 Web 服务及电脑运行，
并确保执行时对应校园服务能认证。持久化 Info Cookie 不等于持久化体育登录凭证；
服务重启后需要时应重新在 Web 登录。抢场迟到超过 10 分钟会跳过；
进程内会防止同一任务重叠执行，但没有跨进程、跨崩溃的严格一次执行保证。
返回 `taskId` 只表示登记成功，最终结果应通过 `list_my_tasks` 的 `includeFinished` 查询。
取消任务不能撤销已经开始或完成的校园预约；结果不明确时先查状态，不能盲目重试。

底层保留 `monitor` 任务类型与低电量检查执行器，但当前没有对外注册创建监控的工具，
不能据此宣称 Agent 已有完整的自动低电量监控入口。

## 6. 状态、凭证与维护边界

| 状态 | 当前保存位置与边界 |
| --- | --- |
| 命令行/MCP 凭证、模型配置 | 被忽略的 `.env`；直接工具调用不要求 `LLM_*` |
| Web 登录凭证 | 登录界面传给本地后端的运行时凭证，不自动写入 CLI 的 `.env` |
| 稳定设备指纹 | 系统状态目录中的 `QingLing/device.json`，可用 `QINGLING_DEVICE_FILE` 覆盖；共享的是设备身份，不是 Cookie |
| Web Info 会话票据 | `data/auth.json`，私有权限保存，退出登录时清理；恢复快照不代表票据仍有效 |
| Web 对话与任务 | `data/sessions.json` / `data/tasks.json`；浏览器另有本地会话展示缓存 |

`SessionStore` 不保存 system 消息，并将多模态消息中的图片 parts 转为文本；
这不是对任意工具 JSON 字符串的全面脱敏。对话、图片、任务和会话票据都属于私有数据，
不能提交、打印到公共日志或上传为调试附件。`data/` 与真实 `.env` 已被 Git 忽略。

`requiresConfirmation` 是工具契约，确认由各入口执行，不是 `execute()` 自带的权限沙箱。
`--confirmed-by-user` 代表宿主已取得本次同意，CLI 无法验证对话本身；新增入口必须自己
实施确认边界。没有确认通道时拒绝写操作，不把“调用成功”误报为“预约/支付最终成功”。

修改时先验证原子工具，再验证 Harness/入口适配；不要为不同入口复制工具清单与业务逻辑。
离线检查可使用：

```bash
pnpm typecheck
pnpm exec vitest run tests/skills tests/harness tests/server tests/tasks tests/client tests/mcp
```

`pnpm test` 还会运行访问真实校园服务的集成测试，需有意选择；任何验证都不能擅自预约、
取消、充值或支付。服务 API 细节保留在 [体育接口笔记](sports-api-notes.md)，
历史实验与当时的验证状态保留在 [ROADMAP](../ROADMAP.md)，不视为当前运行保证。
