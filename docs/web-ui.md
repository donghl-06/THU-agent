# 清灵 Web UI

前端使用 React、TypeScript、Vite、Lucide React 和 Motion。
浅色与深色共享布局、字体和间距；系统字体优先，资源本地打包。
原生 dialog 提供焦点约束与 Escape 关闭，移动侧栏支持遮罩关闭与键盘导航。
动效包含分层入场、侧栏伸缩、选中态移动、处理过程折叠、弹窗和通知过渡。

## 截图

截图由离线测试生成，课程、账号和预约均为测试数据。

### 桌面 · 浅色

![浅色界面](screenshots/web-desktop-light.png)

### 桌面 · 深色

![深色界面](screenshots/web-desktop-dark.png)

### 对话与课程表

![对话界面](screenshots/web-conversation.png)

### 手机

![手机界面](screenshots/web-mobile.png)

### 文件上传

![文件上传](screenshots/web-file-upload.png)

## 验证

`pnpm typecheck` 检查前后端 TypeScript；`pnpm test --exclude 'tests/integration/**'`
运行离线单元及服务端测试；`pnpm test:web` 启动端口 3461 的离线模拟服务并运行浏览器回归。
模拟服务复用实际 HTTP/SSE 与确认桥，但不装配真实客户端、调度器或 LLM。

浏览器覆盖历史登录隔离、流式处理状态、停止/再次发送、明确确认、二次认证、
图片和文件附件、上传失败与切换对话、临时图片查看/删除/过期、光标位置语音输入、
中文输入法、手机布局、深浅色和焦点返回。
校园服务真实登录、设备麦克风识别和真实支付仍需在实际使用环境验证。
