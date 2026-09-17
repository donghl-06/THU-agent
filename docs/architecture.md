# 清灵 / THU-agent 当前架构

本文描述当前源码的实际结构；历史开发步骤与排障记录见 [ROADMAP](../ROADMAP.md)，
开发约定见 [AGENTS.md](../AGENTS.md)。工具名称、参数和确认标记以
`pnpm --silent skill list` / `describe <name>` 的运行时输出为准。

## 1. 总体设计：一套能力，多个入口

清灵既是一个可独立使用的校园 Agent，也是供其他 Agent 调用的校园工具集。
内置自然语言对话和 Web 中按提示词运行的定时任务使用本项目的 LLM；直接工具调用、
原有的提醒和定时预约不经过模型。

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
                           41 个校园原子工具       4 个任务工具（可选）
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
| `pnpm agent` | `scripts/step10-agent.ts` | 是 | 41 个校园工具：25 读、16 写；无任务调度器 | 终端展示参数，输入 `y` / `yes` |
| `pnpm web` | `scripts/web-dev.mjs` → Vite / `scripts/step18-web.ts` → `src/server/webServer.ts` | 对话及提示词定时任务需要 | 41 个校园工具 + 4 个任务工具；定时 Agent 任务管理页、状态看板 | 对话可切换访问模式；后台 Agent 写操作留待用户确认 |
| `pnpm --silent skill …` | `src/skillCli.ts` | 否 | 45 个工具；任务依赖 Web | 宿主先取得用户明确同意，再逐次传 `--confirmed-by-user` |
| `pnpm --silent mcp` | `scripts/mcp-server.ts` → `src/mcp/server.ts` | 否 | 默认 25 个校园读工具 + `thu_login` / `get_user_info` | 当前不支持写操作确认，拒绝执行写工具 |

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

服务端使用 Node.js HTTP，前端使用 React + TypeScript + Vite。`src/web/App.tsx`
组织聊天工作区，`src/web/components/` 提供侧栏、消息、输入区和弹窗，
`src/web/lib/useAssistant.ts` 管理认证与流式交互，`history.ts` 保留旧版数据迁移与跨标签页合并。
图标来自 `lucide-react`，Motion 管理入场、折叠与弹窗过渡。Markdown 按需加载，通过
React 渲染并跳过原始 HTML。`POST /api/chat` 以 SSE 返回文本、工具进度、确认请求和结果。

`reasoning {text}` 与 `token {text}` 分别转发模型的思考和正文增量；工具事件包含
`toolCallId`，用于匹配同名并行调用的开始与完成。LLM 客户端读取
`delta.reasoning_content`（以及兼容端点的 `delta.reasoning`），原字段保留在模型消息中供工具续轮使用。
`reasoning_content` 的流式与续轮规则见 [DeepSeek 官方说明](https://api-docs.deepseek.com/guides/thinking_mode/)。
未提供思考内容的模型只显示处理状态，不生成替代思考文本。

`src/web/lib/turn.ts` 按条目创建顺序维护单轮时间线，工具完成仅更新原条目。
思考段结束后自动折叠自身；`answer` 校对最终正文，`done` 才标记整轮完成并折叠之前的
思考、工具和中间正文，最终回复保持可见。过程可重新展开，随浏览器历史保存。
停止、错误及未收到 `done` 的断流保留已有内容并显示未完成状态；旧版纯文本历史仍可读取。

输入框的 Cross 入口统一选择图片和文件；支持视觉的模型将可用图片作为图片输入，图片会同时
通过上传接口保存为本机文件，供云盘上传、作业提交等工具使用，其余附件也通过上传接口提供给工具。
语音输入紧邻发送按钮，消息底部的用量与复制操作同步在悬停或键盘
聚焦时显示；触摸设备保留可见操作。

#### 操作访问模式

Cross 右侧的模式菜单提供 Hand 图标的“请求批准”和红色 ShieldAlert 图标的“完全访问”。
默认请求批准，选择保存在浏览器中并跨对话使用。`POST /api/chat` 的 `accessMode` 接受
`request-approval` 或 `full-access`，省略时默认请求批准，非法值返回 400。
每轮发送时固定该模式，生成或批准过程中不能切换；下一轮与重试使用当前选择。

`src/harness/accessMode.ts` 定义共享模式和对应的模型指令。服务端把本轮模式传入
`Agent.ask`，Agent 在发送给模型的 system 视图中附加指令，并把相同模式交给
`ToolRegistry.execute`。请求批准模式直接由系统显示写操作参数并等待批准，模型无需先
在正文中再问一次；完全访问直接执行用户指令所需的工具操作，不触发批准回调或 SSE
`confirm` 事件。此规则覆盖所有已注册的 Agent 工具和任务创建/取消，写操作仍顺序执行。
模式指令不写入对话历史，历史内容不会覆盖下一轮由界面选择的模式。

界面的删除对话、退出登录也遵循当前模式。登录和身份验证、工具参数校验、学校实际支付流程
仍由各自接口处理。CLI / MCP / 外部任务桥是独立入口，不继承浏览器的模式偏好。

`pnpm web` 启动 Vite 页面（默认 3457）与本机 API（默认 3458），通过 `/api` 同源代理
保留 Cookie、认证和确认接口；`WEB_API_PORT` 可覆盖开发 API 端口。`pnpm web:build`
生成 `build/web/`，`pnpm web:serve` 直接提供构建后的页面与 API。发行构建将 React 资源复制到
`dist/src/server/public/`，沿用桌面打包入口。服务端只公开构建资源白名单，离线缓存仅含页面壳和静态资源，不缓存 API。

Web 层还提供图形化登录与二次认证、停止生成、多会话与历史恢复、标题生成、图片输入、
支付二维码/链接/表单展示、预约日历 `.ics` 导出、Token 用量，以及任务和通知界面。
文件通过 `POST /api/upload` 上传（单文件不超过 50 MB）；文件名显示在聊天气泡，
本机路径仅随消息交给模型。邮件/学堂/云盘小图片通过 `/api/temp-image/` 显示，用户点击
删除按钮后清理本地文件。云盘视频、音频和普通文件通过 `/api/cloud-file/<token>` 受控代理，
不整包落盘，并转发 Range 请求以支持视频流式播放。普通文件渲染为与上传附件一致的
文件卡片，点击卡片会在新窗口预览；删除按钮只注销本地预览 token。
CLI/MCP 未装配图片通道时，对应图片工具返回 `NOT_SUPPORTED`；`show_cloud_file` 则降级为
云盘签发的临时直链。
生成支付订单或付款入口不等于支付成功，用户仍需完成相应支付流程。

每个聊天会话有独立的 Agent 消息数组，但同一服务实例共享清华登录态与调度器；
聊天/登录交互通过全局忙碌锁串行处理。这是**单用户、多会话**设计，不是多租户后台。
会话持久化由 Web 的 `SessionStore` 负责，Harness 仅提供快照与恢复接口。

默认端口为 `3457`。非 WSL 环境默认绑定 `127.0.0.1`；WSL 默认绑定 `0.0.0.0`，
`HOST` / `PORT` 可覆盖。绑定所有网卡不等于仅本机可访问，部署时应核对网络可达范围，
按需配置 `UI_TOKEN`，不要把这个单用户 HTTP 服务直接暴露到公网。

### Web 状态看板

`/#dashboard` 对应 `DashboardPage` 和 `useDashboard`。`src/server/dashboardSources.ts` 定义 16 项
展示映射，执行入口仍来自 `createAllSkills()`。`DashboardService` 不实例化 Agent 或调用 LLM，
仅执行白名单中的只读 Skill，并再次检查 `requiresConfirmation`；任意工具名不能通过 HTTP 传入执行。

| 接口 | 行为 |
| --- | --- |
| `GET /api/dashboard` | 返回当前快照，后台查询过期项，结果逐项可见 |
| `GET /api/dashboard?poll=1` | 只读快照，不发起新的周期查询 |
| `GET /api/dashboard?refresh=all` | 手动刷新所有项；单项可用 `refresh=card` 等展示 ID |
| `GET /api/dashboard/news?ref=…` | 仅允许读取当前资讯列表返回的原始详情标识 |

以上接口沿用 UI_TOKEN 和校园登录守卫，响应均为 `no-store`。缓存仅保存在进程内，重新登录和退出
时清空；运行时密码不落盘。看板首次查询时若有运行时／环境凭证，重新建立一次 Info 会话，避免只凭
旧 Cookie 文件误判已认证；无密码时使用已有会话，失效则提示重新连接。看板客户端不借用对话的
交互式二次认证回调。聊天／登录忙碌时不启动新查询。
前端查询中每 2 秒取快照，空闲时每 15 秒检查过期项；校园查询按各项的 2–60 分钟 TTL 触发，
手动刷新至少间隔 15 秒。隐藏页面和离开看板会取消前端请求和计时器，服务端没有常驻刷新计时器。

聚合层最多同时执行 4 个 Skill；网络学堂批次串行，复用课程缓存。每项 45 秒超时后保留旧数据，
不把异常内容返回浏览器。底层 Skill 尚不支持取消，超时请求实际结束前仍占并发槽，禁止叠加重试。
已排队的这一批查询仍可完成。空结果、不可用、错误和更新时间分开表示；已恢复数据可独立更新。
资讯正文、通知和作业文本由 React 转义，文件链接仅允许 HTTP(S)。

## 3. Skills 的两个含义

### 内部原子工具：`src/skills/`

[Skill 接口](../src/skills/base/types.ts) 定义 `name`、`description`、`inputSchema`、
`requiresConfirmation` 和 `execute(input)`。工具只负责参数校验、调用客户端、规范化结果，
返回 `{success, data?, error?}`；不包含 Prompt、模型推理、聊天状态或完整登录流程。

[createAllSkills](../src/skills/index.ts) 是统一装配入口，向 CLI、Web 和 MCP 提供同一套实现。
注入客户端、验证码求解器和调度器也使工具可以脱离网络、模型和 UI 独立测试。

- 25 个校园读工具：课表、校园卡、教室、图书馆座位/研讨间、体育资源、成绩单、
  宿舍电费、宿舍卫生、校园网状态、我的图书馆预约，以及校园资讯列表/详情、
  学堂课程/通知/作业/课件/日历/图片、邮箱列表与正文/图片，云盘资料库/目录/搜索/文件展示。
- 16 个校园写工具：体育预约、图书馆座位/研讨间预约、取消图书馆预约、电费充值、
  体育订单支付、校园卡充值、提交学堂作业、下载课件、发送邮件，云盘上传、新建文件夹、
  重命名、复制/移动、删除与生成分享链接。
- 4 个任务工具：`create_reminder`、`schedule_sports_booking`、`list_my_tasks`、
  `cancel_task`；其中仅任务查询为只读，其余均要求确认。

宿舍卫生成绩工具返回公示图片 `imagesBase64`，不是已识别的分数。
体育资源查询要求明确 `resourceName`；不要把“工具存在”理解为无参数即可遍历全校资源。

校园卡充值 `recharge_campus_card` 支持 `method: "bank"`，从校园卡系统绑定的银行卡
直接发起扣款，无需扫码；必须明确授权本次金额及银行卡通道。银行卡直充开放 10–200
整数元，保留写操作确认，未指定通道仍默认支付宝扫码。银行卡结果的
`paymentStatus: "submitted"` 只表示请求已提交，不能当作扣款或到账凭证；
异常返回 `PAYMENT_STATUS_UNKNOWN` 时应核对余额、充值记录和银行卡扣款，不自动重试
或切换付款通道。微信／支付宝结果为 `paymentStatus: "awaiting_payment"`，仍返回 `payUrl`。
本功能不包含余额阈值监控或周期性自动充值。

依赖核查（2026-09-16）：npm 官方 registry 的 `@thu-info/lib` 最新正式版仍为 3.15.2，
因此未升级，也未修改已有补丁。该版本银行卡调用不校验内层 `returncode` 且不返回
交易凭证，Agent 只报告提交状态。后续正式发布版本可更新后再验证到账判定。

### 外部 Agent Skill：`.agents/skills/thu-agent/`

这是**一个**供兼容宿主发现和加载的 Skill 包，不是 45 份独立 Skill：

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
| `src/client/cloud/CloudClient.ts` | 清华云盘（Seafile）客户端：SSO 登录、资料库/目录/搜索、文件访问链接与上传/分享等写操作 |
| `src/client/taskSkillClient.ts` | 仅供外部任务调用连接本机 Web 服务，不连接校园系统 |

SDK 的 Node.js 兼容性修复通过 `patches/` 和 pnpm patch 应用。新增能力优先复用客户端；
只有 SDK 缺失或现有链路确实不适用时才补专用适配器，不在 Harness/UI 重写校园业务。

## 5. 定时任务与外部调用链路

### Web 定时 Agent 任务

侧栏“新建对话”下方的“定时任务”进入 `/#tasks`。`TasksPage` 提供提示词任务的
创建、编辑、暂停/启用、立即运行、删除，以及可搜索和筛选的执行历史；旧有的提醒和预约也在此展示、取消。
删除任务保留历史和会话；删除一条执行记录会同时删除该次会话及后续对话。

`src/tasks/scheduledTasks.ts` 随 Web 服务监听启动，每 5 秒检查任务，使用北京时间
（Asia/Shanghai，UTC+8），支持单次、每天和每周多日计划。任务定义和执行快照保存在
`data/qingling.sqlite` 的 `scheduled-tasks` 文档中。立即运行不改变原计划，暂停不停止
已开始的执行，可在执行历史中单独停止。编辑已暂停或结束的任务后，需要显式启用。

调度与交互式登录/聊天共用执行互斥：忙时等待，错过超过 10 分钟则记录为“已错过”，
周期任务推进至下一次未来时间，不追补积压。每次执行前先持久化执行记录及下一次时间；
进程重启将未结束的记录标为“已中断”，不自动重放。单次运行上限为 10 分钟。
仍需保持本地服务运行及校园登录可用，不提供跨进程的严格一次执行保证。

`src/server/scheduledRun.ts` 通过同一 Agent 和工具集执行，强制使用 `request-approval`；
后台确认回调拒绝写操作并标记“待处理”，不会继承普通聊天的完全访问偏好。
用户进入会话继续提问后使用正常聊天确认流程。停止会中止模型等待，已发出的只读校园请求可能仍在返回。

每次运行保存独立的消息时间线、用量与模型上下文，并带有 `scheduledTaskId` / `scheduledRunId`。
执行不会改变当前选中的聊天；侧栏历史过滤任务会话，后续续聊和旧浏览器快照合并也保留归属。
会话从执行历史进入，复用正常聊天界面和上下文恢复机制。

API：`GET /api/scheduled-tasks` 返回 `{tasks, runs, busy}`；`POST /api/scheduled-tasks/`
下的 `create`、`update`、`toggle`、`delete`、`run`、`stop`、`delete-run` 分别对应管理操作。
创建/编辑接受 `{title, prompt, schedule: {frequency, time, date?, weekdays?}}`，
星期一至星期日编码为 1–7；其他操作传 `{id}`，启停计划另传 `enabled`。
这些接口要求 Web 登录；写请求要求同源 JSON。`run` 以 202 返回执行记录，页面每 2 秒刷新状态。
这一组提示词任务独立于旧任务工具，当前不经 JSON CLI 的四个任务工具暴露。

### 原有提醒、预约与外部工具

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
| Web 对话、设置与定时 Agent 任务 | `data/qingling.sqlite`；浏览器仅保留内存视图，旧 `sessions.json` 可迁移 |
| 原有提醒与预约任务 | `data/tasks.json`，由 `TaskScheduler` / `TaskStore` 管理 |

`SessionStore` 不保存 system 消息，并将多模态消息中的图片 parts 转为文本；
这不是对任意工具 JSON 字符串的全面脱敏。对话、图片、任务和会话票据都属于私有数据，
不能提交、打印到公共日志或上传为调试附件。`data/` 与真实 `.env` 已被 Git 忽略。

`requiresConfirmation` 是工具契约，确认由各入口执行，不是 `execute()` 自带的权限沙箱。
`--confirmed-by-user` 代表宿主已取得本次同意，CLI 无法验证对话本身；新增入口必须自己
实施确认边界。Web / Harness 允许宿主显式选择本轮完全访问；未选择完全访问且没有确认
通道时拒绝写操作，不把“调用成功”误报为“预约/支付最终成功”。

修改时先验证原子工具，再验证 Harness/入口适配；不要为不同入口复制工具清单与业务逻辑。
离线检查可使用：

```bash
pnpm typecheck
pnpm exec vitest run tests/skills tests/harness tests/server tests/tasks tests/client tests/mcp
```

`pnpm test` 还会运行访问真实校园服务的集成测试，需有意选择；任何验证都不能擅自预约、
取消、充值或支付。服务 API 细节保留在 [体育接口笔记](sports-api-notes.md)，
历史实验与当时的验证状态保留在 [ROADMAP](../ROADMAP.md)，不视为当前运行保证。
