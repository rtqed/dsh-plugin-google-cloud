# dsh-plugin-google-cloud

将 Google Cloud Vertex AI 作为模型提供方接入 DSH 的插件。注册提供方路由 `vertexai`（显示名 Google Vertex AI），支持两种认证模式：
1. **快速模式（Express Mode）**：使用 Google Cloud API Key（`?key=` 鉴权）直连调用。
2. **完整模式（Full Mode）**：使用 Google Cloud 服务账号凭据（Service Account JSON 密钥），本地原生生成 RS256 签名并自动换取与轮换 OAuth2 Bearer Access Token。

支持流式输出、工具调用、思考等级、图片输入、PayGo 服务档位（standard / priority / flex），以及生图工具 `generate_image`（Gemini 图像模型 / Imagen 4，图片直接显示在对话里）。

> 兼容性：本版本面向 DSH `0.2.1-rc.3` 运行时（桌面版 `0.2.1-rc.3`）。兼容范围在 `package.json` 的 `engines.dsh` 中声明为 `^0.2.1-rc.2`，同时覆盖 `0.2.1-rc.2` 与 `0.2.1-rc.3` 及后续 `0.2.x`，并在 `0.3.0` 上主动拒绝加载。
>
> 该声明是硬性的：DSH 在导入插件前会把 `engines.dsh` 与自身运行时版本比对（声明了 `engines.dsh` 时只由它决定，忽略 `peerDependencies`），不满足的插件不会被导入，只会作为 `disabled` 条目留下并报告 `incompatible-version`。因此**不要把 `peerDependencies` 写成 `0.2.1-rc.2` 这类精确的预发布版本**——精确锁定一个 rc 会排除同版本的后续 rc，升级运行时后插件会被静默拒绝加载。`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-launch-environment`、`@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-tools` 均由运行时提供（`^0.2.1-rc.2`），插件不再自带旧版副本。
>
> 如需更早的 `0.1.5-rc.2` 运行时，请使用分支 `v0.1.5-rc.2`。

## 安装

发布物为标准 npm 插件包（`.tgz` 格式）。推荐在 DSH 的 **设置 -> 插件** 界面里安装该 `.tgz`；也可以使用 CLI：

```sh
dsh plugin add C:/path/to/dsh-plugin-google-cloud-0.6.4.tgz
```

升级时先用 `dsh plugin remove dsh-plugin-google-cloud` 移除旧版，再执行上述添加命令，然后重启应用以加载新的模块。

## 凭据与认证模式

插件支持在 DSH 设置界面中可视化切换模式与配置凭据，敏感凭据由受管凭据服务加密存储（绝不写进明文配置）：

- **快速模式 (Express Mode)**：通过设置页输入 API Key，凭据引用变量为 `GOOGLE_CLOUD_API_KEY`。
- **完整模式 (Full Mode)**：通过设置页粘贴 Service Account JSON 内容（或本地 `.json` 文件绝对路径），凭据引用变量为 `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON`。插件将自动解析 `project_id` 与 `client_email`，并安全换取 OAuth2 令牌。

亦可通过环境变量或受管凭据文件配置：

| 方式 | 位置 |
| --- | --- |
| 启动环境变量 | 启动 DSH 前在系统环境变量设置 `GOOGLE_CLOUD_API_KEY=<密钥>` 或 `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON=<JSON内容或路径>` |
| 受管凭据文件 | `~/.dsh/.credentials.yaml` 的 `refs:` 段下添加对应键值 |
| Harness home `.env` | `~/.dsh/.env` 写对应键值 |

## 配置

插件的全部配置项都是 **volatile（热更新）字段**，唯一权威存储位置是**挂载该插件的 profile 条目自身的 `config` 块**（即 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里该行的 `config:`），设置界面读写的也是它。修改后下一个请求起即时生效，无需重启，也不会重挂载插件。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `displayName` | `Google Vertex AI` | 模型选择器与设置页显示的提供方名称 |
| `authMode` | `express` | `express`（API Key）或 `full`（Service Account） |
| `apiKeyEnv` | `GOOGLE_CLOUD_API_KEY` | API Key 凭据引用（express 模式） |
| `serviceAccountJsonEnv` | `GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON` | Service Account 凭据引用（full 模式） |
| `region` | `global` | 区域，见下表 |
| `projectId` | 空 | 项目 ID（full 模式下留空自动从 Service Account 提取） |
| `tier` | `standard` | PayGo 服务档位 |
| `endpoint` | 空 | 显式端点覆盖（反向代理）；留空按 region 推导 |
| `streamIdleTimeoutMs` | `300000` | 流式读取空闲上限 |
| `customModels` | `[]` | 追加到可用模型列表的自定义模型 ID |
| `imageToolEnabled` | `true` | 是否注册生图工具 `generate_image`（关闭后模型看不到该工具） |
| `imageModel` | `gemini-2.5-flash-image` | 默认生图模型 ID（见下文「生图工具」） |
| `imageAspectRatio` | `1:1` | 默认生图宽高比：`1:1` / `16:9` / `9:16` / `4:3` / `3:4` |
| `imageCount` | `1` | 每次生图默认张数（1–4，**按张计费**） |

> 旧版曾在 `~/.dsh/settings.yaml` 里维护 `google-cloud:` 段；当前运行时已改为由 profile 条目配置块承载，settings.yaml 只会在首次启动时被迁移导入一次。

### 区域与端点

| region | projectId | 实际请求端点 |
| --- | --- | --- |
| `global`（默认） | 不需要 | `https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:…?key=…` |
| `us-central1`、`europe-west4` 等具体区域 | **必填** | `https://{region}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{region}/…` |
| `us` / `eu`（多区域） | **必填** | `https://aiplatform.{region}.rep.googleapis.com/v1/projects/{projectId}/locations/{region}/…` |
| 任意值（`endpoint` 非空时） | 不需要 | 显式端点原样使用，region/projectId 不参与推导 |

### PayGo 服务档位（tier）

| tier | 价格 | 延迟与服务保障 | 端点约束 |
| --- | --- | --- | --- |
| `standard`（标准档 · 默认） | 标准 PayGo 基准价 | 标准延迟与吞吐 | 无限制 |
| `priority`（优先保障档） | 高于标准价 | 队列优先分配、延迟波动更低、吞吐更稳 | 仅限 global 与 us/eu 多区域端点 |
| `flex`（低价折扣档） | **约五折优惠** | 尽力而为服务（延迟与排队较高） | 仅限 global 端点；不支持 `gemini-4-argon` |

- 档位通过 HTTP 头 `X-Vertex-AI-LLM-Shared-Request-Type: flex|priority`（附带 `X-Vertex-AI-LLM-Request-Type: shared`，即纯 PayGo、不走预留吞吐）实现，与 `?key=` 鉴权兼容。
- 档位与区域组合不满足上表时，请求前 fail-loud（`INVALID_REQUEST`），错误信息指明该改哪个设置。
- **模型级限制**：`gemini-4-argon` 只提供 Standard PayGo 与 Priority PayGo（另有 Provisioned Throughput 与 Batch，固定配额不支持），Google 模型卡的消费选项里没有 Flex；因此 `flex` + Argon 组合也会在请求前以 `INVALID_REQUEST` 拒绝，并提示改用 standard 或 priority。
- **验证档位生效**：Google 在响应的 `usageMetadata.trafficType` 里回传实际档位（`ON_DEMAND_FLEX` / `ON_DEMAND_PRIORITY`；standard 为 `ON_DEMAND`）。选择非 standard 档位时，每次响应都会在 Host 日志输出 `google-cloud: request served with trafficType …`，可直接对照确认。
- 限制（来自 Google 文档）：两个档位均处于 Preview 阶段；flex 模式下整个请求载荷有 20 MB 上限（长对话多图时注意，插件默认图片预算 20 MiB base64 在 flex 下可能触顶）；flex 的超时上限 30 分钟。

## 能力与语义

- **模型目录**：内置 Vertex 上的 Gemini 系列（4 Argon、3.x flash、3.1 pro、2.5 系、`gemini-flash-latest` 等），目录仅供参考，任何端点认识的模型 id 都可直接使用。
- **工具调用**：Gemini 3+ 模型带 tool-call id 并接受完整 JSON Schema（`parametersJsonSchema`）；2.5 系走 OpenAPI 子集（`parameters`）。
- **思考等级**：minimal / low / medium / high 映射到 `thinkingLevel`（Gemini 3）或 `thinkingBudget`（Gemini 2.5）。
- **思考签名**：`thoughtSignature` 经适配器私有回放信封随 assistant 历史回传（限同一 provider/model），缺失时优雅降级。
- **图片**：用户消息与工具结果中的图片经 attachment 服务规范化后按路由目标（总像素 2048×2048、单图编码 1 MiB）生成确定性请求版本并以 `inlineData` 发送；请求图片总量超出每请求 20 MiB（base64 计）上限时，适配器以 `IMAGE_OFFLOAD_REQUIRED` 报告还需省略多少张最旧的图片，由 `dsh-compaction-image-offload` 记录并重试，已在历史中标记 `offloaded` 的图片一律替换为统一占位文本。system/assistant 消息中的图片以 `UNSUPPORTED_CONTENT` 拒绝。
- **生图**：工具 `generate_image` 调用 Gemini 图像模型或 Imagen 4，图片写入 attachment 服务后以图片块返回，详见下文「生图工具」。
- **错误与重试**：429→`RATE_LIMIT`、401/403→`AUTH`、5xx→`SERVER`、400→`INVALID_REQUEST`、404→`MODEL_NOT_FOUND`，遵循 harness 默认重试策略；凭据缺失在请求前 fail-loud（`MISSING_CREDENTIAL`）。

## 配置界面说明

本插件内置 DSH Web Client 界面支持，可以直接在 DSH UI 中可视化修改配置与凭据：

1. **方式一（插件配置页）**：打开 **设置 -> 插件 ->（本插件条目 -> 展开配置）**，即可修改 API 密钥、区域、项目 ID、PayGo 档位、端点与超时时间，支持草稿暂存、保存、放弃与恢复默认。该页面同时在本插件条目旁提供一行摘要（模式 / 区域 / 档位）。
2. **方式二（模型设置页）**：打开 **设置 -> 模型**，在 **Google Vertex AI** 卡片上点击「⚙️ 配置 Vertex AI 参数」即可展开就地配置抽屉。
3. **方式三（配置文件）**：直接编辑 profile 的 `cordis.patch.yml` 中该条目的 `config:` 块（见上文「配置」）。

## 生图工具（generate_image）

插件注册一个模型可见的工具 `generate_image`，用 Vertex 上的 Gemini 图像模型或 Imagen 4 生图，并把图片**直接显示在对话里**。

### 为什么生图只能做成工具

DSH 运行时的流式块只有 `text` / `reasoning` / `tool-call` 三种，模型元信息里没有 `outputModalities`，assistant 消息也不能携带图片块；图片唯一合法的入口是用户消息与**工具结果**。因此：

- 图像模型**不会**出现在聊天模型选择器里（`listModelsForRegion` 只列聊天模型）。把它加进去只会让用户选中后收到空回复，因为响应里的 `inlineData` 不属于聊天翻译层。
- 工具结果图片是一等公民：`output.render()` 返回 `[{type:'text'},{type:'image',attachment}]`，客户端（chat / trajectory / primitives）直接渲染。
- 与内置 `read_image` 不同，本工具**不做**「当前路由必须声明图片输入」的门禁：文字模型路由下运行时会把图片自动降级为占位文本，用户仍然看得到图，模型读到的是文字信封。

### 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 图片描述，原样发送；建议写清主体、构图、风格与要渲染的文字 |
| `model` | 否 | 图像模型 id，默认取 `imageModel` 设置 |
| `aspect_ratio` | 否 | `1:1` / `16:9` / `9:16` / `4:3` / `3:4`，默认取 `imageAspectRatio` 设置 |
| `count` | 否 | 生成张数 1–4，默认取 `imageCount` 设置；**按张计费**，超出 4 张会 fail-loud 而不是静默截断 |

### 两个模型族的线格式

| 族别 | 端点 | 批量 | 实测输出 |
| --- | --- | --- | --- |
| `gemini`（Gemini 图像模型） | `…/models/{id}:generateContent`，请求带 `generationConfig.responseModalities: ["TEXT","IMAGE"]` | 不支持 `candidateCount`（400 `Only one candidate is supported for audio or image response`），插件改为每张一次请求 | PNG（2.5 Flash、3.1 Flash、3 Pro）；Flash-Lite 为 JPEG |
| `imagen`（Imagen 4） | `…/models/{id}:predict` | `instances[].prompt` + `parameters.sampleCount`，一次请求出多张 | PNG |

两个族别的鉴权、端点推导、归属头与 `tier` 头都复用聊天适配器同一份实现（`lib/vertex-request.js`）。响应里的 `mimeType` 决定落到 attachment 服务的媒体类型，解析器不硬编码 PNG。

### 实测记录（2026-10-01，使用本机受管凭据 `GOOGLE_CLOUD_API_KEY`，region `global`）

- **可用 id**：`gemini-2.5-flash-image`、`gemini-3.1-flash-image`、`gemini-3-pro-image`、`gemini-3.1-flash-lite-image`；`gemini-2.5-flash-image-preview`、`gemini-3-flash-image(-preview)`、`gemini-3.5/3.6/3.7/3.8-flash-image`、`gemini-flash-image-latest` 均为 404。
- `gemini-2.5-flash-image`（默认）实际返回 1024×1024 PNG（约 164 KB–712 KB），并常附带一段文字说明；`gemini-3-pro-image` 返回 1024×1024 PNG；`gemini-3.1-flash-lite-image` 返回 JPEG。
- `imageConfig.aspectRatio` 生效：`9:16` → 768×1344、`4:3` → 1184×864。
- `imagen-4.0-generate-001` / `imagen-4.0-fast-generate-001` / `imagen-4.0-ultra-generate-001` 在 global 端点与该 key 对应项目下**全部 404**（`Publisher model … was not found or your project does not have access to it`），带项目路径的区域端点同样 404。因此 Imagen 路径已按官方 `:predict` 线格式实现，但**尚无实测通过证据**；换用有 Imagen 配额的项目/区域后再验证。
- `tier` 头照常发送：`flex` 对 `gemini-3-pro-image` 实测被接受（`trafficType: ON_DEMAND_FLEX`），但对 `gemini-2.5-flash-image` 返回 400 `Flex API is not supported for project … or selected region`。插件不做静默降级：该 400 映射为 `INVALID_REQUEST`，错误信息里点名 `tier` 设置并给出改法。

### 图片落盘位置

图片字节经 attachment 服务归一化后写入内容寻址存储（`<DSH home>/attachments/v1/objects/…`）；工具结果的文字信封给出该文件的**宿主机绝对路径**，可直接打开，同时对话里以内联图片块渲染。响应低于部署上限时字节原样落盘（不重新编码）。

## 开发与验证

```sh
npm test        # node --import ./test/harness-loader.mjs --test test/*.test.mjs
```

> `--test test/`（传目录）在 Node 22 上会以 `ERR_UNSUPPORTED_DIR_IMPORT` 失败，必须传 glob（`test/*.test.mjs`）。

### 打包发布物

```sh
npm pack --pack-destination dist   # 生成 dist/dsh-plugin-google-cloud-<version>.tgz
```

包内只包含 `package.json#files` 列出的内容（`lib/*.js`、`cordis.patch.yml`、`README.zh.md`）。打包产物（`**/dist/*.tgz`）不纳入版本库，可随时从源码重建。

`test/harness-loader.mjs` 让测试从**当前安装的 DSH 运行时**解析 `@deepseek-ai/*`（默认 `C:\Program Files\DSH Desktop\resources\app\node_modules`，可用 `DSH_APP_MODULES` 覆盖），因此测试跑的是插件在实际宿主里会拿到的那一份模块实例；未安装该运行时则回退到本地依赖树。

逐文件运行（本仓库验证时使用的方式，避免 `node --test` 在受限环境下的子进程问题）：

```sh
node --import ./test/harness-loader.mjs test/adapter.test.mjs
node --import ./test/harness-loader.mjs test/convert.test.mjs
node --import ./test/harness-loader.mjs test/catalog.test.mjs
node --import ./test/harness-loader.mjs test/endpoint.test.mjs
node --import ./test/harness-loader.mjs test/imagegen.test.mjs
node --import ./test/harness-loader.mjs test/settings.integration.test.mjs
node --import ./test/harness-loader.mjs test/plugin.integration.test.mjs
node --import ./test/harness-loader.mjs test/client.test.mjs
node --import ./test/harness-loader.mjs test/manifest.test.mjs
```

测试覆盖：请求/流式线格式与错误映射（`adapter`、`convert`、`endpoint`、`catalog`）、生图工具的线格式/解析/拒绝路径与内容块（`imagegen`，离线 stub 传输）、真实 `@deepseek-ai/dsh-settings` 的配置描述与写入（`settings.integration`）、真实 Cordis 上下文 + `LlmRuntime` + `ToolRuntime` + 真实 `LocalAttachmentStore` 的完整注册、端到端取流与一次真实落盘的生图调用（`plugin.integration`）、客户端 bundle 的槽位注册与渲染（`client`），以及清单兼容性声明——直接调用运行时的 `evaluatePluginCompatibility` 判定本插件在**当前装着的这一版 DSH** 上不会被拒绝加载（`manifest`）。

## 已知边界

- 支持快速模式（API Key）与完整模式（Service Account JSON）；系统级 gcloud CLI 环境 ADC 模式暂需直接提供 JSON 或设置 GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON。
- 模型目录是内置推荐列表，任何线上可用模型均可直接填入或选择。
- `GenerateOptions.sessionId` / `purpose` 不映射到线上字段。
- 图片计费仍走 token meter 的通用估算（未实现按图片尺寸的 `imageRequestPricing`）；生图按张计费，工具自身不记账，只把张数上限限制在 4 张。
- 生图宽高比只暴露实测可用的 5 种（`1:1` / `16:9` / `9:16` / `4:3` / `3:4`）；其它比例（如 `21:9`）未在参数 schema 中开放。
- Imagen 4 的 `:predict` 路径已实现，但当前凭据/项目下未取得实测通过证据（见「生图工具 > 实测记录」）。
- 生图会真实计费，且不受插件侧配额限制；如需会话级上限，请在 agent 侧用工具权限或提示词约束。

## 致谢

- [TauriTavern](https://github.com/Darkatse/TauriTavern) —— 其 Vertex AI 适配器验证了快速模式与服务账号完整模式的线格式与鉴权方式，本插件的请求实现以此为参照。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 提供了插件化运行时与 LLM 服务契约。
