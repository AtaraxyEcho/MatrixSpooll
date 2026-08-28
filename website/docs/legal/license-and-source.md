---
id: license-and-source
title: 许可证、来源与源码获取
sidebar_position: 1
update_docs: engine-b
---

# 许可证、来源与源码获取 {#license-and-source}

MatrixSpooll 是 ArcReel 的修改版本，整体依据 GNU Affero General Public License v3.0（AGPL-3.0）提供。交付、内部部署或商业定制不会取消许可证赋予接收方和网络用户的权利。

## 项目来源 {#project-origin}

界面中的“关于”页面会持续显示 `NOTICE` 要求的原项目署名与来源链接，并标明 MatrixSpooll 是修改版本、修改者和相关修改日期。分发源码或镜像时必须同时保留根目录中的 `LICENSE` 和 `NOTICE`。

## 获取当前部署版本源码 {#obtain-source}

登录 MatrixSpooll 后，从用户菜单进入 **关于**。当管理员已为当前版本发布源码包时，该页面会显示版本号、SHA-256 和下载入口。

源码包与部署版本必须一一对应。运维人员应在每次发布前运行：

```bash
uv run python scripts/build_source_release.py
```

生成的文件位于 `deploy/production/legal-source/`，包括版本化 ZIP、`source-manifest.json` 和 `SHA256SUMS`。生产 Compose 会把该目录只读挂载到应用。不要把 `.env`、数据库、项目媒体、日志、证书或供应商凭证放入源码包。

## 客户交付 {#customer-delivery}

客户可以接收完整源码和部署服务，无需把源码放到公开仓库。部署运营方仍应确保所有通过网络使用该版本的授权用户能够免费取得当前对应源码。客户后续再修改或向第三方分发时，也应继续遵守 AGPL-3.0 与 `NOTICE`。

本页是实施说明，不是法律意见；有争议的交付边界应由具备资质的法律顾问结合实际合同和部署方式确认。
