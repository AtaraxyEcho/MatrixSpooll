# AnyFast 模型能力矩阵

> 研究日期：2026-08-20  
> 数据来源：AnyFast 官方文档索引和 `api-reference/model-api` 页面。所有参数均以官方页面的请求契约为准；“未声明”表示该页面没有给出可安全用于 UI 的离散值，不应由前端猜测。

## 结论摘要

1. AnyFast 不是单一的视频接口。Seedance、HappyHorse、Wan、MiniMax、Kling、Sora 使用不同的请求路径、字段名和媒体角色，不能用一套固定的 `resolution/ratio/duration` 规则覆盖。
2. 视频模型的主要差异已经足以导致 UI 参数不匹配：例如 Seedance 2.0 支持 `4k`，Seedance 2.0 Mini 不支持 `1080p`，Seedance 2.0 Ultra 要求显式传 `720p/1080p/2k`，Seedance 2.5 支持 `4–30` 秒；Kling 2.6 只有 `5/10` 秒；Sora 2 的时长是字符串 `4/8/12`，尺寸是宽高字符串。
3. 首帧、尾帧、普通参考图、参考视频、参考音频必须按模型契约映射。不能看到 `first_frame=true` 就推断支持首尾帧组合，也不能把所有图片统一放进一个 `reference_images` 字段。
4. 官方页面没有提供一个稳定的“全模型能力 JSON”端点。建议将本表作为生成能力注册表的输入：内置模型使用版本化代码/快照，数据库只保存自定义模型或用户覆盖；不要在用户打开页面时实时抓取文档。

## 采集范围和判定规则

- 读取官方索引：[`llms.txt`](https://docs.anyfast.ai/llms.txt)。
- 批量读取 `api-reference/model-api` 下与视频、图片、音频/配音有关的页面；排除纯聊天模型、任务查询页和下载页。
- 表中的“输入角色”使用 ArcReel 的标准角色名：`first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio`。官方字段不同的模型必须在适配器中转换。
- “数量/素材上限”只记录官方明确声明的数量；未声明时显示“未声明”，不使用其他模型的默认值。
- `ratio`/`aspect_ratio`/`size`/`width+height` 是不同概念。UI 应根据模型适配器决定显示比例、分辨率还是尺寸输入。

## 视频模型

| 厂商 | AnyFast 模型 ID | 输入和工作流 | 输出分辨率 | 比例/尺寸 | 时长 | 数量与素材上限 | 音频、编辑和续写 | 官方契约 |
|---|---|---|---|---|---|---|---|---|
| ByteDance | `seedance-2.5` | 文生视频、首帧、首尾帧、多模态参考；`image_url`、`video_url`、`audio_url` 支持角色字段 | `480p`、`720p`、`1080p` | `21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`adaptive`；首帧/首尾帧/编辑要求 `adaptive` | `-1` 或 `4–30` 秒 | 最多 30 张图、10 个视频、10 个音频；视频和音频各自合计最多 30 秒；请求最多 51 个 content item | `generate_audio` 默认开启；支持编辑和续写 | [seedance-2-5](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-5.md) |
| ByteDance | `seedance-2.0` | 文生视频、首帧、首尾帧、多模态参考、编辑、续写 | `480p`、`720p`、`1080p`、`4k`（官方说明 4k 仅 2.0） | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive` | `4–15` 秒 | 参考图 0–9；最多 3 个视频、3 个音频（视频/音频文件各自 2–15 秒、50/15 MB） | `generate_audio` 默认开启；支持编辑、续写、联网搜索 | [seedance-2-0](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0.md) |
| ByteDance | `seedance-2.0-fast` | 与 Seedance 2.0 相同的文本、首帧/首尾帧、多模态参考、编辑、续写工作流 | `480p`、`720p`、`1080p` | 同 2.0：六种固定比例 + `adaptive` | `4–15` 秒 | 参考图 `0–9`，最多 3 个视频、3 个音频；视频和音频各自 2–15 秒、50/15 MB | 支持生成音频、编辑、续写、联网搜索 | [seedance-2-0-fast](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0-fast.md) |
| ByteDance | `seedance-2.0-mini` | 文生视频、首帧/首尾帧、多模态参考、编辑、续写 | `480p`、`720p`；官方明确不支持 `1080p` | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive` | `4–15` 秒 | 参考图 `0–9`，最多 3 个视频、3 个音频；视频和音频各自 2–15 秒、50/15 MB | 支持生成音频、编辑、续写、联网搜索 | [seedance-2-0-mini](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0-mini.md) |
| ByteDance | `seedance-2.0-ultra` | 文生视频、首帧/首尾帧、多模态参考、编辑、续写 | `720p`、`1080p`、`2k`；`resolution` 必填 | 六种固定比例 + `adaptive` | `4–15` 秒 | 参考图 `0–9`，最多 3 个视频、3 个音频；视频和音频各自 2–15 秒、50/15 MB | 支持生成音频、编辑、续写、联网搜索 | [seedance-2-0-ultra](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-0-ultra.md) |
| ByteDance | `doubao-seedance-1-5-pro-251215` | 文生视频、首帧/首尾帧；图片角色为 `first_frame`/`last_frame` | `480p`、`720p`、`1080p` | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`；文生视频不支持 `adaptive`，帧输入可用 | `4–12` 秒 | 页面未声明参考图数量；适配器必须限制为文档允许的内容数组 | `generate_audio` 可控，默认 `false`；页面未声明视频编辑/续写 | [doubao-seedance-1-5-pro](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedance-1-5-pro-251215.md) |
| ByteDance | `doubao-seedance-1-0-pro-250528` | 文生视频、首帧/首尾帧 | `480p`、`720p`、`1080p` | 六种固定比例；文生视频不支持 `adaptive` | `2–12` 秒 | 页面未声明参考图数量 | 页面未声明生成音频开关、编辑或续写 | [doubao-seedance-1-0-pro](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedance-1-0-pro-250528.md) |
| ByteDance | `doubao-seedance-1-0-pro-fast-251015` | 文生视频、首帧/首尾帧 | `480p`、`720p`、`1080p` | 六种固定比例；文生视频不支持 `adaptive` | `2–12` 秒 | 页面未声明参考图数量 | 页面未声明生成音频开关、编辑或续写 | [doubao-seedance-1-0-pro-fast](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedance-1-0-pro-fast-251015.md) |
| ByteDance | `doubao-seedance-1-0-lite-t2v-250428`、`doubao-seedance-1-0-lite-i2v-250428` | 文生视频；I2V 使用图片内容和 `first_frame`/`last_frame` | `480p`、`720p`、`1080p` | 六种固定比例；I2V 可用 `adaptive` | `2–12` 秒 | 页面未声明参考图数量 | 页面未声明生成音频、编辑或续写 | [doubao-seedance-1-0-lite](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedance-1-0-lite-250428.md) |
| Alibaba | `happyhorse-1.1-t2v`、`happyhorse-1.1-i2v`、`happyhorse-1.1-r2v` | T2V、I2V（必须一个 `first_frame`）、R2V（`reference_image`） | `720P`、`1080P` | T2V/R2V：`16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`4:5`、`5:4`、`9:21`、`21:9`；I2V 跟随首帧比例 | `3–15` 秒 | I2V 首帧恰好 1 张；R2V 参考图数量应按页面工作流校验 | 页面未声明生成音频、编辑或续写 | [happyhorse-1-1](https://docs.anyfast.ai/api-reference/model-api/alibaba/happyhorse-1.1.md) |
| Alibaba | `happyhorse-1.0-t2v`、`happyhorse-1.0-i2v`、`happyhorse-1.0-r2v`、`happyhorse-1.0-video-edit` | T2V、I2V、R2V、视频编辑；媒体角色包含 `video`、`reference_image` | `720P`、`1080P` | `16:9`、`9:16`、`1:1`、`4:3`、`3:4` | T2V/R2V `3–15` 秒；编辑工作流跟随源视频，参数可能不生效 | 编辑要求一个源视频；其他素材数量由工作流决定 | 支持视频编辑；未声明同步生成音频 | [happyhorse-1-0](https://docs.anyfast.ai/api-reference/model-api/alibaba/happyhorse-1.0.md) |
| Alibaba | `wan2.7-t2v`、`wan2.7-i2v`、`wan2.7-r2v` | T2V；I2V 支持 `first_frame`、`last_frame`、`first_clip`；R2V 支持 `reference_image`、`reference_video`、`first_frame`、参考声音 | `720P`、`1080P` | T2V/R2V：`16:9`、`9:16`、`1:1`、`4:3`、`3:4`；首帧输入时比例被忽略或跟随首帧 | `2–15` 秒；R2V 有参考视频时最大 `10` 秒 | I2V 每种媒体类型最多一个；R2V 媒体 1–6 个、图和视频合计不超过 5 个 | T2V 可传 2–30 秒 WAV/MP3；R2V 可传参考声音；页面未提供独立音频生成开关 | [wan2-7](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.7.md) |
| Alibaba | `wan2.2-t2v-a14b` | 文生视频，字段为 `prompt`、`duration`、`width`、`height` | 由 `width`/`height` 指定；官方页未给离散分辨率白名单 | 由宽高决定；未提供统一 `ratio` 枚举 | `3–5` 秒 | 不接受参考素材 | 未声明音频、编辑或续写 | [wan2-2-t2v-a14b](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.2-t2v-a14b.md) |
| Alibaba | `wan2.2-i2v-a14b` | I2V，必须传 `image` | 由 `width`/`height` 指定；官方页未给离散分辨率白名单 | 由宽高决定 | `3–5` 秒 | 一张参考图 | 未声明音频、编辑或续写 | [wan2-2-i2v-a14b](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.2-i2v-a14b.md) |
| MiniMax | `MiniMax-H3` | 文生视频、首帧/首尾帧、参考图/视频/音频；角色字段与 ArcReel 标准角色一致 | `768P`、`2K` | `adaptive`、`21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`；T2V 不允许 `adaptive` | `4–15` 秒 | 最多 1 首帧、1 尾帧、9 张参考图、3 个视频、3 个音频；跨类型最多 12 个；视频/音频各合计不超过 15 秒 | 接受参考音频；未声明同步生成音频、编辑或续写 | [minimax-h3](https://docs.anyfast.ai/api-reference/model-api/minimax/minimax-h3.md) |
| Kuaishou | `kling-3.0-turbo` | T2V、I2V；I2V 必须 `first_frame`，可选尾帧/多镜头 | `720p`、`1080p` | T2V `16:9`、`9:16`、`1:1`；I2V 跟随图片，比例参数不适用 | `3–15` 秒 | 多镜头最多 6 段；图片/视频参考数量由该升级 API 工作流限定 | 未声明独立音频开关 | [kling-v3-turbo](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v3-turbo.md) |
| Kuaishou | `kling-v3` | T2V、I2V、Omni；图片首帧/尾帧、参考视频、元素、最多两条 voice reference | 分辨率未声明 | `16:9`、`9:16`、`1:1` | `3–15` 秒；Omni 源视频编辑模式忽略时长 | I2V 至少一帧；Omni 无视频时图片+元素最多 7 个，有视频时最多 4 个；参考视频最多 1 个 | `sound=on/off`；支持声线引用、参考视频保留原声；支持多镜头、编辑 | [kling-v3](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v3.md) |
| Kuaishou | `kling-v2-6` | T2V、I2V、动作控制、voice 管理 | 分辨率未声明 | `16:9`、`9:16`、`1:1` | 仅 `5` 或 `10` 秒 | I2V 至少一张首/尾帧；动作控制图片模式源视频最多 10 秒、视频模式最多 30 秒 | `sound=on/off`；可使用最多两条 voice；支持动作控制 | [kling-v2-6](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v2-6.md) |
| Kuaishou | `kling-v2-5-turbo` | T2V、I2V | 分辨率未声明 | `16:9`、`9:16`、`1:1` | 仅 `5` 或 `10` 秒 | I2V 一张首帧；尾帧支持取决于模式 | 未声明音频生成 | [kling-v2-5-turbo](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v2-5-turbo.md) |
| Kuaishou | `kling-v2-1-master` | T2V、I2V | 文档仅在示例/参数中声明 `pro` 模式可用 `1080p`；完整分辨率枚举未声明 | `16:9`、`9:16`、`1:1` | 仅 `5` 或 `10` 秒 | 尾帧需要 `1080p` `pro` 模式 | 未声明音频生成 | [kling-v2-1-master](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v2-1-master.md) |
| Kuaishou | `kling-v2-1` | I2V | 分辨率枚举未声明 | 页面未声明统一比例字段 | 仅 `5` 或 `10` 秒 | 至少一张图片；尾帧需要 `1080p` `pro` 模式 | 未声明音频生成 | [kling-v2-1](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v2-1.md) |
| Kuaishou | `kling-v2-master` | T2V、I2V | 分辨率未声明 | `16:9`、`9:16`、`1:1` | 仅 `5` 或 `10` 秒 | I2V 参考图限制按工作流 | 未声明音频生成 | [kling-v2-master](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v2-master.md) |
| Kuaishou | `kling-video-o1` | Omni 视频生成与编辑，支持图片/视频/文本 | 分辨率未声明 | `16:9`、`9:16`、`1:1` | `3–10` 秒（源视频编辑可能跟随源视频） | 参考视频/图片数量按 Omni 工作流 | 支持视频编辑；音频开关未声明 | [kling-video-o1](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-video-o1.md) |
| OpenAI | `sora-2` | T2V、I2V；`input_reference` 作为首帧；可用 `remix_video_id` 复用已完成视频 | `720x1280`、`1280x720`、`1024x1792`、`1792x1024` | 通过尺寸表达比例，不再传 `ratio` | 字符串 `4`、`8`、`12` 秒 | 一张首帧参考图；视频复用通过已完成视频 ID | 未声明音频、首尾帧和独立续写 | [sora-2](https://docs.anyfast.ai/api-reference/model-api/openai/sora-2.md) |

## 图片模型

| 厂商 | AnyFast 模型 ID | 输入/编辑 | 输出尺寸或分辨率 | 比例/数量 | 官方限制和注意事项 | 官方契约 |
|---|---|---|---|---|---|---|
| ByteDance | `doubao-seedream-5-0-pro-260628` | T2I、I2I；I2I 支持最多 10 张参考图 | `1K`、`2K` 或显式像素尺寸；显式尺寸受总像素和比例限制 | 数量固定 1（页面警告不支持分组图生成） | 不要发送 `sequential_image_generation`；支持 png/jpeg，默认带水印 | [seedream-5-0-pro](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedream-5-0-pro-260628.md) |
| ByteDance | `seedream-5-0-lite-260128` | T2I、I2I、顺序图生成；I2I 支持多图 | `2K`、`3K`、`4K` 或官方支持的显式尺寸 | 顺序生成时使用 `max_images`；页面未给全局固定最大值，但参考图和产物有合计限制 | `sequential_image_generation=auto/disabled`；URLs 24 小时过期 | [seedream-5-0-lite](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedream-5-0-lite-260128.md) |
| ByteDance | `doubao-seedream-5-0-260128` | T2I、I2I、顺序图生成 | 页面未声明离散尺寸枚举 | 顺序生成使用 `max_images` | 允许多图编辑；具体像素白名单应从页面“尺寸限制”读取 | [seedream-5-0](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedream-5-0-260128.md) |
| ByteDance | `doubao-seedream-4-5-251128` | T2I、I2I、顺序图生成 | 官方列出多个固定像素尺寸，包含 1K–4K 档位 | 顺序生成使用 `max_images` | 不要把视频的 `resolution`/`duration` 参数发送到图片接口 | [seedream-4-5](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedream-4-5-251128.md) |
| ByteDance | `doubao-seedream-4-0-250828` | T2I、I2I、顺序图生成 | 官方固定尺寸列表从 `1024x1024` 到 `6240x2656`，包含 2K/4K 档位 | 顺序生成使用 `sequential_image_generation_options.max_images` | 支持多图编辑；尺寸必须从官方白名单选择 | [seedream-4-0](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedream-4-0-250828.md) |
| ByteDance | `doubao-seedream-3-0-t2i-250415` | 仅 T2I | 页面未声明统一尺寸枚举；“灵活尺寸”描述不能直接转换为 1.5K/2K/4K | 数量字段未声明 | UI 应隐藏参考图、视频、时长和比例控件，直到能力补充 | [seedream-3-0-t2i](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedream-3-0-t2i-250415.md) |
| Alibaba | `wan2.7-image`、`wan2.7-image-pro` | T2I、单图/多图编辑、区域编辑、顺序图生成 | 示例和请求使用 `2K`；完整尺寸枚举未统一声明 | 支持 `n`；顺序生成示例 `n=4` | `wan2.7-image-pro` 支持参考图、编辑、区域框和顺序生成；请求形态有 flat 与 nested 两种 | [wan2-7-image](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.7-image.md) |
| Alibaba | `wan2.6-t2i` | T2I | 由 `size` 指定，例如 `1024x1024`、`768x1344` | `n` 最小为 1；最大值未在页面摘要中给出 | 支持 `standard/hd` quality；不可使用视频参数 | [wan2-6-t2i](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.6-t2i.md) |
| Alibaba | `qwen-image-plus` | T2I | 由 `size` 指定，例如 `1024x1024`、`768x1344` | `n` 最小为 1；最大值未声明 | `quality=standard/hd`；返回 URL 或 Base64 | [qwen-image-plus](https://docs.anyfast.ai/api-reference/model-api/alibaba/qwen-image-plus.md) |
| Google | `gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`、`gemini-3-pro-image`、`gemini-2.5-flash-image`（含 stream/preview 变体） | 文本 + inline base64 图片参考；生成或编辑 | `imageSize`：`512`、`1K`、`2K`、`4K`（不同型号/变体需重新读取枚举） | `aspectRatio` 枚举由每页声明；请求以单次 `generateContent` 为主，数量不提供统一 `n` | 不能把 URL 直接当 `image_url`；需要 inline data；stream 变体只改变传输方式 | [gemini-3-1-flash-image](https://docs.anyfast.ai/api-reference/model-api/google/gemini-3.1-flash-image.md)、[gemini-3-pro-image](https://docs.anyfast.ai/api-reference/model-api/google/gemini-3-pro-image.md)、[gemini-2-5-flash-image](https://docs.anyfast.ai/api-reference/model-api/google/gemini-2-5-flash-image.md) |
| OpenAI | `gpt-image-2` | T2I | 任意 `widthxheight`；边长为 16 的倍数，总像素 655,360–8,000,000，比例不超过 3:1 | `n=1–10`，但 Direct 资源组要求 | `quality`、`output_format`、`moderation`；尺寸不是固定 480p/720p 档位 | [gpt-image-2](https://docs.anyfast.ai/api-reference/model-api/openai/gpt-image-2.md) |
| OpenAI | `gpt-image-2-c` | T2I | 与 GPT Image 2 相同的灵活尺寸 | 不支持 `n`，每次只能 1 张 | 支持 `response_format`；不能显示生成数量控件 | [gpt-image-2-c](https://docs.anyfast.ai/api-reference/model-api/openai/gpt-image-2-c.md) |
| OpenAI | `gpt-image-1.5`、`gpt-image-1` | T2I；对应页面支持编辑 | 页面声明为灵活尺寸/质量字段，未给统一 ArcReel 档位 | 数量、比例和尺寸应按各页面枚举 | 不能复用 GPT Image 2 的 `n` 上限 | [gpt-image-1-5](https://docs.anyfast.ai/api-reference/model-api/openai/gpt-image-1-5.md)、[gpt-image-1](https://docs.anyfast.ai/api-reference/model-api/openai/gpt-image-1.md) |
| Black Forest Labs | `flux-1.1-pro` | T2I | `size` 显式像素尺寸 | `n=1`；比例由尺寸决定 | 不要显示视频参数；页面返回 Base64 | [flux-1-1-pro](https://docs.anyfast.ai/api-reference/model-api/blackforestlabs/flux-1-1-pro.md) |
| Black Forest Labs | `flux-1-kontext-pro`、`flux-1-kontext-pro-edit` | T2I、I2I 编辑 | `size` 显式像素尺寸，例如 `1024x1024` | `n` 仅支持 1 | 编辑接口是 multipart；T2I 与编辑请求结构不同 | [flux-1-kontext-pro](https://docs.anyfast.ai/api-reference/model-api/blackforestlabs/flux-1-kontext-pro.md)、[flux-1-kontext-pro-edit](https://docs.anyfast.ai/api-reference/model-api/blackforestlabs/flux-1-kontext-pro-edit.md) |

## 音频、配音和视频后期相关接口

AnyFast 索引中没有一个可直接作为“独立音乐生成”模型的统一 `audio/generations` 页面。音频能力主要以视频模型的输入或输出开关存在：

| 能力 | 已确认的模型 | 约束 | 官方来源 |
|---|---|---|---|
| 同步生成音频 | Seedance 2.5、2.0 Mini/Ultra/Fast/2.0；Seedance 1.5 Pro | 使用 `generate_audio`；默认值和是否可控按模型页面读取 | [Seedance 2.5](https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-5.md)、[Seedance 1.5 Pro](https://docs.anyfast.ai/api-reference/model-api/bytedance/doubao-seedance-1-5-pro-251215.md) |
| 参考音频 | Seedance 2.x、MiniMax-H3、Wan2.7 R2V | 角色为 `reference_audio` 或供应商专用字段；数量和总时长按模型校验 | [MiniMax-H3](https://docs.anyfast.ai/api-reference/model-api/minimax/minimax-h3.md)、[Wan2.7](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.7.md) |
| 驱动/参考声音 | Wan2.7 I2V/R2V | I2V 使用 `driving_audio`，R2V 可在参考媒体上附 `reference_voice` | [Wan2.7](https://docs.anyfast.ai/api-reference/model-api/alibaba/wan2.7.md) |
| 声音/声线 | Kling 2.6、Kling 3 | `sound` 开关和 `voice_list`/voice ID 与视频模型绑定，不能当作独立 TTS 输出 | [Kling 2.6](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v2-6.md)、[Kling 3](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-v3.md) |
| 配音/唇形同步视频 | Kling Lip Sync | 输入现有视频和文本或音频，输出仍是视频；不是独立音频文件 | [Kling Lip Sync](https://docs.anyfast.ai/api-reference/model-api/kuaishou/kling-lip-sync.md) |
| 素材上传 | Seedance Asset API | 图片、视频、音频先上传为 `asset://ID`；视频支持 MP4/MOV、2–15 秒、≤50 MB，音频支持 WAV/MP3、≤15 MB | [Create Video Asset](https://docs.anyfast.ai/api-reference/model-api/bytedance/volc-asset-create-video.md)、[Create Audio Asset](https://docs.anyfast.ai/api-reference/model-api/bytedance/volc-asset-create-audio.md) |

## 对 ArcReel 能力注册表的建议

### 不要运行时抓取官方文档

官方页面会更新，且不同供应商的字段结构不同。用户打开生成器时联网抓文档会带来延迟、不可复现和供应商不可用时的错误。推荐流程：

1. 使用脚本定期读取 [`llms.txt`](https://docs.anyfast.ai/llms.txt) 和官方 Markdown，生成一份带 `source_url`、`fetched_at`、`content_hash` 的能力快照。
2. 人工确认 OpenAPI 枚举和工作流规则后，将内置模型能力编译进后端 provider/backend 注册表。视频能力放在与请求构造同源的 `VideoCapabilities`，图片能力放在模型注册表；不要在前端硬编码时长或分辨率。
3. 数据库只存自定义供应商、自定义模型和明确的管理员覆盖，并记录覆盖原因、更新时间和文档来源。数据库字段为空表示“未声明”，不能回退到另一个模型的值。
4. `/model-capabilities` 接口返回规范化能力和 `source_model`/`source_version`。切换模型时重新裁剪当前参数和素材角色；无法兼容时清楚提示，不静默删除或替换用户素材。
5. 能力快照可以做进程内缓存或 ETag 缓存，但缓存只缓存已审核的规范化结果，不缓存未经校验的网页内容。新模型或字段解析失败时应 fail loud，并把模型标记为“能力待确认”。

### 推荐的最小规范化结构

```json
{
  "provider": "anyfast",
  "model": "seedance-2.5",
  "source_url": "https://docs.anyfast.ai/api-reference/model-api/bytedance/seedance-2-5.md",
  "source_hash": "sha256:...",
  "output_type": "video",
  "modes": ["t2v", "first_frame", "first_last_frame", "reference_image", "reference_video"],
  "inputs": {
    "first_frame": {"types": ["image"], "max_count": 1},
    "last_frame": {"types": ["image"], "max_count": 1},
    "reference_image": {"types": ["image"], "max_count": 30},
    "reference_video": {"types": ["video"], "max_count": 10},
    "reference_audio": {"types": ["audio"], "max_count": 10}
  },
  "constraints": {
    "ratios": ["16:9", "9:16", "adaptive"],
    "resolutions": ["480p", "720p", "1080p"],
    "durations": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    "quantity": {"min": 1, "max": 1}
  },
  "features": {"generate_audio": true, "editing": true, "extension": true}
}
```

这里的 `modes`、`inputs` 和 `constraints` 必须由模型官方页面确认后填入。对于 Sora 2、Wan2.2、Kling Legacy 等字段结构不同的模型，适配器应保留原生请求映射，不能强行把 `size` 转成 `resolution` 或把字符串时长转成连续整数。

## 待补齐和风险清单

- Seedance 2.0 Fast/Mini/Ultra 的官方页面声明了多模态能力，但部分素材数量规则只在描述段落出现，建议实现前再从对应页面的 OpenAPI `content` schema 读取并写入注册表。
- Kling Legacy 的完整分辨率白名单在部分页面没有声明；未知型号仍隐藏分辨率。已确认的 `kling-v2-6` 适配器按 `std=720p`、`pro=1080p` 暴露这两个档位，其他未登记型号不得按名称猜测。
- `seedream-3.0-t2i`、GPT Image 1/1.5、部分 Gemini 图像变体未给出与 ArcReel 现有“比例/分辨率/数量”控件完全对应的离散枚举；在补齐前不应显示通用视频控件。
- AnyFast 文档中同时存在 `guides/model-api` 和 `api-reference/model-api` 两套路径。参数注册应以 API reference 页面为主，guide 只用于补充工作流说明。
- 本文记录的是官方页面当前声明，不代表供应商运行时一定接受所有组合。入队前仍需使用同一份能力注册表做模式、角色、数量、比例、分辨率和时长校验，并把供应商错误保留在任务元数据中。
