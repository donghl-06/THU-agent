# 在 Codex 中使用清灵

本项目同时发布两个独立的 Windows 包：`清灵-EXE` 用于网页聊天，`清灵-MCP` 用于让已有的 Codex/Claude Desktop 等 Agent 调用校园能力。用户只下载自己需要的包；MCP 包不包含网页聊天 EXE，EXE 包也不包含 MCP 连接入口。

## 能力边界

- 默认向 Codex 暴露只读能力：课表、校园卡、教室、图书馆、体育场馆、成绩单、宿舍电费和我的图书馆预约。
- MCP 专用工具 `thu_login` 可使用仓库 `.env` 中的凭证登录；`get_user_info` 可检查登录是否成功。
- 预约、取消、充值等写操作默认不会列出。即使设置 `THU_MCP_INCLUDE_WRITE_TOOLS=1` 让它们显示，也会因为没有安全的用户确认通道而拒绝执行。
- 需要二次认证时，先运行 MCP 包中的“登录清华账号.cmd”完成登录，再重启或继续使用 MCP Server。密码、验证码、Cookie 不会返回给 Codex。

## MCP 包用户配置

1. 下载并解压 `清灵-MCP`，保持整个文件夹结构。
2. 将 `.env.example` 复制为同目录的 `.env`。
3. 在 `.env` 中填写 `THU_USERNAME`、`THU_PASSWORD`。`THU_FINGERPRINT` 可留空，清灵会自动保存在本机；MCP 包不需要填写 `LLM_API_KEY`。
4. 用户电脑不需要安装 Node.js、pnpm 或 Git；包内的 `runtime/node.exe` 会被 Codex 直接调用。

## 在已有 Agent 中配置

以 Codex CLI 为例，在 MCP 配置文件 `%USERPROFILE%\\.codex\\config.toml` 中加入一个服务器。其他支持 MCP 的 Agent 也使用同样的 `command` 与 `args`：

```toml
[mcp_servers.thu_assistant]
command = "D:/Apps/清灵-MCP/runtime/node.exe"
args = ["D:/Apps/清灵-MCP/mcp-server.cjs"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

将路径替换为用户实际的 MCP 包目录。配置修改后重启 Agent。在新会话中可以先询问“调用 `get_user_info` 检查我的清华登录状态”，再尝试“查询我今天的课表”。

## 开发者源码模式

开发者在源码仓库中可以使用 `pnpm --silent mcp` 调试；普通用户不需要执行该命令。

## 本地调试

MCP 使用标准输入输出通信，不能直接在普通终端里输入自然语言。可以用下面命令启动服务器，再由 Codex 连接：

```powershell
pnpm --silent mcp
```

标准输出只包含 MCP JSON-RPC 消息；诊断信息应写入标准错误，不要把日志打印到标准输出。
