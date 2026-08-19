# ark

火山方舟标准 `/api/v3` 媒体 provider。

- 总入口：[火山方舟文档](https://www.volcengine.com/docs/82379/?lang=zh)
- 接口与能力：[对话 Chat API](https://api.volcengine.com/api-docs/view?action=ChatCompletions&serviceCode=ark&version=2024-01-01)、[图片生成 API](https://www.volcengine.com/docs/82379/1666946?lang=zh)、[创建视频生成任务](https://www.volcengine.com/docs/82379/1520757?lang=zh)
- 计费：[火山方舟定价](https://www.volcengine.com/pricing?product=ark_bd&tab=1)
- 代码：`lib/config/registry.py::PROVIDER_REGISTRY["ark"]`、`lib/text_backends/ark.py::ArkTextBackend`、`lib/image_backends/ark.py::ArkImageBackend`、`lib/video_backends/ark.py::ArkVideoBackend`

## 自由创作契约

- Seedance 固定比例由 backend 声明为 `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`，自由创作能力接口与入队预检共用该声明。
- Seedance 2.x 的远端 API 支持参考视频，但参考视频只接受可公开访问的 URL 或资产 ID，不接受 Base64。MatrixSpooll 当前自由项目引用是项目内本地路径，因此 Ark 暂不声明本地 `reference_videos` 能力，避免界面放行后静默丢弃。
- 核对来源：[BytePlus ModelArk 视频生成 API](https://docs.byteplus.com/en/docs/modelark/1520757)。
