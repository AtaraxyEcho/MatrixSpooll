# AnyFast 智能体协议兼容性调研

> 调研日期：2026-08-27
> 范围：AnyFast 的 Anthropic Messages、OpenAI Chat Completions、`deepseek-v4-flash`，以及 MatrixSpooll 的 Claude Agent SDK 运行时兼容边界。
> 本文只记录官方契约与实施建议，不把第三方 API 正文复制进仓库。

## 结论

当前错误：

> `There's an issue with the selected model (deepseek-v4-flash). It may not exist or you may not have access to it.`

首要根因是**协议与模型不匹配**，而不是模型名称拼错：

- AnyFast 的 `deepseek-v4-flash` 专属 OpenAPI 明确声明模型 ID 为 `deepseek-v4-flash`，请求端点为 `POST https://www.anyfast.ai/v1/chat/completions`，即 OpenAI Chat Completions 协议。[AnyFast `deepseek-v4-flash` API](https://docs.anyfast.ai/api-reference/model-api/deepseek/deepseek-v4-flash.md)
- AnyFast 的 Anthropic 兼容端点是 `POST https://www.anyfast.ai/v1/messages`；其 OpenAPI 当前只枚举 Claude 型号，没有 `deepseek-v4-flash`。[AnyFast Anthropic endpoint OpenAPI](https://docs.anyfast.ai/api-reference/endpoints/openapi/anthropic/openapi.yaml)
- MatrixSpooll 当前把凭证写入 `ClaudeAgentOptions.env`，由 Claude Agent SDK/Claude Code CLI 调用 Anthropic Messages；改变 `ANTHROPIC_BASE_URL` 只会改变 Messages 请求发往哪里，不会把 Messages 自动转换为 OpenAI Chat Completions。Anthropic 对 LLM gateway 的要求也明确：Claude Code 面向网关时需要 Anthropic Messages、Bedrock 或 Vertex 格式，不把 OpenAI Chat Completions 列为可直接消费的格式。[Claude Code LLM gateway requirements](https://code.claude.com/docs/en/llm-gateway)

因此，把 AnyFast 根地址和 `deepseek-v4-flash` 直接交给 Claude Agent SDK，不是有效接入方式。需要二选一：

1. 在 Claude Agent SDK 与 AnyFast 之间加入 **Anthropic Messages -> OpenAI Chat Completions 协议网关**；或
2. 为 MatrixSpooll 增加独立的 **OpenAI Chat 智能体运行时**，不再由 Claude Agent SDK 承载这类模型。

就当前代码体量与功能保真度而言，建议先采用协议网关，长期再评估双运行时。不能只把请求路径从 `/v1/messages` 改成 `/v1/chat/completions`，因为请求、响应、SSE 和工具调用结构都不同。

## 1. AnyFast 官方协议契约

### 1.1 端点与基础地址

| 用途 | Base URL / 端点 | 结论 |
|---|---|---|
| AnyFast API 根地址 | `https://www.anyfast.ai` | Bearer 鉴权，JSON 请求。[API Introduction](https://docs.anyfast.ai/api-reference/introduction) |
| OpenAI SDK base URL | `https://www.anyfast.ai/v1` | AnyFast 官方示例通过 `OpenAI(base_url=...)` 使用。[OpenAI-compatible guide](https://docs.anyfast.ai/guides/endpoints/openai) |
| OpenAI Chat Completions | `POST /v1/chat/completions` | AnyFast 文本模型统一 OpenAI 兼容入口。[OpenAI endpoint OpenAPI](https://docs.anyfast.ai/api-reference/endpoints/openapi/openai/openapi.yaml) |
| Anthropic Messages | `POST /v1/messages` | Claude 模型的 Anthropic 兼容入口。[Anthropic endpoint OpenAPI](https://docs.anyfast.ai/api-reference/endpoints/openapi/anthropic/openapi.yaml) |
| OpenAI Responses | `POST /v1/responses` | 当前文档把它列在 Doubao 原生兼容端点下；没有官方证据表明 `deepseek-v4-flash` 支持此端点。[Doubao Responses](https://docs.anyfast.ai/api-reference/endpoints/doubao-responses) |
| 模型发现 | `GET /v1/models` | 返回当前 API Key 可见模型及 `supported_endpoint_types`。[Models list](https://docs.anyfast.ai/guides/system-api/models-list.md) |

`deepseek-v4-flash` 应按 Chat Completions 接入，不应先做 Responses 适配。

### 1.2 `deepseek-v4-flash` 的模型名与能力

AnyFast 的专属 OpenAPI 给出的精确模型名是：

```text
deepseek-v4-flash
```

该模型契约声明：

- 请求：`POST /v1/chat/completions`；
- 消息角色：`system`、`user`、`assistant`、`tool`；
- 流式：`stream=true` 时使用 SSE；
- 工具：OpenAI function tools，支持 `none`、`auto`、`required` 或指定函数；
- 工具结果：`role=tool` 并携带 `tool_call_id`；
- 响应工具调用：`choices[].message.tool_calls[]`；
- 思考：支持 `thinking.type` 和 `reasoning_effort`，思考文本在 `reasoning_content`；
- JSON 模式：`response_format.type=json_object`；
- `frequency_penalty`、`presence_penalty` 虽可透传，但官方标记为对 DeepSeek 无效果。

来源：[AnyFast `deepseek-v4-flash` OpenAPI](https://docs.anyfast.ai/api-reference/model-api/deepseek/openapi/deepseek-v4-flash/openapi.yaml)

### 1.3 鉴权、流式与错误结构

两个协议都使用：

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

但 wire schema 不同：

| 能力 | OpenAI Chat | Anthropic Messages |
|---|---|---|
| system 指令 | `messages[].role=system` | 顶层 `system` |
| 工具声明 | `tools[].type=function` + `function.parameters` | `tools[].name` + `input_schema` |
| 工具调用 | `message.tool_calls[]` | `content[].type=tool_use` |
| 工具结果 | `role=tool` + `tool_call_id` | 用户内容块 `type=tool_result` |
| 流式 | SSE chat completion chunks | SSE Anthropic message/content block events |
| 成功响应 | `choices[]` + OpenAI usage | `content[]` + `stop_reason` + Anthropic usage |
| 错误 | `{"error":{"message","type","code"}}` | `{"type":"error","error":{"type","message"}}` |

AnyFast 的通用错误文档列出 `400/401/403/404/429/500`，并建议对 `429` 使用指数退避。[API Introduction](https://docs.anyfast.ai/api-reference/introduction)

## 2. 文档与账号能力的判定边界

AnyFast 文档当前有轻微漂移：通用 OpenAI endpoint 的静态枚举可能尚未列出刚上线的 `deepseek-v4-flash`，但文档总索引和该模型的专属 OpenAPI 已包含它。因此实现中不应把通用页面里的静态枚举固化成唯一模型白名单。

运行时应以当前 API Key 的：

```http
GET https://www.anyfast.ai/v1/models
Authorization: Bearer <key>
```

为准，并读取每个模型的 `supported_endpoint_types`。AnyFast 明确说明，不同 Key 因渠道配置和计价覆盖不同，返回的模型列表可能不同。[Models list](https://docs.anyfast.ai/guides/system-api/models-list.md)

所以错误中“可能无权访问”的部分仍需单独排除：

1. `/v1/models` 是否返回 `deepseek-v4-flash`；
2. 该记录的 `supported_endpoint_types` 是否包含 `openai`；
3. AnyFast 控制台是否启用了对应渠道；AnyFast Quickstart 明确要求先启用模型对应渠道。[AnyFast Quickstart](https://docs.anyfast.ai/quickstart)

即使账号有权限，也不能据此把该模型直接送入 Anthropic `/v1/messages`。

## 3. 当前 MatrixSpooll 的根因定位

当前智能体不是“通用 LLM 客户端”，而是 Claude Agent SDK harness：

- `server/agent_runtime/options_assembler.py::OptionsAssembler.build` 固定构造 `ClaudeAgentOptions`，并使用 `claude_code` system prompt preset、hooks、sandbox、MCP server、SDK SessionStore；
- `server/agent_runtime/session_manager.py::SessionManager` 固定构造 `ClaudeSDKClient`，消息序列化也以 `AssistantMessage`、`ResultMessage`、`StreamEvent` 等 Claude SDK 类型为输入；
- `lib/config/service.py::build_anthropic_env_dict` 只输出 `ANTHROPIC_*` 环境变量；
- `lib/config/anthropic_probe.py` 会主动验证返回是否为 Anthropic `type=message` 结构；
- `server/agent_runtime/sdk_tools/` 的业务工具通过 Claude SDK 的 in-process MCP server 注册。

这意味着当前会话、恢复、分叉、权限钩子、沙箱、工具调用、transcript 镜像和 SSE 展示都依赖 Claude Agent SDK 的消息模型。仅替换 HTTP client 会破坏这些契约。

Anthropic 官方允许通过 `ANTHROPIC_BASE_URL` 指向自定义网关，但该网关至少要对客户端暴露 Anthropic Messages 的 `/v1/messages` 与 `/v1/messages/count_tokens`，并正确转发/处理 Anthropic beta 和 version 字段。[Claude Code LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway) `ANTHROPIC_BASE_URL` 只改变采样 API 地址。[Claude Code environment variables](https://code.claude.com/docs/en/env-vars)

AnyFast 当前公开的 Anthropic OpenAPI只声明 `/v1/messages`，且只枚举 Claude 模型；未看到 `deepseek-v4-flash` 的 Anthropic Messages 契约，也未看到 AnyFast 对 `/v1/messages/count_tokens` 的公开声明。故不能把 AnyFast 的 OpenAI endpoint 当作 Claude Agent SDK 的自定义 base URL 直接使用。

## 4. 推荐兼容方案

### 4.1 第一阶段：协议网关，保留现有 Claude Agent SDK

在 MatrixSpooll 与 AnyFast 之间加入只在服务端可见的协议适配层：

```text
MatrixSpooll Claude Agent SDK
        |
        | Anthropic Messages
        v
Agent Protocol Gateway
        |
        | OpenAI Chat Completions
        v
AnyFast /v1/chat/completions
        |
        v
deepseek-v4-flash
```

配置关系：

- `ANTHROPIC_BASE_URL` 指向协议网关，不再直接指向 AnyFast；
- Claude Agent SDK 仍只看到 Anthropic Messages；
- 网关持有或安全读取 AnyFast Key，向上游发送 Bearer token；
- 网关的上游 base URL 为 `https://www.anyfast.ai/v1`；
- 网关只部署在 loopback/Docker 内网，不公开管理端口。

网关必须覆盖的转换：

1. 顶层 `system` 与 Anthropic content blocks 转成 OpenAI messages；
2. Anthropic `tools/input_schema` 转成 OpenAI functions；
3. `tool_use` / `tool_result` 与 `tool_calls` / `role=tool` 双向转换；
4. OpenAI SSE chunks 转成 Anthropic message/content block SSE 事件；
5. `stop_reason`、usage、错误 envelope 的转换；
6. `/v1/messages/count_tokens` 的实现或可验证兼容降级；
7. `anthropic-version`、`anthropic-beta`、Claude Code 专用 header 的容错；
8. 客户端断开时取消上游流，避免继续计费；
9. 未能无损映射的 thinking、prompt cache、图片块和 beta 内容必须显式降级或拒绝，禁止静默丢字段。

不建议临时手写一个只改字段名的转换器。工具循环与流式事件是当前 Agent 功能的核心，半兼容实现会出现“普通聊天成功、调用工具后卡住或会话损坏”的问题。

可先对成熟 LLM gateway 做隔离验证，再决定是作为固定版本的部署依赖，还是抽取所需能力做自有轻量网关。Anthropic 官方文档以 LiteLLM 的 Anthropic format endpoint 作为网关示例，但同时明确其为第三方软件、不由 Anthropic 审计或维护；选择时需要固定版本、生成 SBOM、扫描依赖并避免官方文档点名的受污染版本。[Claude Code LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway)

### 4.2 第二阶段：运行时协议抽象

在确认确实需要长期支持多家 OpenAI-compatible 模型后，再把智能体层拆成运行时协议：

```text
AgentSessionService
  -> AgentRuntime (create/send/stream/interrupt/resume)
       -> ClaudeAgentRuntime
       -> OpenAIChatAgentRuntime
```

关键点：

- 会话创建时固定 `runtime_kind + provider_id + model_id + protocol`，禁止恢复会话时静默换协议；
- UI 的模型发现保留 `supported_endpoint_types`，按运行时过滤，而不是只存 model ID；
- 把 `sdk_tools` 的业务处理函数和 JSON Schema 提取成运行时无关的 tool catalog，再分别适配 Claude MCP 与 OpenAI functions；
- 统一内部事件模型，Claude SDK message 和 OpenAI chunk 都转换成同一种 UI/SSE 事件；
- OpenAI 运行时自行持久化 messages/tool calls，不复用 Claude SDK transcript 身份；
- 权限校验、项目边界和审计必须放在运行时无关层，不能只依赖 Claude hooks；
- OpenAI Chat 模型的 resume 是由服务端重放历史实现，不应假装等同于 Claude SDK 原生 resume/fork。

这条路线的开发量明显高于协议网关，因为必须重新提供 Claude Code harness 当前已有的工具编排、权限、沙箱、会话恢复、分叉和消息归一能力。除非需要让大量非 Claude 模型成为一等智能体运行时，否则不建议作为紧急修复。

## 5. 配置与 UI 调整建议

无论采用哪条路线，配置模型都不应继续只有 `base_url + model`：

| 字段 | 建议值 |
|---|---|
| `protocol` | `anthropic_messages` / `openai_chat` |
| `runtime_kind` | `claude_sdk` / `openai_agent`；第一阶段网关仍为 `claude_sdk` |
| `provider` | AnyFast 等供应商身份 |
| `base_url` | 与所选协议匹配的根地址 |
| `model_id` | `/v1/models` 返回的精确 ID |
| `supported_endpoint_types` | 模型发现结果，至少保留 `openai` / `anthropic` |

选择模型时：

- Claude SDK 直连只展示支持 `anthropic` 的模型；
- OpenAI runtime 只展示支持 `openai` 的模型；
- 协议网关模式可以选择 OpenAI 模型，但必须明确标识“经兼容网关”；
- 配置保存前做最小真实请求，不只调用 models list；
- 对文档有记录、当前 Key 不可见的型号显示“当前凭证不可用”，不要笼统显示“模型不存在”。

## 6. 验证与验收

### 6.1 配置前诊断

使用当前 AnyFast Key 执行：

```bash
curl https://www.anyfast.ai/v1/models \
  -H "Authorization: Bearer $ANYFAST_API_KEY"
```

验收：返回 `deepseek-v4-flash`，并确认 `supported_endpoint_types`。

再直接验证 OpenAI Chat：

```bash
curl https://www.anyfast.ai/v1/chat/completions \
  -H "Authorization: Bearer $ANYFAST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Reply with OK"}],"stream":false}'
```

若这一步失败，先处理 AnyFast Key、余额、渠道或型号可见性，不能归因到 MatrixSpooll。

### 6.2 网关契约测试

最低测试矩阵：

| 场景 | 必须验证 |
|---|---|
| 单轮文本 | system + user 正确转换，终态正常 |
| 多轮文本 | assistant 历史不丢失，不重复 system |
| SSE | 文本增量、结束事件、usage、客户端取消 |
| 单工具 | tool schema、tool call ID、结果回填 |
| 连续工具 | 多轮 tool loop 不死锁、不重复执行 |
| 并行工具 | 模型返回多个 `tool_calls` 时身份对应正确 |
| 错误 | 400/401/403/429/500 映射为稳定错误码且保留 request ID 到日志 |
| 超时/重试 | 只重试未开始输出的幂等请求，不能重复已执行工具 |
| thinking | 支持时正确展示；不支持时显式关闭，不把 reasoning 混进最终文本 |
| 会话恢复 | 服务重启后继续对话，工具上下文与项目身份不漂移 |

### 6.3 MatrixSpooll 回归

- Claude 官方/Anthropic-compatible 现有凭证仍走原路径；
- `deepseek-v4-flash` 普通回复、MCP 工具、项目文件修改、生成任务入队均能完成；
- interrupt、SSE 重连、会话关闭、分支/改写按声明的兼容等级工作；
- 工具权限、项目成员权限、沙箱和密钥剥离不因网关绕过；
- 使用量记录区分“模型供应商 AnyFast”与“运行时 Claude SDK/协议网关”。

## 7. 明确不采用的方案

1. **只把 `ANTHROPIC_MODEL` 改成 `deepseek-v4-flash`**：端点仍是 `/v1/messages`，模型协议不匹配。
2. **只把 base URL 尾部改成 `/v1`**：Claude SDK 会继续拼 Anthropic 路径，且可能形成错误路径。
3. **把 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 注入现有 `ClaudeAgentOptions.env`**：当前 MatrixSpooll 与 Anthropic 官方网关契约都没有证明这会让 Claude Agent SDK 切换到 Chat Completions。
4. **复用 MatrixSpooll 的 `OpenAITextBackend` 代替 Agent runtime**：该 backend 负责单次文本生成，不提供 Claude SDK 的会话、工具、hooks、sandbox、resume/fork 与事件模型。
5. **在前端直连 AnyFast**：会暴露 API Key，也绕过权限、审计、限流和错误治理。

## 最终建议

先做两步：

1. 立即在配置端阻止把只支持 `openai` 的模型保存到 Anthropic 直连运行时，并用 `/v1/models.supported_endpoint_types` 给出明确错误；
2. 用隔离的 Anthropic-to-OpenAI 协议网关完成 `deepseek-v4-flash` 的最小可行接入，验收工具调用、SSE、取消和多轮会话后再开放给用户。

若后续需要将 GPT、DeepSeek、Qwen、Gemini 等都作为长期一等智能体模型，再实施运行时抽象；不要为了一个型号立刻重写整个 Agent harness。
