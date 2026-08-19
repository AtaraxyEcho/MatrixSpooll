# Stitch 与 AI 视频创作工作流审查

## 结论

Google 官方将 Stitch 定义为 AI 原生的无限设计画布：图片、文本和代码可以作为上下文进入画布，设计智能体跟踪项目演化，并通过自然语言或语音持续迭代。官方资料没有说明“完整对话记录固定在画布左上角”是 Stitch 的标准布局，因此 ArcReel 应借鉴其“上下文与画布同处一个工作空间”的思想，不复制未经证实的具体位置。

Runway 和 Google Flow 的公开工作流也不是单纯的聊天记录产品，而是将提示词、参考素材、生成结果、版本或镜头组织在同一创作上下文中。ArcReel 的自由创作画布、结构化素材用途、请求记录和可选智能体会话与这一方向一致，但自由创作基础版仍应保持直接视频请求与 Agent 会话分离。

## 一手资料

- Google Labs, [Introducing “vibe design” with Stitch](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-ai-ui-design/): 无限画布承载图片、文本和代码上下文；设计智能体理解项目演化；支持自然语言和语音迭代。
- Runway Help, [Creating with Gen-4 Image References](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References): 参考图可以拖入提示词画布或从资产中选择；临时素材属于当前会话；保存后的参考图可跨会话复用；生成结果可再次加载为参考图。
- Runway Help, [Building your first Workflows](https://help.runwayml.com/hc/en-us/articles/45769159004691-Building-your-first-Workflows): 节点连接输入输出，支持执行历史、恢复旧输出和把输出转为新节点。
- Google Labs, [5 tips for using Flow](https://blog.google/innovation-and-ai/products/flow-video-tips/): Ingredients、Frames to Video 和 Scenebuilder 分别承担一致性素材、起始画面和镜头编排。

## 对 ArcReel 的设计影响

1. 自由画布左上角可以放一个可收起的“当前会话摘要”浮层，展示当前提示词、引用数量、输出类型和最近一次请求状态。
2. 完整会话记录应使用抽屉或面板承载，不应永久占用无限画布空间。
3. 如果需要把对话放入画布，应放置“提示词/上下文卡片”作为可移动的世界空间节点，而不是把完整聊天时间线当作画布装饰。
4. `request_id` 记录直接视频生成请求；Agent session 只在用户主动打开智能体时创建，两者不能混为一个会话模型。
