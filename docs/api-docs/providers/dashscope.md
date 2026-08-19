# dashscope

阿里云百炼 / DashScope 文本、图片、视频与 TTS 媒体 provider。

- 总入口：[DashScope API 概览](https://help.aliyun.com/zh/model-studio/getting-started/models)
- 接口与能力：[文本生成 API](https://help.aliyun.com/zh/model-studio/qwen-api-reference/)、[图像生成](https://help.aliyun.com/zh/model-studio/image-generation)、[Qwen-Image API](https://help.aliyun.com/zh/model-studio/qwen-image-api)、[Qwen-Image-Edit API](https://help.aliyun.com/zh/model-studio/qwen-image-edit-guide)、[Wan 图像生成与编辑 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)、[视频生成](https://help.aliyun.com/zh/model-studio/use-video-generation)、[Wan 文生视频](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)、[Wan 图生视频](https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference)、[Wan 参考生视频](https://help.aliyun.com/zh/model-studio/wan-video-to-video-api-reference)、[临时文件上传](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)、[HappyHorse 文生视频](https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference)、[图生视频](https://help.aliyun.com/zh/model-studio/happyhorse-image-to-video-api-reference)、[参考生视频](https://help.aliyun.com/zh/model-studio/happyhorse-reference-to-video-api-reference)、[Qwen TTS](https://help.aliyun.com/zh/model-studio/qwen-tts)
- 计费：[模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- 代码：`lib/config/registry.py::PROVIDER_REGISTRY["dashscope"]`、`lib/text_backends/openai.py::OpenAITextBackend`、`lib/image_backends/dashscope.py::DashScopeImageBackend`、`lib/video_backends/dashscope.py::DashScopeVideoBackend`、`lib/audio_backends/dashscope.py::DashScopeAudioBackend`

## 自由创作契约

- `wan2.7-r2v` 接受图片与视频参考，二者合计最多 5 个；本地 `.mp4`、`.mov` 先通过 DashScope 临时文件上传接口写入 OSS，再以 `oss://` 地址下发为 `reference_video`，任务请求同时携带 `X-DashScope-OssResourceResolve: enable`。
- 该型号声明比例 `16:9`、`9:16`、`1:1`、`4:3`、`3:4`，能力接口与入队预检共用同一 backend 声明。
- 带视频参考时输出时长为 2–10 秒；只有图片参考时仍使用型号登记的 2–15 秒档位。首页参数与入队预检按参考素材类型读取同一能力声明。
- 核对来源：[阿里云百炼 Wan 参考生视频 API](https://help.aliyun.com/zh/model-studio/wan-video-to-video-api-reference)。
