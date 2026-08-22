# STM Desktop（SSH 隧道管理器）

<img src="./resources/icon.png" alt="STM" width="168" height="168">

基于 **Electron + Vue 3 + TypeScript** 的可视化 SSH 隧道管理工具，将工作区中 [SSH-Tunnel-Manager](../SSH-Tunnel-Manager/README.md)（Python 命令行版）的全部功能移植为桌面 GUI，并把配置管理也做成了页面操作：新增、修改、删除隧道/组、导入导出配置、实时启停与日志查看，无需再手改配置文件。

> STM = SSH Tunnel Manager。项目与打包名称：`STM Desktop`（npm 包名 `stm-desktop`，可执行文件 `STMDesktop.exe`）。

- 支持 Windows / macOS / Linux
- 多组管理：`defaults → 组 → 隧道` 三级配置继承
- 同时支持 OpenSSH 与 PuTTY Plink；Windows 密码认证开箱即用（内置 `plink.exe`）

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 隧道总览 | 按组分卡片展示全部隧道，实时状态（运行中 / 连接中 / 已停止）、PID、本地 → 远端映射 |
| 一键操作 | 启动 / 停止 / 重启，支持单条隧道、整组、全部；`enabled=false` 的隧道在批量启动时自动跳过 |
| 配置校验 | 校验每条隧道并显示脱敏后的完整命令行（密码以 `*` 隐藏） |
| 页面化配置 | 默认设置、组、隧道全部可在页面增删改，支持常用字段快捷添加与任意自定义键值 |
| 配置文件 | 保存即写回磁盘；支持重新加载、打开其它配置、另存为、打开配置目录、恢复默认模板 |
| 日志查看 | stdout / stderr 实时查看，可调行数、自动刷新、自动滚动 |
| 状态提示 | 操作结果 Toast 提示、危险操作二次确认 |

## 技术架构

```
渲染进程 (Vue 3)          预加载 (preload)           主进程 (Electron / Node)
┌─────────────────┐   contextBridge   ┌───────────┐   ┌──────────────────────┐
│ Tunnels 视图     │ ◄──────────────► │ window.api │ ◄►│ ipc.ts（IPC 通道）    │
│ Config 视图      │   tunnel/config/ │ (类型安全)   │   │  ├─ config.ts 配置引擎 │
│ Logs 视图        │   app 三大命名空间 │            │   │  └─ manager.ts 进程管理│
│ Toast / 弹窗     │                  │            │   │  └─ 状态文件 + 日志    │
└─────────────────┘                  └───────────┘   └──────────────────────┘
```

- **主进程**（`src/main/tunnel/`）：配置解析/序列化/校验、SSH 客户端选择、子进程生命周期管理，全部基于 Node 标准库，不依赖第三方包
- **预加载**（`src/preload/`）：通过 `contextBridge` 暴露类型安全的 `window.api`（`tunnel` / `config` / `app`）
- **渲染进程**（`src/renderer/`）：Vue 3 单页界面，2 秒轮询刷新隧道状态

## 快速开始

环境要求：Node.js 18+（推荐 20+）。

```bash
# 安装依赖（首次）
npm install

# 开发模式（热更新）
npm run dev

# 运行已构建产物
npm start

# 类型检查 + 构建到 out/
npm run build

# 打包安装程序（Windows / macOS / Linux）
npm run build:win
npm run build:mac
npm run build:linux
```

Windows 安装包为 **NSIS 向导式安装**（`dist/stm-desktop-1.0.0-setup.exe`），安装过程中可**选择安装目录**、选择是否创建桌面快捷方式，默认安装到当前用户的程序目录（无需管理员权限）。

## 界面操作指南

顶部工具栏显示当前配置文件路径、SSH / Plink 可用性，以及进行中的批量操作提示。

### 隧道页（默认）

- **全部启动 / 全部停止 / 全部重启**：作用于所有启用的隧道
- **校验配置**：逐条构建命令并校验，绿色“通过”或红色“失败”，失败原因精确定位到具体隧道；通过项可查看脱敏后的完整命令行
- **分组卡片**：每组显示 `服务器@用户名`、隧道数量，以及 启动组 / 停止组 / 重启组
- **隧道行**：状态点（绿=运行中、黄=连接中、灰=已停止）、PID、`本地地址 → 远端地址`，以及 启动 / 停止 / 重启 / 日志 按钮
  - 状态为“连接中”表示进程已拉起但本地端口尚未打开（SSH 握手 / 主机密钥确认中）

### 配置页

所有修改先停留在内存中，点 **保存配置**（有未保存修改时按钮高亮）才写回磁盘；校验错误会以红色横幅给出精确原因。

- **默认设置**：`[defaults]`，全部隧道的默认值（客户端、SSH 端口、绑定地址、默认启用、主机密钥策略等）
- **组**：`[group:名称]`，组内隧道共享的服务器与认证信息；改名时组内隧道自动跟随；删除组时组内隧道保留但不再继承该组配置
- **隧道**：`[tunnel:组:名称]`，必填项为 本地端口 / 远端主机 / 远端端口（另需组的 server/username）；常用字段以表单呈现，其余放入“高级/其他选项”键值编辑器
- **文件操作**：重新加载（丢弃未保存修改）、打开配置…（切换到已有配置文件，如原来的 `tunnel.conf`）、另存为…、打开配置目录（在资源管理器中定位）、恢复默认模板

### 日志页

选择隧道后可查看其 stdout / stderr 日志文件尾部，支持 100–1000 行、自动刷新（1.5s）、自动滚动；显示日志文件路径与隧道当前是否在运行。

## 配置说明

### 配置文件位置

- 默认：`<用户数据目录>/tunnel.conf`
  - Windows：`%APPDATA%\STM Desktop\tunnel.conf`
  - macOS：`~/Library/Application Support/STM Desktop/tunnel.conf`
  - Linux：`~/.config/STM Desktop/tunnel.conf`
- 在「配置」页点 **打开配置…** 可切换到其它文件（路径会记录在 `settings.json`，下次启动自动沿用）
- 运行时状态与日志存放于 `<用户数据目录>/.tunnel/`（PID 状态 JSON + `*.out.log` / `*.err.log`）

### 配置格式

继承顺序：`[defaults]` → `[group:组名]` → `[tunnel:组名:隧道名]`，后一级覆盖前一级；命令目标支持 `all`、`组名`、`组/隧道名`。

```ini
[defaults]
client=auto
server_port=22
local_bind=127.0.0.1
enabled=true
strict_host_key_checking=accept-new

[group:feishu]
server=ssh.example.com
username=deploy
password=replace-with-password        # 密码认证：Windows 自动用 plink，Linux/macOS 用 SSH_ASKPASS
hostkey=SHA256:replace-with-fingerprint  # Plink 建议填写人工核验的主机指纹

[tunnel:feishu:redis]
local_port=6379
remote_host=127.0.0.1
remote_port=6379

[tunnel:feishu:mysql]
enabled=false                          # 批量启动时跳过
local_port=3306
remote_host=127.0.0.1
remote_port=3306
```

旧式 `[隧道名]` 段仍兼容：段内写 `group=组名` 即归入该组，未写则归入 `default` 组。所有键名不区分大小写。

### 字段说明

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `server` | — | SSH 服务器地址（必填） |
| `username` | — | SSH 用户名（必填） |
| `local_port` | — | 本地监听端口（必填，1–65535） |
| `remote_host` | — | 远端转发目标主机（必填） |
| `remote_port` | — | 远端转发目标端口（必填，1–65535） |
| `client` | `auto` | `auto` / `ssh` / `plink.exe` / `plink` 或自定义路径；`auto` 时 Windows 密码认证优先用内置 plink，其余情况优先系统 OpenSSH |
| `server_port` | `22` | SSH 服务器端口 |
| `local_bind` | `127.0.0.1` | 本地绑定地址（填 `0.0.0.0` 可对外暴露，注意安全） |
| `password` | — | 密码（仅 Plink 或 Linux/macOS AskPass；Windows 下 OpenSSH 不支持密码） |
| `private_key` | — | 私钥路径：绝对路径 / 相对项目目录 / `~/.ssh/...` |
| `hostkey` | — | SHA256 主机指纹（仅 Plink） |
| `strict_host_key_checking` | `yes` | 仅 OpenSSH：`yes` / `accept-new` / `no`（`no` 不安全） |
| `enabled` | `true` | 为 `false` 时批量启动跳过，但可单独启动/停止/查看日志 |

## 实现原理

每个隧道对应一个独立 SSH 客户端子进程，执行 `ssh -N -T -L 本地地址:本地端口:远端地址:远端端口`（Plink 为 `plink -ssh -P … -L … -N -batch`）。PID 与日志记录在 `.tunnel/` 下，管理器据此判断状态、停止与重启：

- **启动**：先检查本地端口未被占用 → 拉起进程（Windows 下以分离进程组运行，关闭应用后隧道仍可存活）→ 写入状态文件（含 PID 与进程标识，用于识别 PID 被复用）→ 最多等待 6 秒确认本地端口打开，失败则回滚清理
- **状态**：进程存活 + 本地端口已开 = 运行中；进程存活但端口未开 = 连接中；否则为已停止（并自动清理失效状态文件）
- **停止**：Windows 终止进程，Linux/macOS 终止整个会话（进程组）
- **密码认证**：Windows 自动选择内置 `resources/plink.exe`（`-pw`）；Linux/macOS 使用 OpenSSH 原生 `SSH_ASKPASS` 机制（密码通过子进程环境变量传递，不写入命令行或脚本文件）

## 测试

```bash
# 1. 类型检查 + 代码规范
npm run typecheck
npm run lint
npm run format        # prettier 自动格式化

# 2. 引擎冒烟测试（无需 Electron，无第三方依赖）
npm run smoke
```

`npm run smoke` 覆盖：真实 `tunnel.conf` 解析与三级继承合并、序列化往返一致性、旧格式段兼容、缺字段/非法端口/重复隧道/重复键等错误场景、目标解析（all/组/精确）、plink 与 OpenSSH 命令构建（含密码脱敏）、完整的 启动→状态→日志→重复启动→停止→重启 生命周期、端口占用冲突、默认模板有效性。

端到端 IPC 检查（可选，需先 `npm run build`）：

```bash
npx electron scripts/ipc-check.cjs
```

该脚本启动构建产物，并从渲染进程实际调用 `window.api` 的各通道，验证 preload 桥接与主进程 IPC 处理器。注意：它以 `electron scripts/ipc-check.cjs` 方式启动时应用根目录会解析到 `scripts/`，因此输出中的 `plink:false` 属正常现象（正式 `npm run dev/start` 或打包运行时会正确识别 `resources/plink.exe`）。

## 目录结构

```
STM Desktop/
├─ src/
│  ├─ main/                     # Electron 主进程
│  │  ├─ index.ts               # 应用入口：创建窗口、注册 IPC
│  │  └─ tunnel/
│  │     ├─ types.ts            # 内部类型定义
│  │     ├─ config.ts           # 配置解析/序列化/校验（纯 Node，可独立测试）
│  │     ├─ manager.ts          # 进程生命周期管理（纯 Node，可独立测试）
│  │     └─ ipc.ts              # IPC 通道、对话框、路径持久化
│  ├─ preload/
│  │  ├─ index.ts               # contextBridge 暴露 window.api
│  │  └─ api.d.ts               # 全局 API 类型（渲染进程与主进程共用）
│  └─ renderer/
│     └─ src/
│        ├─ App.vue             # 布局：头部/页签/视图切换
│        ├─ views/              # TunnelsView / ConfigView / LogsView
│        ├─ components/         # KeyValueEditor / ToastHost
│        ├─ composables/        # 状态轮询、Toast、页签共享状态
│        └─ assets/main.css     # 深色主题样式
├─ scripts/
│  ├─ tunnel-smoke.ts           # 引擎冒烟测试（npm run smoke）
│  └─ ipc-check.cjs             # 端到端 IPC 检查
├─ resources/
│  ├─ plink.exe                 # PuTTY Plink 0.84（Windows 密码认证）
│  └─ PUTTY-LICENSE.txt         # PuTTY 许可证
├─ electron-builder.yml         # 打包配置（extraResources 携带 plink）
└─ package.json
```

## 常见问题

- **Windows 密码认证报错“use client=plink.exe for password authentication on Windows”**：OpenSSH 在 Windows 上不支持命令行密码，请改用密码认证时在组/隧道设置 `client=plink.exe`（或保持 `auto`，应用会自动使用内置 plink）。
- **首次连接提示主机密钥**：建议先运行一次 `ssh user@server` 核验并保存主机密钥；OpenSSH 可设 `strict_host_key_checking=accept-new`，Plink 建议在 `hostkey` 中填写人工核验的 SHA256 指纹。
- **关闭应用后隧道还在运行**：隧道以分离进程运行，这是有意为之（与命令行版一致），重新打开应用可继续管理。
- **配置文件权限**：含密码的配置文件建议限制为当前用户可读写（Linux/macOS：`chmod 600 tunnel.conf`）。
- **打包**：`npm run build:win` 会调用 electron-builder 下载打包工具，`.npmrc` 已配置国内镜像；NSIS 安装器已开启“选择安装目录”（`electron-builder.yml` 中 `oneClick: false` + `allowToChangeInstallationDirectory: true`）。离线环境可跳过打包，直接使用 `out/` 产物或 `npm run dev`。

## 许可证与第三方组件

- 本项目的隧道管理逻辑移植自[SSH-Tunnel-Manager](https://github.com/liuchaoxu/SSH-Tunnel-Manager)（GNU GPL v3），分发本项目时请遵守 GPL v3 或取得原项目授权
- 随附的 `resources/plink.exe` 来自 PuTTY 0.84，按 PuTTY 的 MIT 风格许可证发布，重新分发时请保留 `resources/PUTTY-LICENSE.txt` 中的版权声明；PuTTY 上游：<https://www.chiark.greenend.org.uk/~sgtatham/putty/>
