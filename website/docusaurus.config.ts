import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsSiteUrl = process.env.DOCS_SITE_URL ?? "http://localhost:3000";
const requestedBaseUrl = process.env.DOCS_BASE_URL ?? "/";
const docsBaseUrl = `/${requestedBaseUrl.replace(/^\/+|\/+$/g, "")}/`.replace("//", "/");
const configDir = dirname(fileURLToPath(import.meta.url));
const notice = readFileSync(resolve(configDir, "..", "NOTICE"), "utf8");
const legalAttribution = notice.match(/^"(Powered by .+?https:\/\/github\.com\/[^\s"]+)"$/m)?.[1];

if (!legalAttribution) {
  throw new Error("NOTICE does not contain a valid UI attribution");
}

const legalAttributionUrl = legalAttribution.match(/https:\/\/github\.com\/[^\s"]+$/)?.[0];
const legalAttributionHtml = legalAttributionUrl
  ? legalAttribution.replace(
      legalAttributionUrl,
      `<a href="${legalAttributionUrl}" rel="noreferrer">${legalAttributionUrl}</a>`,
    )
  : legalAttribution;

const config: Config = {
  title: "MatrixSpooll 文档中心",
  tagline: "开源、自托管的 AI 视频创作平台",
  favicon: "img/logo.jpg",

  url: docsSiteUrl,
  baseUrl: docsBaseUrl,

  organizationName: "MatrixSpooll",
  projectName: "MatrixSpooll",

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  markdown: {
    // .md 按 CommonMark 解析，只有 .mdx 走 MDX：文档正文里的 `<1.0.0`、`<域名>` 等
    // 尖括号片段在 MDX 下会被当成 JSX 而编译失败，且 CONTRIBUTING.md 还要在 GitHub 上原样可读
    format: "detect",
    // 配合 @docusaurus/theme-mermaid，把 ```mermaid 围栏渲染成图
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  i18n: {
    defaultLocale: "zh-Hans",
    locales: ["zh-Hans", "en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          // docs-only 模式：文档直接挂在站点根，因此 src/pages/index.* 不能存在（路由冲突）
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    "@docusaurus/theme-mermaid",
    [
      "@easyops-cn/docusaurus-search-local",
      {
        indexBlog: false,
        // docs-only 模式下须与 docs 的 routeBasePath 一致，否则索引为空
        docsRouteBasePath: "/",
        language: ["en", "zh"],
        hashed: true,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "MatrixSpooll",
      logo: {
        alt: "MatrixSpooll",
        src: "img/logo.jpg",
      },
      items: [
        {
          type: "localeDropdown",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "资源",
          items: [
            { label: "许可与来源", to: "/legal/license-and-source" },
            { label: "免责声明与使用条款", to: "/legal/disclaimer" },
          ],
        },
      ],
      copyright: `${legalAttributionHtml} · MatrixSpooll Copyright © 2026 AtaraxyEcho · AGPL-3.0.`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
