# AnyFast 本地 Mock

这个 Mock 用来在没有 AnyFast 额度时验证 MatrixSpooll 的请求、异步任务轮询、错误处理和素材引用流程。它是独立的本地工具，不会被生产应用自动挂载，也不会向 `www.anyfast.ai` 发起请求。

## 启动

在项目根目录运行：

```bash
uv run uvicorn scripts.mock_anyfast:app --host 127.0.0.1 --port 1242
```

默认 API Key 是 `mock-anyfast-key`。在 MatrixSpooll 的自定义供应商配置中选择 **AnyFast Seedance** 端点，将 Base URL 指向 `http://127.0.0.1:1242`，API Key 填入上述值；不要把这个地址写入生产配置。Kling 兼容端点使用 `http://127.0.0.1:1242/kling`，其协议夹具与 Seedance 端点相互独立。

也可以通过环境变量修改：

```bash
MATRIXSPOOLL_MOCK_ANYFAST_API_KEY=local-key
MATRIXSPOOLL_MOCK_ANYFAST_SCENARIO=success
uv run uvicorn scripts.mock_anyfast:app --host 127.0.0.1 --port 1242
```

## 覆盖的接口

| 接口 | Mock 行为 |
| --- | --- |
| `POST /v1/chat/completions` | 返回 OpenAI Chat Completions 结构和确定性的助手文本 |
| `POST /v1/images/generations` | 返回 1x1 PNG 的 `b64_json`，不需要额外下载 |
| `POST /v1/audio/speech` | 返回短 PCM WAV；这是 MatrixSpooll 配音链的便利夹具，不属于已核对的 AnyFast Seedance 契约 |
| `POST /v1/video/generations` | 接受 Seedance 文本、图片、视频、音频内容，返回 `id/task_id` |
| `GET /v1/video/generations/{id}` | 按轮询推进 `NOT_START → IN_PROGRESS → SUCCESS`，成功返回 `result_url` |
| `POST /kling/v1/videos/{text2video,image2video,multi-image2video}` | 同时返回官方顶层 `task_id` 与 MatrixSpooll 适配器读取的 `data.task_id` |
| `GET /kling/v1/videos/{endpoint}/{id}` | 返回 MatrixSpooll Kling 适配器使用的 `task_status` 和 `task_result.videos[0].url` |

Seedance 请求会校验 `content` 中的资源类型、排列顺序和用途：文本、图片、视频、音频必须依次出现，素材用途必须匹配媒体类型，首尾帧模式不能与参考素材模式混用。`first_frame` 和 `last_frame` 各最多一个，尾帧必须与首帧同时存在，并按模型限制参考图片、视频和音频数量。

时长按模型族校验：`seedance-2.0` 为 4–15 秒，`seedance-2.5` 为 4–30 秒；模型、比例和分辨率也会拒绝未知值。这一层模拟 AnyFast 的 HTTP 契约，MatrixSpooll 自身的能力注册表和入队前校验仍然是独立职责。

Kling 路由是用于 MatrixSpooll 现有 Kling 适配器的兼容夹具，响应同时保留部分官方字段和适配器字段，不作为 AnyFast Kling 响应结构的严格契约测试。

## 场景控制

启动时可以设置全局场景：

| `MATRIXSPOOLL_MOCK_ANYFAST_SCENARIO` | 行为 |
| --- | --- |
| `success` | 默认成功流程 |
| `failure` | 视频第二次轮询进入 `FAILURE` |
| `rate_limit_once` | 第一次请求返回 429，后续请求成功 |
| `server_error` | 请求返回 500 |
| `bad_request` | 请求返回 400 |

单次请求也可以在 JSON 中加入 `mock_scenario`，或在 prompt 中加入 `[mock:failure]`、`[mock:rate_limit_once]`、`[mock:server_error]`、`[mock:bad_request]`，覆盖当前全局场景。

错误响应保持 AnyFast 文档中的 envelope：

```json
{
  "error": {
    "message": "mock upstream failure",
    "type": "mock_error",
    "code": "mock_upstream_error"
  }
}
```

## 示例请求

```json
{
  "model": "seedance-2.0",
  "content": [
    {"type": "text", "text": "林默在雨夜车站回头"},
    {
      "type": "image_url",
      "image_url": {"url": "asset://character-001"},
      "role": "first_frame"
    },
    {
      "type": "image_url",
      "image_url": {"url": "asset://scene-002"},
      "role": "last_frame"
    }
  ],
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 10,
  "generate_audio": true
}
```

## 测试

Mock 不需要打开端口即可通过 ASGI transport 测试：

```bash
uv run python -m pytest tests/test_anyfast_video_backend.py tests/test_anyfast_mock.py tests/server/test_free_creations.py -q
```

测试使用确定性的 PNG、PCM WAV 和短 H.264 MP4。MP4 是可解码媒体，可以用于本地探测和媒体流水线测试；它的时长和画面内容不模拟模型的真实输出质量。

集成用例覆盖自由创作执行函数 → 素材用途映射 → AnyFast 适配器 → 异步 Mock 轮询/下载 → 版本产物和画布元数据写回，并分别验证首帧与“参考图 + 参考音频”路径。它不验证真实供应商计费、审核、外网传输，也不代替任务队列调度、SSE 刷新和真实账号的最小沙箱验证。

## 文档依据

- [AnyFast API Introduction](https://docs.anyfast.ai/api-reference/introduction)：Base URL、Bearer 鉴权、端点、错误 envelope 和 HTTP 状态码。
- [Seedance 2.0](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0)：`content` 资源角色、异步创建结构、比例/分辨率/时长约束。
- [Seedance 2.0 使用指南](https://docs.anyfast.ai/guides/model-api/bytedance/seedance-2-0)：素材顺序、角色组合和输入数量约束。
- [Seedance 2.5](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-5)：2.5 模型的时长、分辨率和首帧比例约束。
- [Seedance Task Query](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-task-query)：轮询状态、`result_url` 和失败字段。
- [Kling 3.0 Text to Video](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v3-t2v)：Kling 创建和查询响应结构。
