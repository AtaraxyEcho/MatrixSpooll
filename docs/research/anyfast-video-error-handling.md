# AnyFast 视频生成错误处理研究

> 研究日期：2026-08-20  
> 范围：AnyFast `POST /v1/video/generations`、Seedance 任务查询，以及火山方舟 / BytePlus ModelArk 的视频生成错误。  
> 来源原则：只引用 AnyFast、火山引擎和 BytePlus 的第一方文档。运行日志仅作为“实际观察”，不冒充公开契约。

## 结论

1. 当前 `400` 的具体原因不应被外层 `fail_to_fetch_task` 覆盖。实际响应的 `message` 是一段 JSON 字符串，其中包含更具体的下游错误 `InputImageSensitiveContentDetected.PrivacyInformation`，以及“指定输入图片可能包含真人”的说明。用户提示应优先使用这个内层原因。
2. AnyFast 公开文档没有定义 `fail_to_fetch_task`，也没有定义 `InputImageSensitiveContentDetected.PrivacyInformation` 或 `PrivacyInformation` 后缀。火山方舟只公开了基础码 `InputImageSensitiveContentDetected`，含义是输入图像可能包含敏感信息、应更换后重试。
3. “可能包含真人”来自这次实际错误消息，不是对图片内容的客观确认。官方资料不能证明图片确有真人，也不能证明触发原因是“过于写实”或误判。
4. 同一集成有两条失败通道：创建请求可直接返回非 `2xx`；任务创建成功后，查询接口仍可能以 HTTP `200` 返回 `data.status = FAILURE`，具体原因位于 `data.fail_reason`。两条通道都必须保留供应商原因。
5. 合规的当前用户提示应是：“输入图片被供应商判定为可能包含真人肖像或隐私信息，请更换对应图片；如使用已获授权的真人素材，请改用供应商支持的真人验证 / 授权素材流程。”不应只显示“生成失败”，也不应建议绕过审核。

## 来源与证据等级

本文使用三个证据等级：

- **官方事实**：公开页面明确声明，可作为稳定的错误分类依据。
- **实际观察**：本次日志中确实出现，但不在官方公开契约中；解析器需要兼容，不能假设长期稳定。
- **推断**：由响应结构和请求上下文得出，必须保留条件，不能写成供应商承诺。

### AnyFast 官方契约

- [API Introduction](https://docs.anyfast.ai/api-reference/introduction) 声明错误响应使用 `error` 对象，字段为 `message`、`type`、`code`；HTTP 状态表将 `400` 概括为参数错误。
- [Seedance 2.0 创建接口](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0) 为 `POST /v1/video/generations` 的 `400` / `401` 只展示 `error.code` 和 `error.message`，因此 `type` 应按可选字段处理。成功响应返回任务标识，供后续查询。
- [Seedance Task Query API](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-task-query) 定义 `GET /v1/video/generations/{id}` 的成功 envelope 为 `code`、`message`、`data`。
- [Seedance Task Query 指南](https://docs.anyfast.ai/guides/model-api/bytedance/seedance-task-query) 明确规定外层 `data.status = FAILURE` 时读取 `data.fail_reason`；失败示例仍由 HTTP 成功响应承载。`data.data` 是上游原始输出，其小写状态与外层大写状态不是同一字段。
- [Seedance 2.0 指南](https://docs.anyfast.ai/guides/model-api/bytedance/seedance-2-0) 说明进度到达 100% 后仍失败时，可能是供应商内容审核拦截，例如名人肖像或版权内容，建议修改提示词或更换参考图；该页面未给出具体审核错误码。
- [AnyFast 真人资产验证指南](https://docs.anyfast.ai/guides/model-api/bytedance/volc-real-human-assets) 提供获授权真人肖像的验证和资产流程。它只支持“提示用户走合规素材流程”，不能反向证明某个未公开错误码的固定含义。

### 原始下游官方契约

- [火山方舟：创建视频生成任务](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) 公开以下视频生成错误：
  - `InputImageSensitiveContentDetected`：输入图像可能包含敏感信息，请更换后重试；HTTP `400`。
  - `InputTextSensitiveContentDetected`：输入文本可能包含敏感信息，请更换后重试；HTTP `400`。
  - `OutputVideoSensitiveContentDetected`：生成视频可能包含敏感信息，请更换输入内容后重试；HTTP `400`。
- [火山方舟：查询视频生成任务](https://api.volcengine.com/api-docs/view?action=GetContentsGenerationsTask&serviceCode=ark&version=2024-01-01) 定义任务失败时返回 `error.code` 和 `error.message`，并展示了内容审核失败的任务响应。
- [火山方舟视频生成 API](https://www.volcengine.com/docs/82379/1520757?lang=zh) 和 [BytePlus ModelArk 同源接口文档](https://docs.byteplus.com/en/docs/modelark/1520757) 说明 Seedance 2.0 系列不支持直接上传包含真人人脸的参考图片或视频，并提供已授权真人资产、预置数字人等合规路径。
- [BytePlus 私有真人资产库指南](https://docs.byteplus.com/en/docs/modelark/2333589) 说明真人肖像资产需要真人验证和肖像权授权，并以专用资产形式用于生成。

## 当前响应的分层解释

以下只保留结构和错误标识，不记录 API Key、完整提示词、素材 URL 或请求 ID：

```json
{
  "code": "fail_to_fetch_task",
  "message": "{\"error\":{\"code\":\"InputImageSensitiveContentDetected.PrivacyInformation\",\"message\":\"... input image 'content[1]' may contain real person ...\",\"type\":\"BadRequest\"}}",
  "data": null
}
```

| 层级 | 观察值 | 证据性质 | 应如何使用 |
|---|---|---|---|
| HTTP | `400` | 实际观察；AnyFast 通用文档仅笼统定义为 bad request | 不自动重试；继续解析响应体 |
| AnyFast 外层 | `code = fail_to_fetch_task` | 未公开 | 只作为平台级诊断码；不能覆盖内层具体原因 |
| AnyFast 外层 | `message` 为 JSON 字符串 | 未公开，且与创建接口公开的 `error` envelope 不一致 | 若是有效 JSON，安全地解析一层 |
| 下游内层 | `InputImageSensitiveContentDetected.PrivacyInformation` | 完整码未公开；基础码由火山方舟公开 | 用基础码归类为输入图片审核失败，保留完整码供诊断 |
| 下游内层 | `content[1]` 可能包含真人 | 实际观察 | 按本次提交的 `content` 数组查回素材角色，再生成用户可读标签 |
| 任务标识 | 响应未返回 `id` / `task_id` | 实际观察 | 没有可供调用方轮询的 AnyFast 任务；不要进入查询循环 |

### `content[1]` 是否就是首帧

AnyFast 创建接口将输入定义为 `content[]`，每个媒体项可带 `first_frame`、`last_frame`、`reference_image` 等角色。错误消息中的 `content[1]` 是数组路径，但官方没有承诺固定位置永远对应某个角色。

在“文本位于 `content[0]`、首帧位于 `content[1]`”的这次请求结构下，可以把它显示为“首帧”。实现时应从已提交请求体按下标取回该项的 `type` 和 `role`，不能全局硬编码 `content[1] = 首帧`。多模态请求或无文本请求会改变下标。

## 建议的解析优先级

解析器应从具体到宽泛提取，并同时保留原始诊断字段：

1. 非 `2xx` 的标准 AnyFast `error.code`、`error.message`、可选 `error.type`。
2. 非标准外层 `code`、`message`、`data`。若 `message` 是对象或可被解析为 JSON 对象的字符串，提取其中的 `error`。
3. 内层错误的完整 `code`、基础码（第一个 `.` 之前）、细分类后缀、`message`、`param`、`type`。
4. HTTP `2xx` 查询响应中的 `data.status`；当值为 `FAILURE` 或兼容拼写 `FAILED` / `failed` 时提取 `data.fail_reason`，必要时再解析其中的结构化错误。
5. 以上都没有具体原因时，才回退到 HTTP 状态和外层通用消息。

结构化解析应设置长度和嵌套深度上限；解析失败时保留字符串，不用正则拼接或执行其中内容。供应商原始消息用于日志和支持信息，面向用户的文字通过 MatrixSpooll 的 `zh` / `en` / `vi` i18n 映射生成。

## 面向用户的最小错误矩阵

| 识别条件 | 用户含义 | 建议动作 | 自动重试 |
|---|---|---|---|
| 基础码 `InputImageSensitiveContentDetected` | 某张输入图片未通过供应商内容审核 | 显示具体素材角色并要求更换 | 否 |
| 后缀 `PrivacyInformation`，且消息明确提到 real person | 供应商判定该图可能包含真人肖像或隐私信息 | 更换该图；已授权真人改走验证 / 授权资产流程 | 否 |
| `InputTextSensitiveContentDetected` | 输入文本未通过审核 | 修改提示词 | 否 |
| `OutputVideoSensitiveContentDetected` | 生成结果未通过审核 | 调整提示词或参考素材后重新生成 | 否 |
| `QuotaExceeded` | 排队中任务数超过限制 | 稍后重试 | 是，退避 |
| `InvalidParameter` 或明确参数错误 | 请求参数不被模型接受 | 显示可定位的参数，要求调整 | 否 |
| 只有 `fail_to_fetch_task`，没有可解析内层原因 | AnyFast 未能返回可用任务 | 提示供应商提交失败并保留诊断码 | 谨慎；仅在确认请求幂等且无任务 ID 时 |
| HTTP `429` | AnyFast 请求频率受限 | 稍后重试 | 是，指数退避 |
| HTTP `5xx` | 供应商暂时异常 | 稍后重试 | 是，有限次数 |

针对当前响应，在请求上下文确认 `content[1].role = first_frame` 后，建议中文提示为：

> 首帧未通过供应商审核：图片被判定为可能包含真人肖像或隐私信息。请更换首帧；如使用已获授权的真人素材，请改用供应商支持的真人验证或授权资产流程。

需要避免的表述：

- 不要说“图片确定包含真人”；官方和实际消息都只说“可能”。
- 不要说“因为图片过于写实”；没有官方证据支持该因果关系。
- 不要把 `fail_to_fetch_task` 直接翻译成“拉取任务失败”；它出现在创建请求的 `400` 响应中，字面翻译会误导用户。
- 不要只显示 `free_creation_failed`、HTTP `400` 或 `Bad Request`；这些都丢失了可操作原因。
- 不要把“任务查询失败自动退款”的说明套用到创建阶段 `400`；AnyFast 只在任务查询指南中明确承诺失败任务自动退还预扣额度。

## 尚未被官方文档定义的部分

截至研究日期，在 AnyFast 的官方索引、创建接口、任务查询指南和相关 Seedance 指南中，未找到以下公开定义：

- `fail_to_fetch_task` 的触发条件、是否可重试、计费或任务创建语义。
- `InputImageSensitiveContentDetected.PrivacyInformation` 的完整枚举说明。
- `PrivacyInformation` 与真人肖像之间的稳定、机器可依赖的映射。
- `content[n]` 路径如何映射为 AnyFast 的媒体角色。

因此实现应采用“基础码稳定映射 + 实际消息补充细节 + 请求上下文定位素材”的策略。完整供应商码和已脱敏消息应保留在任务诊断信息中，未知细分类仍应向用户展示基础类别和可执行建议，而不是退化为统一的“生成失败”。
