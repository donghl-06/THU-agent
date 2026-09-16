# THU Assistant Agent（清灵 Agent）

面向清华大学校园生活场景的 LLM Agent 项目（开发中）。

用户用自然语言描述需求（如"我今晚没课的话想打羽毛球，帮我看看什么时候合适"），
Agent 自主判断并组合多个校园能力（查课表 → 推理空闲时间 → 查体育场馆 → 综合建议），
而不是把已有 App 换成聊天界面。

> 当前入口、能力边界与数据流见 [项目架构](docs/architecture.md)，
> 开发约定见 [AGENTS.md](AGENTS.md)。[ROADMAP.md](ROADMAP.md) 仅保留历史开发与排障记录。

## 架构分层

```text
交互式 CLI / Web 聊天 ── Harness ↔ OpenAI 兼容 LLM ──┐
外部 Agent ── Agent Skill + JSON CLI / MCP ─────────┤
                                                   ▼
                                        createAllSkills() 统一装配
                                          │                │
                                     校园原子工具       可选任务工具
                                          │                │
                             ThuClient / SportsClient   Web 常驻调度器
                              / MyhomeClient / UseregClient
                              / LearnClient / MailClient
                                          │
                                  SDK / 校园系统接口
```

交互式 CLI 提供 31 个校园工具；Web 与外部 Skill CLI 提供 35 个工具（含 4 个任务工具）。
外部 CLI 的任务调用转交常驻 Web 服务。MCP 默认提供 21 个校园只读工具和 2 个登录/用户信息工具，
不支持写操作或任务调度。各入口复用业务实现，不自动共享跨进程的登录会话。

## 环境要求

- Windows + WSL2 Ubuntu（或任意 Linux/macOS）
- Node.js ≥ 22.13（Web 数据库使用内置 `node:sqlite`）
- pnpm 10（`npm install -g pnpm`）
- 清华大学 Info 账号（用于登录校园服务）
- 使用内置 CLI / Web 自然语言对话时，需配置 OpenAI 兼容的 LLM API；直接 Skill / MCP 调用不需要

## 配置步骤

```bash
# 1. 克隆本仓库
git clone git@github.com:donghl-06/THU-agent.git
cd THU-agent

# 2. 安装依赖（会自动应用 patches/ 里对 @thu-info/lib 的补丁）
pnpm install

# 3. 配置凭证
cp .env.example .env
# 编辑 .env，填入：
#   THU_USERNAME    学号
#   THU_PASSWORD    密码
#   THU_FINGERPRINT 设备指纹（可选，推荐留空；清灵会自动保存在本机）
#   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL  LLM 配置（Kimi 示例见 .env.example 注释）
```

## 命令行对话

```bash
pnpm agent   # 31 个校园查询/操作工具，写操作须在终端确认；不包含定时任务
```

试试这些问法：

```text
我今天下午有什么课？
现在图书馆还有座位吗？
今晚气膜馆羽毛球还有场吗？
最近有什么重要的校园通知或资讯？
```

## 供任意 AI Agent 调用

仓库内置了一个遵循 Agent Skills 目录结构的项目级 Skill：
`.agents/skills/thu-agent/SKILL.md`。兼容 Agent Skills 且能运行本地命令的
AI Agent 可以自动发现它，并通过机器可读 CLI 使用 `createAllSkills()` 中装配的
校园能力，不需要接入本项目自己的 LLM。目前包含 31 个直接调用的校园能力，以及
通过常驻 Web 调度器执行的 4 个任务能力（提醒、定时抢场、任务查询与取消）。

也可以直接检查这层接口：

```bash
pnpm --silent skill list
pnpm --silent skill describe get_schedule
pnpm --silent skill call get_schedule --input '{}'
```

输出统一为 JSON。直接校园调用需要 `THU_USERNAME` / `THU_PASSWORD`，
`THU_FINGERPRINT` 可留空使用自动持久化的设备身份；不需要 `LLM_*` 配置。
校园网状态查询另需 `CJY_*` 识别验证码。宿舍卫生成绩返回公示图，可使用 Skill 中的
`scripts/extract-images.mjs` 解码成私有临时图片，再由调用方的看图能力读取。
所有 `requiresConfirmation: true` 的预约、取消、充值、支付、作业提交、下载和发信操作默认拒绝执行；
外部 Agent 必须先向用户展示完整操作参数并取得本次明确同意，之后才能为该次调用
附加 `--confirmed-by-user`。确认不能跨调用复用，失败或结果不明确时也不能自动重试。

任务调用复用已运行的 `pnpm web` 服务：在服务和 CLI 使用的 `.env` 配置相同的
非空 `UI_TOKEN`，并在 Web 页面完成登录。默认连接 `http://127.0.0.1:3457`
（或 `PORT` 指定端口）；`THU_SKILL_SERVER_URL` 可覆盖为另一个本机回环 HTTP 地址。
`POST /api/skills/tasks` 仅接受本机、无浏览器 Origin、携带正确 Bearer 口令且已登录的请求，
只开放任务能力，并在服务端再次检查写操作确认。

任务由 Web 服务持久化和执行，通知回写到 `external_skill` 会话；必须保持服务运行至执行时间。
`list_my_tasks` 的 `includeFinished` 参数可查询已完成/取消任务及执行结果：

```bash
pnpm --silent skill call list_my_tasks --input '{"includeFinished":true}'
```

定时抢场在创建时确认具体目标、执行时间和支付方式，到点无需再次确认；返回 `taskId`
只表示登记成功。详细运行条件见 [Skill 运行说明](.agents/skills/thu-agent/references/runtime.md)。

⚠️ `.env` 已在 `.gitignore` 中，**绝不要**把真实凭证写进 `.env.example` 或任何会被提交的文件。

## 验证

按顺序运行（首次登录会要求二次认证，通过后设备被信任，之后不再需要）：

```bash
pnpm step1   # InfoHelper 实例化（不联网）
pnpm step2   # 真实登录 + 获取用户信息
pnpm step3   # 获取真实课表
pnpm learn   # 网络学堂真链验证（课程/通知/作业/课件/日历）
```

### 网络学堂（learn.tsinghua.edu.cn）

清灵已接入网络学堂（复用同一账号与信任设备，无需二次登录）：

- `get_learn_courses` / `get_learn_notices` / `get_learn_homework` / `get_learn_files` / `get_learn_calendar`：
  查课程、通知、作业（含截止时间与成绩）、课件列表、学堂日历 + 作业截止聚合；
- `submit_learn_homework`：把本地 PDF 等文件提交到指定作业（写操作，需用户在确认弹窗同意）；
- `download_learn_file`：把课件下载到本地目录（写操作，需确认）。

可以试试：「我有什么作业要交？」「数据结构最近有什么通知？」
「帮我把桌面上的 hw3.pdf 交到数据结构的第三次作业」。

### Web UI 图形化登录

运行 `pnpm web` 后打开 <http://127.0.0.1:3457>，点击左下角“连接清华账号”，
即可在页面输入清华 Info 学号和密码。需要二次认证时，页面会弹出 TOTP、短信或微信
认证方式选择，并在同一窗口输入验证码；登录凭证传给本地后端，不会写入浏览器本地存储。
Web UI 登录成功后才会开放校园 Skill 查询。

Web 前端使用 **React + TypeScript + Vite**，界面组件位于 `src/web/components/`，
应用状态、SSE 与历史迁移位于 `src/web/lib/`，样式统一在 `src/web/styles.css`。
图标使用 `lucide-react`，过渡动效使用 Motion，并尊重系统的减少动态效果设置。

- `pnpm web`：启动 Vite 热更新页面（默认 3457）和本机 API（默认 3458）。
- `pnpm web:build`：构建到 `build/web/`。
- `pnpm web:serve`：提供已构建页面和 API（默认 3457，无热更新）。
- `pnpm build`：构建 React 前端和现有桌面发行包资源。
- `pnpm test:web`：使用离线模拟服务运行 Playwright 浏览器回归，不连接校园服务。
  首次运行先执行 `pnpm exec playwright install chromium`。

开发时 `PORT` 控制页面端口，`WEB_API_PORT` 控制 API 端口；API 通过 Vite 同源代理访问。
聊天历史（包括思考、工具时序、用量和已发送图片）、模型上下文、上传附件、账号展示信息及
主题/声音/访问模式/侧栏偏好统一保存在后端 `data/qingling.sqlite`。文件权限为 `0600`；
上传附件同时在 `data/uploads/` 生成供校园工具使用的文件副本。密码、验证码不写入工作区数据库。
浏览器只保留当前页面的内存视图，不再使用 localStorage、sessionStorage 或 IndexedDB 保存应用数据。
升级时登录一次，页面会把旧浏览器历史导入数据库，确认成功后清除原记录；旧后端
`data/sessions.json` 自动迁移一次。静态离线缓存只包含界面资源，不缓存工作区 API 数据。
数据库属于此本地单用户服务；同一服务的新浏览器也能恢复历史和偏好。备份前停止服务，再复制数据库。
静态资源与离线壳一起打包，无需 CDN。界面截图见 [Web UI 截图](docs/web-ui.md)。

非 WSL 环境默认监听 `127.0.0.1`，WSL 默认监听 `0.0.0.0`，可通过 `HOST` / `PORT` 覆盖。
WSL 或自行开放其他网卡时不能假定仅本机可访问，应核对网络范围并配置 `UI_TOKEN`；
不要将单用户 HTTP 服务直接暴露到公网。

Web UI 启动脚本会自动配置旧版 TLS 所需的 `OPENSSL_CONF`，PowerShell 下无需手动设置。

使用图形化登录时，`THU_USERNAME`、`THU_PASSWORD` 和 `THU_FINGERPRINT` 可以留空；
它们仍可用于 `pnpm step2`、`pnpm step3` 等命令行验证脚本。清灵会把设备指纹保存到
`%LOCALAPPDATA%/QingLing/device.json`（macOS/Linux 使用系统状态目录），Web、EXE 与 MCP
在同一台电脑上复用同一个信任设备。

### Windows 便携版

开发者可在 Windows 且已安装 Node.js 和 pnpm 的电脑上运行：

```bash
pnpm package:win:exe
```

命令会在 `release/清灵-EXE/` 生成网页聊天发布目录，内置 Node.js 和生产依赖，用户无需安装
Node.js、pnpm 或 Git。将 `.env.example` 复制为同目录下的 `.env` 并填写 `LLM_API_KEY`
等模型配置后，双击 `清灵.exe` 即可自动启动本地服务并打开浏览器。程序退出入口位于
Windows 任务栏托盘图标的右键菜单中。再次双击 `清灵.exe` 不会启动第二个后台实例，
只会打开已运行实例的页面。

打包脚本会优先生成带托盘菜单的启动器：安装 .NET 8 SDK 时使用自包含 .NET 8 版本；
没有 SDK 的 Windows 打包机则使用系统自带的 .NET Framework 4.x 编译器。只有在极旧的
Windows 环境找不到上述编译器时，才会退回 Node.js SEA 启动器。无论采用哪条路径，
普通用户都不需要安装 .NET 或 Node.js。

### Codex MCP 独立连接包

如果用户已经安装 Codex、Claude Desktop 等 MCP Agent，不需要下载网页聊天 EXE，直接运行：

```bash
pnpm package:win:mcp
```

命令会在 `release/清灵-MCP/` 生成独立连接包，只包含 MCP 服务、内置 Node.js
运行时和配置模板。用户将 `.env.example` 复制为 `.env`，填写清华账号配置，再按照
`docs/codex-mcp.md` 注册到已有 Agent 即可。两个发布包互不依赖，用户按使用场景选择一个下载。

需要同时生成两个发布包时，开发者可运行 `pnpm package:win:all`；发布到 GitHub Release
时分别压缩并上传 `release/清灵-EXE/` 和 `release/清灵-MCP/`。

### 自动打包（GitHub Actions）

仓库内置了云打包流水线（`.github/workflows/release.yml`）：无需本机装任何环境，
由 GitHub 的云机器自动打出四个便携包——

| 产物 | 云机器 | 说明 |
| --- | --- | --- |
| `QingLing-macOS-arm64` | macOS（M 系列芯片） | Apple Silicon 原生 |
| `QingLing-macOS-x64` | macOS（运行时换官方 Intel 版 Node） | Intel Mac 原生 |
| `QingLing-Windows-EXE` | Windows | 网页聊天 EXE 包 |
| `QingLing-Windows-MCP` | Windows | Codex / Claude Desktop 等 Agent 的 MCP 连接包 |

**触发方式（二选一）**：

1. **发版本（推荐）**：创建尚未使用的 `v` 前缀版本标签并推送（版本与 `package.json` 对齐）——
   四个包并行打出后自动压缩，发布到仓库的 **Releases** 页面（永久保留，任何人可下载）；
2. **手动试跑**：GitHub 仓库页 → Actions → 选"发布便携包" → Run workflow——
   只出产物（Artifacts，保留 90 天，需登录 GitHub 下载），不发布 Release。

macOS 包的芯片适配：arm64 包给 M 系列 Mac；x64 包给 Intel Mac（构建后运行时
替换为官方同版本 Intel 版 Node，两种芯片各自原生运行，无需 Rosetta）。

其他命令：

```bash
pnpm agent       # 命令行对话 Agent（需要 LLM_* 配置）
pnpm dev         # 项目入口（当前为占位）
pnpm test        # 全部测试（Skill + Harness 单测 + 真实链路集成测试）
pnpm typecheck   # TypeScript 类型检查
pnpm --silent mcp # 以 MCP stdio 模式启动，供 Codex 调用校园 Skill
```

### Codex MCP 模式

项目同时提供本地 MCP Server，可让 Codex 直接调用清华校园查询 Skill。MCP Server 不替代现有 Web/EXE 模式：Codex 负责理解和规划，服务器复用 `src/skills/` 与 `src/client/`；预约、取消、充值等写操作在 MCP 模式下默认拒绝，继续使用 Web/EXE 的确认界面完成。

详细配置步骤见 [docs/codex-mcp.md](docs/codex-mcp.md)。开发者构建后的 MCP 入口为 `dist/scripts/mcp-server.cjs`，普通用户应直接下载 `清灵-MCP` 发布包。MCP 模式同样支持查询校园动态/资讯详情。

## 注意事项

- **openssl.cnf**：清华服务器使用旧版 TLS 重协商，Node 17+ 默认拒绝连接，
  因此涉及网络请求的脚本都需要 `OPENSSL_CONF` 环境变量（已内置在 package.json 脚本中）。
- **patches/**：npm 版 `@thu-info/lib@3.15.2` 在 Node 环境存在重定向链 Cookie 丢失、
  重定向次数上限不足等问题，上游仓库（3.16.4）已修复但未发布。
  本仓库通过 pnpm patch 移植了这些修复，重装依赖时自动应用。
- **设备信任**：登录会向你的清华账号登记一个名为 `QingLing Desktop` 的信任设备
  （官方 App 同款机制）。设备指纹保存在本机并跨启动复用；历史测试产生的旧设备
  可到 <https://id.tsinghua.edu.cn/> 的「多因子认证」管理页面手动删除。
- **调试脚本**：`pnpm debug:csrf` / `pnpm debug:roam` / `pnpm debug:chain`
  用于诊断登录/漫游链路问题。
- **体育场馆**：旧系统 50.tsinghua.edu.cn 已于 2026-08 整体下线。
  本项目直接对接新系统 <https://www.sports.tsinghua.edu.cn/venue/>（公网直连，
  无需 webvpn），登录链路与接口逆向笔记见 [docs/sports-api-notes.md](docs/sports-api-notes.md)。
  注意新系统 API 必须带 `x-api-version: 2.0.0` 请求头，且按房间维度查询，
  否则会拿到"场馆未开放"的假数据。
- **参考仓库**：开发参考 <https://github.com/thu-info-community/thu-info-app>
  （克隆到 `reference/` 目录，只读，不进 git）。

## 许可

- 本项目目前为个人学习项目，暂未指定开源许可。
- 核心依赖 [`@thu-info/lib`](https://www.npmjs.com/package/@thu-info/lib)
  采用 **Business Source License 1.1 (BSL)**，本项目对其的使用与补丁
  （`patches/` 目录）受其约束，如需分发请先阅读该许可条款。
- 清华账号凭证属于敏感个人信息，本项目代码不包含、也不要求提交任何真实凭证。
