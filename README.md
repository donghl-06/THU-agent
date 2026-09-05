# THU Assistant Agent（清灵 Agent）

面向清华大学校园生活场景的 LLM Agent 项目（开发中）。

用户用自然语言描述需求（如"我今晚没课的话想打羽毛球，帮我看看什么时候合适"），
Agent 自主判断并组合多个校园能力（查课表 → 推理空闲时间 → 查体育场馆 → 综合建议），
而不是把已有 App 换成聊天界面。

> 详细架构原则见 [plan4ai.md](plan4ai.md)，阶段规划见 [plan4me.md](plan4me.md)，
> 新手向落地路线图见 [ROADMAP.md](ROADMAP.md)。

## 架构分层

```text
LLM（Kimi/GLM/DeepSeek，OpenAI 兼容协议）← 推理与决策
Harness             ← Agent 运行时：工具注册、Agent Loop（src/harness/）
THU Skills          ← Agent 可调用的原子能力（src/skills/）
ThuClient           ← 统一封装登录/会话/重试（src/client/）
SportsClient        ← 新版体育场馆系统客户端（src/client/sports/，独立链路）
@thu-info/lib       ← 清华校园服务 SDK（npm 依赖 + 本地补丁）
```

## 环境要求

- Windows + WSL2 Ubuntu（或任意 Linux/macOS）
- Node.js ≥ 22
- pnpm 10（`npm install -g pnpm`）
- 清华大学 Info 账号（用于登录校园服务）
- 任意 OpenAI 兼容的 LLM API Key（Kimi / GLM / DeepSeek 均可）

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
#   THU_FINGERPRINT 设备指纹（32 位 hex，可用以下命令生成）
node -e "console.log(require('crypto').randomUUID().replace(/-/g,''))"
#   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL  LLM 配置（Kimi 示例见 .env.example 注释）
```

## 和小助手对话（V0.1 里程碑 🎉）

```bash
pnpm agent   # 命令行 Agent：注册全部 5 个查询技能，模型自主决定调哪个
```

试试这些问法：

```text
我今天下午有什么课？
现在图书馆还有座位吗？
今晚气膜馆羽毛球还有场吗？
```

⚠️ `.env` 已在 `.gitignore` 中，**绝不要**把真实凭证写进 `.env.example` 或任何会被提交的文件。

## 验证

按顺序运行（首次登录会要求二次认证，通过后设备被信任，之后不再需要）：

```bash
pnpm step1   # InfoHelper 实例化（不联网）
pnpm step2   # 真实登录 + 获取用户信息
pnpm step3   # 获取真实课表
```

### Web UI 图形化登录

运行 `pnpm web` 后打开 <http://127.0.0.1:3457>，点击右上角“登录”，
即可在页面输入清华 Info 学号和密码。需要二次认证时，页面会弹出 TOTP、短信或微信
认证方式选择，并在同一窗口输入验证码；凭证只通过本机回环地址传给后端，不会写入
浏览器本地存储。Web UI 登录成功后才会开放校园 Skill 查询。

Web UI 启动脚本会自动配置旧版 TLS 所需的 `OPENSSL_CONF`，PowerShell 下无需手动设置。

使用图形化登录时，`THU_USERNAME`、`THU_PASSWORD` 和 `THU_FINGERPRINT` 可以留空；
它们仍可用于 `pnpm step2`、`pnpm step3` 等命令行验证脚本。每次 Web UI 进程重启后需
重新登录，除非你自行在 `.env` 配置固定指纹并由清华认证系统信任该设备。

### Windows 便携版

开发者可在 Windows 且已安装 Node.js 和 pnpm 的电脑上运行：

```bash
pnpm package:win:exe
```

命令会在 `release/清灵-EXE/` 生成网页聊天发布目录，内置 Node.js 和生产依赖，用户无需安装
Node.js、pnpm 或 Git。将 `.env.example` 复制为同目录下的 `.env` 并填写 `LLM_API_KEY`
等模型配置后，双击 `清灵.exe` 即可自动启动本地服务并打开浏览器。程序退出入口
使用 .NET 8 SDK 打包时，程序退出入口位于 Windows 任务栏托盘图标的右键菜单中。

如果打包机额外安装了 .NET 8 SDK，脚本会优先生成带托盘菜单的启动器；没有 SDK 时会
自动使用 Node.js SEA 生成启动 EXE；该备用启动器不提供托盘菜单，退出时可在任务管理器
中结束“清灵”目录下的 Node.js 进程。无论采用哪条路径，普通用户都不需要安装
.NET 或 Node.js。

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
由 GitHub 的云机器自动打出三个便携包——

| 产物 | 云机器 | 说明 |
| --- | --- | --- |
| `QingLing-macOS-arm64` | macOS（M 系列芯片） | Apple Silicon 原生 |
| `QingLing-macOS-x64` | macOS（运行时换官方 Intel 版 Node） | Intel Mac 原生 |
| `QingLing-Windows-EXE` | Windows | 网页聊天 EXE 包 |

**触发方式（二选一）**：

1. **发版本（推荐）**：本地执行 `git tag v0.2.0 && git push origin v0.2.0`——
   三个包并行打出后自动压缩，发布到仓库的 **Releases** 页面（永久保留，任何人可下载）；
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

详细配置步骤见 [docs/codex-mcp.md](docs/codex-mcp.md)。开发者构建后的 MCP 入口为 `dist/scripts/mcp-server.cjs`，普通用户应直接下载 `清灵-MCP` 发布包。

## 注意事项

- **openssl.cnf**：清华服务器使用旧版 TLS 重协商，Node 17+ 默认拒绝连接，
  因此涉及网络请求的脚本都需要 `OPENSSL_CONF` 环境变量（已内置在 package.json 脚本中）。
- **patches/**：npm 版 `@thu-info/lib@3.15.2` 在 Node 环境存在重定向链 Cookie 丢失、
  重定向次数上限不足等问题，上游仓库（3.16.4）已修复但未发布。
  本仓库通过 pnpm patch 移植了这些修复，重装依赖时自动应用。
- **设备信任**：登录脚本会向你的清华账号登记一个名为 `thu-assistant-dev` 的
  信任设备（官方 App 同款机制），可随时到 <https://id.tsinghua.edu.cn/> 的
  「多因子认证」管理页面删除。
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
