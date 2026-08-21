# anyfast

AnyFast 是通过自定义供应商 `anyfast-seedance` endpoint 接入的协议，不是内置 provider id。

- 总入口：[AnyFast API Introduction](https://docs.anyfast.ai/api-reference/introduction)
- 接口与能力：[Seedance 2.0](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0)、[2.0 Fast](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0-fast)、[2.0 Mini](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0-mini)、[2.0 Ultra](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0-ultra)、[Seedance 2.5](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-5)、[任务查询](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-task-query)
- 输入组合：[Seedance 2.0 指南](https://docs.anyfast.ai/guides/model-api/bytedance/seedance-2-0)
- 代码：`lib/custom_provider/endpoints.py::ENDPOINT_REGISTRY["anyfast-seedance"]`、`lib/video_backends/anyfast.py::AnyFastSeedanceBackend`

## 自由创作契约

- 请求按 `text → image_url → video_url → audio_url` 排序，并显式下发 `first_frame`、`last_frame`、`reference_image`、`reference_audio` 角色。
- Seedance 2.0 为 `480p/720p/1080p/4k`、4–15 秒；2.0 Fast/Mini 为 `480p/720p`、4–15 秒；2.0 Ultra 为 `720p/1080p/2k`、4–15 秒且必须填写分辨率；Seedance 2.5 为 `480p/720p/1080p`、4–30 秒。比例、分辨率和引用上限按型号在 backend 中声明或校验。
- Seedance 1.5 Pro 与 1.0 Pro/Fast/Lite 也纳入同一能力表；1.0 原始文档允许 2–12 秒，但自由创作产品统一从 4 秒起，避免和当前画布交互规则冲突。
- ArcReel 的自由创作请求会显式保留 `first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio` 角色。本地参考视频会在提交前编码为带 MIME 类型的 `data:` URI，并以 `video_url` + `role=reference_video` 放入 Seedance 的多模态内容数组；`.mp4` 和 `.mov` 才是允许的容器。大文件仍应优先走项目资产 URL，避免请求体过大。
- Seedance 2.0/Fast/Mini/Ultra 的参考视频上限为 3 段、合计最多 15 秒；Seedance 2.5 为 10 段、合计最多 30 秒。数量由能力表校验，合计时长由 `ffprobe` 在提交供应商前校验；无法探测时不作“未超限”结论，但保留原有环境降级策略。
- 参考视频与首尾帧/多模态参考图的互斥组合仍由 Seedance 请求构造器拒绝，不能静默改成普通参考图。
- `POST /v1/audio/speech` 只是本地开发 Mock 的 OpenAI TTS 便利端点，不代表 AnyFast 提供该接口。

## 错误处理

- 创建接口的公开错误结构见 [API Introduction](https://docs.anyfast.ai/api-reference/introduction)；任务创建成功后仍可能在[任务查询指南](https://docs.anyfast.ai/guides/model-api/bytedance/seedance-task-query)所述的 `data.status = FAILURE` / `data.fail_reason` 通道失败，两条通道分别处理。
- AnyFast 可能把下游 `error` JSON 放进外层 `message` 字符串。适配器只解析有限层级，并优先使用下游稳定错误分类；原始请求 ID 和完整供应商响应只留在服务日志，不进入用户提示。
- 输入图片审核失败中的 `content[n]` 按本次已提交请求的 `role` 映射为首帧、尾帧或第 N 张参考图，不能把固定数组下标写死成某一种素材。
- 火山方舟公开的 `InputImageSensitiveContentDetected`、`InputTextSensitiveContentDetected` 与 `OutputVideoSensitiveContentDetected` 会转换为 ArcReel 稳定错误码并在读侧按语言渲染。具体证据边界与未知项见 `docs/research/anyfast-video-error-handling.md`。
- 代码：`lib/video_backends/anyfast.py::_provider_error_from_payload`、`lib/video_backends/base.py::VideoProviderError`、`server/routers/free_creations.py::_localize_creation`。
