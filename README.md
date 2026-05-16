# 音频工作站

基于节点连线的可视化音频工作站，使用小米 MiMo TTS API 实现语音克隆与语音设计。

用户可在 React Flow 画布上将参考音频、语音风格指令、文本提示词和 TTS 节点进行连线，生成克隆语音或设计语音。

## 功能特性

- **可视化节点编辑器** — 拖拽连线，所见即所得的音频处理流程
- **语音克隆 (Voice Clone)** — 上传参考音频 + 文本，克隆目标音色
- **语音设计 (Voice Design)** — 无需参考音频，通过文字描述生成全新音色
- **智能画板生成** — AI 一键生成完整的节点工作流
- **AI 文本优化** — 自动优化语音风格描述和提示词
- **音频暂存区** — 保存、管理和回放生成的音频片段
- **多工作区** — 支持创建和管理多个独立工作区
- **桌面应用** — 可打包为 Windows Electron 桌面应用

## 节点类型

| 节点 | 说明 |
|---|---|
| 参考音频 (Reference Audio) | 上传或录制语音样本 |
| 语音风格 (Voice Style) | 情感/表达方式的导演指令，支持 AI 优化 |
| 提示词 (Prompt) | 待合成的文本内容 |
| 语音克隆 (Voice Clone) | 主 TTS 节点，接入参考音频 + 风格 + 文本，调用 MiMo 克隆 API |
| 语音设计 (Voice Design) | 通过文字描述生成语音，无需参考音频 |
| 输出 (Artifact) | 播放/下载/暂存生成的音频 |

## 技术栈

- **前端**: React 19 + TypeScript + Vite + @xyflow/react (React Flow) + Lucide Icons
- **后端**: Express 5 + TypeScript
- **桌面**: Electron + electron-builder
- **AI**: 小米 MiMo TTS API (`mimo-v2.5-tts-voiceclone` / `mimo-v2.5-tts-voicedesign`)

## 快速开始

### 环境要求

- Node.js >= 22
- npm

### 安装

```bash
git clone <repo-url>
cd mimo
npm install
```

### 配置

复制 `.env.example` 为 `.env`，填入你的 MiMo API Key：

```bash
cp .env.example .env
```

```env
MIMO_API_KEY=your_mimo_api_key_here
PORT=3001
```

### 启动开发环境

```bash
npm run dev
```

启动后访问：
- 前端: http://localhost:5173
- 后端: http://localhost:3001

### 单独启动

```bash
npm run dev:client   # 仅前端 (Vite)
npm run dev:server   # 仅后端 (Express)
```

## 构建与打包

### Web 构建

```bash
npm run build
```

输出：
- `dist/` — 前端静态资源
- `build/server/index.cjs` — 服务端 bundle

### Electron 桌面应用

```bash
npm run electron      # 构建并启动桌面应用
npm run dist:win      # 构建并打包 Windows 安装程序 (输出到 release/)
```

## 项目结构

```
mimo/
├── src/
│   ├── App.tsx          # 前端主应用（节点编辑器、工作区管理、音频处理）
│   ├── main.tsx         # React 入口
│   └── styles.css       # 全局样式
├── server/
│   └── index.ts         # Express API 服务（TTS 代理、工作区 CRUD、AI 优化）
├── electron/
│   └── main.cjs         # Electron 主进程
├── data/
│   └── workspaces.json  # 工作区数据持久化（运行时生成）
├── .env.example         # 环境变量模板
└── package.json
```

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tts/voiceclone` | 语音克隆（multipart，含音频文件） |
| POST | `/api/tts/voicedesign` | 语音设计（JSON） |
| POST | `/api/voice-style/optimize` | AI 优化语音风格文本 |
| POST | `/api/voice-design/optimize` | AI 优化语音设计描述 |
| POST | `/api/workspaces/smart` | AI 智能生成工作区 |
| GET | `/api/workspaces` | 获取所有工作区 |
| PUT | `/api/workspaces/:id` | 更新工作区 |
| DELETE | `/api/workspaces/:id` | 删除工作区 |

## License

该项目基于小米Mimo模型提供核心能力，并非Mimo品牌或小米产品；项目完全由ClaudeCode+mimo-v2.5-pro编写，无人工编写成分。
