# Quick Manager

> 面向 **AWS Quick（Windows 桌面端）** 的多账号池管理、极速切号、实时双额度监控、跨号对话归档与云端配置一站式桌面工具（纯 Node.js 零外部 npm 依赖 + 可选 Electron 桌面外壳）。

---

## 核心特性

### 1. 高密度账号池看板（可折叠侧栏 + 分段刻度标签卡）
- **实时双窗口额度监控**：直连 AWS Quick 官方云端额度接口，每张卡片同时以 **28 格分段 LED 进度条** 展示 **月度额度（Monthly）** 与 **5 小时滚动会话额度（Session）** 及重置倒计时。
- **一键测活（⚡）**：单号并发验证 Token 有效性、额度接口与云端会话接口连通性，实时展示响应延迟（ms）与存活状态。
- **账号分组与备注**：支持自定义分组（内置 `主力` / `备用` / `家人` / `测试` 快捷标签）、备注编辑、关键词搜索、按分组/状态组合筛选、**隐私打码**与**紧凑模式**。
- **智能空闲选号与极速切号**：自动挑选健康且余量最充足的空闲账号；免 CDP、免 `--inspect` 注入，通过 Windows 凭据管理器 + 原子写 `profiles.json` 实现 1~2 秒极速安全切号（失败自动回滚）。

### 2. 多种独立登录方式（彻底避免串号）
- **远程 VPS / 跨设备 OAuth 登录**：绝不弹出本机浏览器抢跑，支持复制授权链接到远程浏览器登录，支持手动粘贴回调地址或 SSH 反向端口转发全自动完成。
- **本机无痕窗口 OAuth 登录**：自动调用 Edge InPrivate / Chrome 无痕窗口发起独立 OAuth 登录，不串本机已有 AWS 会话。
- **标准凭证 JSON 导入 / 导出**：兼容常见 JSON 凭证格式，自动写入本机 Windows 凭据管理器（分片 UTF-16LE + SHA-256 校验）。
- **桌面端空白窗登录**：备份原有账号清单后打开空白窗口登录新号，完成后自动合并原有全部账号。

### 3. 本地对话同步与跨号续聊中心
- **全号池 / 按账号增量同步**：直连各账号云端 `api/sessions` 增量拉取聊天记录，本地保存结构化 JSON 与可读 Markdown 归档（`data/conversations/markdown/<账号名>/`）。
- **全文检索与本地路径续聊**：支持跨账号全文检索历史对话；换号时后台并行同步原账号最新对话，并自动复制极简本地文件路径续聊指令（切号后按 `Ctrl + V` 让新号直接读取本地归档接续上下文）。

### 4. 一键配置、内置技能精简与云端语言同步
- **一键开启完全权限（Local Tools MCP）**：内置无乱码 Windows 本地终端与文件读写 stdio MCP 服务（[tools/local-tools-mcp.js](tools/local-tools-mcp.js)，自动处理 UTF-8 / GB18030 中文编码），一键为全池及后续新号挂载并配置 `tool_permissions.json`。
- **自带技能一键精简**：通过官方云端接口批量关闭冗余内置技能（默认可保留 `Coding Agent Skills`），减少上下文占用与干扰，并支持单条开关与一键恢复。
- **一键设为简体中文**：批量将所有账号云端界面语言设为 `zh-CN`、时区设为 `Asia/Shanghai`。
- **通用配置模板同步**：支持将已配好的 MCP、文件夹白名单、工具权限、ACP 代理与集成配置一键同步给全部账号。
- **可选本地反代接入**：内置可选的 OpenAI 兼容 `/v1` 本地反代适配面板（支持按需启停 `awsquick-2api`）。

---

## 环境要求

- **操作系统**：Windows 10 / 11
- **Node.js**：v18 及以上（核心服务端零外部 npm 依赖，开箱即用）
- **Electron**（可选）：如需独立桌面窗口与系统托盘常驻，可安装 Electron 运行时或通过环境变量 `QWM_ELECTRON` 指定路径

---

## 快速开始

### 方式一：浏览器模式（最简单，零依赖）

```bash
git clone https://github.com/HEYD66/Quick-Manager.git
cd Quick-Manager
npm start
```

启动后在浏览器打开 `http://127.0.0.1:9600/` 即可使用。

### 方式二：Electron 桌面客户端模式（推荐）

1. 安装 Electron（或设置环境变量 `QWM_ELECTRON` 指向已有 `electron.exe`）：
   ```bash
   npm install electron --no-save
   ```
2. 双击根目录下的 **`启动Quick账号助手.bat`**，或运行：
   ```powershell
   powershell -ExecutionPolicy Bypass -File start-app.ps1
   ```
3. 桌面客户端支持单实例运行、关闭窗口最小化到系统托盘、托盘右键「重新加载页面 / 重启本地服务 / 完全退出」。

---

## 目录结构

```text
Quick-Manager/
├── server.js                 # 本地 HTTP + SSE 服务（127.0.0.1:9600）
├── selftest.js               # 自动化接口与安全自检脚本
├── lib/
│   ├── core.js               # profiles.json 原子读写、配置与审计日志
│   ├── keychain.js           # Win32 advapi32 凭据管理器分片安全读写
│   ├── quick-cloud.js        # AWS Quick 云端额度/API/无痕与远程 OAuth 引擎
│   ├── pool.js               # 账号池状态、极速切号、测活、云端技能与语言同步
│   ├── conversations.js      # 多账号云端对话增量同步、全文搜索与 Markdown 归档
│   ├── ops.js                # 账号目录备份恢复、MCP 连通测试、缓存清理
│   └── quickgw.js            # 可选本地反代网关适配层
├── tools/
│   └── local-tools-mcp.js    # 无中文乱码 Windows 本地终端/文件 stdio MCP 服务
├── web/                      # 零依赖原生前端（侧栏 + 分段刻度标签卡 + 暗/亮双主题）
│   ├── index.html
│   ├── app.css
│   └── app.js
├── electron/                 # Electron 桌面壳体与托盘管理
├── start-app.ps1             # 启动 Electron 桌面端
├── 启动Quick账号助手.bat       # Windows 一键双击启动入口
└── make-portable.ps1         # 打包独立便携版脚本
```

---

## 隐私与安全说明

- 所有账号凭据、Token、对话归档、备份与审计日志**仅保存在本机**（Windows 凭据管理器与项目 `data/` 目录），`data/` 目录已在 `.gitignore` 中默认排除，**绝不上传任何第三方服务器**。
- 本地 Web 服务仅监听回环地址 `127.0.0.1:9600`，所有写操作均受本地随机令牌（`x-qwm-token`）保护。
- **防 Token 双花保护**：AWS OIDC `refresh_token` 为单次消费轮换机制，管理器在检测到桌面端正在运行时，会自动避免外部强刷当前活跃账号的 `refresh_token`。
- 开启「Local Tools MCP 完全权限」后，AWS Quick 将以当前 Windows 用户身份执行本地命令与读写文件，请仅在个人受信任设备上启用。

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源，仅供个人学习与效率提升使用；与 Amazon / AWS 无任何官方关联。
