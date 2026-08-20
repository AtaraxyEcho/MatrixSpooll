# anyfast

AnyFast 是通过自定义供应商 `anyfast-seedance` endpoint 接入的协议，不是内置 provider id。

- 总入口：[AnyFast API Introduction](https://docs.anyfast.ai/api-reference/introduction)
- 接口与能力：[Seedance 2.0 创建任务](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0)、[Seedance 2.5 创建任务](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-5)、[任务查询](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-task-query)
- 输入组合：[Seedance 2.0 指南](https://docs.anyfast.ai/guides/model-api/bytedance/seedance-2-0)
- 代码：`lib/custom_provider/endpoints.py::ENDPOINT_REGISTRY["anyfast-seedance"]`、`lib/video_backends/anyfast.py::AnyFastSeedanceBackend`

## 自由创作契约

- 请求按 `text → image_url → video_url → audio_url` 排序，并显式下发 `first_frame`、`last_frame`、`reference_image`、`reference_audio` 角色。
- Seedance 2.0 时长为 4–15 秒；Seedance 2.5 为 4–30 秒。比例、分辨率和引用上限按型号在 backend 中声明或校验。
- AnyFast 参考视频只接受公网 URL 或 `asset://` ID。ArcReel 当前标准视频请求只携带本地路径，因此该 endpoint 暂不声明参考视频能力，收到参考视频时直接失败，避免静默丢素材。
- `POST /v1/audio/speech` 只是本地开发 Mock 的 OpenAI TTS 便利端点，不代表 AnyFast 提供该接口。
