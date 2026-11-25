# editVMD

在线 VMD（MMD 动作）编辑器：在浏览器里导入 PMX 模型、编辑动作关键帧、生成并导出 VMD。

- 导入 PMX 渲染、导入 VMD 回放、导出 VMD（字节级 roundtrip）
- 多行 dope sheet 时间轴 + 逐通道 Bézier 曲线编辑
- 关键帧增删改、30 步撤销重做、刷新后断点继续
- 一句话生成动作 / 表情，或上传参考视频生成动作
- 侧边栏 AI 助手，可直接操作编辑器

## 快速开始

### 方式一：官方镜像（推荐，开箱即用）

```bash
cp .env.example .env                              # 按需填 API Key，其余保持默认
docker compose -f docker-compose.image.yml up -d  # 自动拉取镜像（约 1GB）
```

打开 **http://localhost:8200**。镜像内置动作 / 表情生成模型，无需额外准备。

### 方式二：从源码构建

```bash
cp .env.example .env
docker compose up -d --build                      # 约 5~10 分钟
```

> 源码构建需要仓库本地存在模型资产（`backend/app/motiongen/data`、`backend/app/expressiongen/data`，
> 这些不随源码分发，见 [ASSETS-LICENSE.md](ASSETS-LICENSE.md)）。

### 配置

所有配置都在仓库根目录的 `.env`（模板 `.env.example`，与 compose 文件同目录）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `EDITVMD_AI_API_KEY` | 否 | DeepSeek API Key；不填则 AI 助手不可用 |
| `EDITVMD_METASO_API_KEY` | 否 | 文本 → 动作（MiniMax 图生视频） |
| `EDITVMD_ANIMCHAR_API_KEY` | 否 | 视频 → 动作（动捕） |
| `POSTGRES_PASSWORD` | 否 | 数据库密码，默认 `editvmd` |

> 一个 Key 都不填也能用：编辑器、上传 / 导入 / 导出、动作库、断点继续等基础功能全部正常。

### 数据

| 内容 | 位置 |
|---|---|
| 上传的模型 / VMD / 生成物 | `./storage`（绑定挂载，可直接备份） |
| 数据库 | Docker 卷 `editvmd_pgdata` |
| AI 会话配置 | Docker 卷 `editvmd_claude_cfg` |

```bash
docker compose logs -f app     # 查看日志
docker compose down            # 停止（数据保留）
docker compose down -v         # 停止并删除数据库
```

## 本地开发

```bash
bash scripts/dev.sh        # 起数据库 + 后端(8200) + 前端(5173)
bash scripts/dev.sh stop
```

需要 Python 3.12 / pnpm / Docker；开发配置用 `backend/.env`。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite 7 + React 19 + TypeScript 5.9 |
| 渲染 | [reze-engine](https://github.com/AmyangXYZ/reze-engine)（MIT，WebGPU） |
| 后端 | Python 3.12 + FastAPI + Uvicorn |
| 数据库 | PostgreSQL 16 + SQLAlchemy 2.0 |
| 部署 | Docker Compose（单容器 + Postgres） |

## 许可证

- **代码**：[MIT](LICENSE) © 2026 arthur-9527
- **模型 / 动作库**（随官方 Docker 镜像提供，不随源码分发）：见 [ASSETS-LICENSE.md](ASSETS-LICENSE.md)
- **渲染引擎** [reze-engine](https://github.com/AmyangXYZ/reze-engine)：MIT
- **第三方依赖**：[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
