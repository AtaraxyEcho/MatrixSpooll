# AnyFast 本地 Mock

这个 Mock 用来在没有 AnyFast 额度时验证 ArcReel 的请求、异步任务轮询、错误处理和素材引用流程。它是独立的本地工具，不会被生产应用自动挂载，也不会向 `www.anyfast.ai` 发起请求。

## 启动

在项目根目录运行：

```bash
uv run uvicorn scripts.mock_anyfast:app --host 127.0.0.1 --port 1242
```

默认 API Key 是 `mock-anyfast-key`。在 ArcReel 的自定义供应商配置中，将兼容端点的 Base URL 指向 `http://127.0.0.1:1242`，API Key 填入上述值；不要把这个地址写入生产配置。

也可以通过环境变量修改：

```bash
ARCREEL_MOCK_ANYFAST_API_KEY=local-key
ARCREEL_MOCK_ANYFAST_SCENARIO=success
uv run uvicorn scripts.mock_anyfast:app --host 127.0.0.1 --port 1242
```

## 覆盖的接口

| 接口 | Mock 行为 |
| --- | --- |
| `POST /v1/chat/completions` | 返回 OpenAI Chat Completions 结构和确定性的助手文本 |
| `POST /v1/images/generations` | 返回 1x1 PNG 的 `b64_json`，不需要额外下载 |
| `POST /v1/audio/speech` | 返回短 PCM WAV，覆盖配音调用的二进制响应 |
| `POST /v1/video/generations` | 接受 Seedance 文本、图片、视频、音频内容，返回 `id/task_id` |
| `GET /v1/video/generations/{id}` | 按轮询推进 `NOT_START → IN_PROGRESS → SUCCESS`，成功返回 `result_url` |
| `POST /kling/v1/videos/{text2video,image2video,multi-image2video}` | 返回 Kling 任务创建结构 |
| `GET /kling/v1/videos/{endpoint}/{id}` | 返回 Kling `task_status` 和 `task_result.videos[0].url` |

Seedance 请求会校验 `content` 中的资源角色。`first_frame` 和 `last_frame` 各最多一个；时长按模型族校验：`seedance-2.0` 为 4–15 秒，包含 `2.5` 的模型为 4–30 秒；比例和分辨率也会拒绝未知值。这一层只模拟 AnyFast 的 HTTP 契约，ArcReel 自身的能力注册表和入队校验仍然是另一层职责。

## 场景控制

启动时可以设置全局场景：

| `ARCREEL_MOCK_ANYFAST_SCENARIO` | 行为 |
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
uv run python -m pytest tests/test_anyfast_mock.py -q
```

测试使用确定性的 PNG/WAV/MP4 占位字节。视频占位内容只用于验证下载、状态和错误路径，不保证可以被 ffmpeg 播放或拼接；涉及真实编解码、字幕烧录或片段合并时，仍需使用项目已有的媒体构造夹具或真实供应商沙箱。

## 文档依据

- [AnyFast API Introduction](https://docs.anyfast.ai/api-reference/introduction)：Base URL、Bearer 鉴权、端点、错误 envelope 和 HTTP 状态码。
- [Seedance 2.0](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0)：`content` 资源角色、异步创建结构、比例/分辨率/时长约束。
- [Seedance Task Query](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-task-query)：轮询状态、`result_url` 和失败字段。
- [Kling 3.0 Text to Video](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v3-t2v)：Kling 创建和查询响应结构。
