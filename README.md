# 灵感熔炉

基于 [RedFox API](https://redfox.hk/invite?invitationCode=774T2BJn) 的本地自媒体工作台。

## 功能

- **热榜与趋势**：全网热点、抖音 / 小红书 / 公众号热榜、AI 公众号 / AI B站 / AI 小红书 / AI 抖音 / AI 快手 / AI 视频号 / 短剧抖音 / 短剧公众号昨日榜；7/14 天增长、稳定、冷却趋势
- **Skill 中心**：从 [redfox-community](https://github.com/redfox-community/skills) 拉取并热更新；支持 LLM 自动分类（热点 / 创作 / 分析 / 检索 / 生成工具）；热点 Skill 可一键绑定到热榜 Tab
- **热榜动态 Tab**：默认只显示抖音 / 小红书 / 公众号 3 个基础 Tab，其余平台通过 Skill 绑定后动态创建，解绑即移除
- **选题生成**：基于本地热榜证据 + 公众号爆款搜索，调用 OpenAI 兼容 LLM 生成选题
- **账号追踪**：分组订阅、作品同步、公众号 / 抖音 / 小红书诊断、趋势图表（粉丝 / 红狐指数 / 评分 / 作品数）
- **知识库**：Obsidian / Notion 双源接入 + WeRss（we-mp-rss）公众号文章同步
- **内容重构**：多平台改写、RedFox `gpt-image-2` 封面生成、违禁词检测
- **本地 Agent**：Codex / Claude Code / Kimi / OpenClaw / Hermes 子进程集成
- **CRON 调度**：内置每日热榜快照、缓存清理、WeRss 同步、账号追踪刷新等任务；支持自定义、拖拽排序
- **Docker & 多架构镜像**：提供 Dockerfile 和 Docker Compose，GitHub Actions 自动构建 `linux/amd64` 与 `linux/arm64` 镜像并推送到 GHCR

## 本地启动

要求 Node.js ≥ 20。

```bash
cd insprira
npm install
cp .env.example .env
# 编辑 .env，至少填写 REDFOX_API_KEY 和 KB_ENCRYPTION_KEY
npm start
```

浏览器访问 [http://0.0.0.0:8080](http://0.0.0.0:8080)。

首次启动创建默认账号 `admin / 123456`，登录后请立即在「账户与安全」修改密码。

## Docker 部署

### 使用 Docker Compose（推荐）

1. 复制环境变量文件并填写必填项：

```bash
cp .env.example .env
# 编辑 .env，至少填写 REDFOX_API_KEY
```

2. 启动服务：

```bash
docker compose up -d
```

3. 访问 [http://0.0.0.0:8080](http://0.0.0.0:8080)。

数据默认挂载到 `./data` 目录，包含 SQLite 数据库和运行日志。

### 使用 Docker 命令

```bash
docker build -t insprira .
docker run -d \
  --name insprira \
  -p 8080:8080 \
  -e HOST=0.0.0.0 \
  -e REDFOX_API_KEY=你的RedFoxKey \
  -e APP_PASSWORD=你的登录密码 \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  ghcr.io/coracoo/insprira:latest
```

> 服务默认监听 `0.0.0.0`，本地和容器内均可直接访问。

## 配置

完整字段见 [`.env.example`](.env.example)。必填项：

- `REDFOX_API_KEY` — RedFox 平台 API Key
- `LLM_API_KEY` — OpenAI 兼容 LLM 服务的 Key（用于选题生成、热点分析）
- `KB_ENCRYPTION_KEY` — 加密密钥，用 `openssl rand -hex 32` 生成，配置后请勿修改

## 验证

```bash
npm run check   # 语法检查
npm test        # 回归测试
```

## License

[AGPL-3.0](LICENSE)
