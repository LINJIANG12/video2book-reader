# 课程精读（Course Reader）

把 [video2book-courses](https://github.com/LINJIANG12/video2book-courses) 的课程内容做成可精读的书架与阅读器。
**一套代码，三种装配**：PC 桌面（主）、静态网页（零安装分发）、安卓（后续）。

> [!TIP]
> ### 📖 静态在线体验站（免安装）
>
> [![在线阅读](https://img.shields.io/badge/在线阅读-课程精读%20Web%20站-0f766e?style=for-the-badge&logo=safari&logoColor=white)](https://linjiang12.github.io/video2book-reader/)
> [![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-已部署上线-10b981?style=for-the-badge&logo=github&logoColor=white)](https://linjiang12.github.io/video2book-reader/)
>
> 纯静态版本已持续部署在 GitHub Pages：[**https://linjiang12.github.io/video2book-reader/**](https://linjiang12.github.io/video2book-reader/)  
> 开箱即用，内置全库 26 门课程书架、241 册教材、212 篇复习笔记与 1353 份逐字稿，Typora 标题自动多级编号、KaTeX 公式秒级渲染与多端全景自适应排版。

## 先读文档

设计与决策都在 [`docs/`](docs/)，**实现以它们为准**：

| 文档 | 内容 |
|---|---|
| [00-架构总纲](docs/00-架构总纲.md) | 唯一上位依据：架构、技术选型、结构不变量、路线图、风险 |
| [01-插件与端口契约](docs/01-插件与端口契约.md) | 插件单元、六个贡献点、五个能力端口 |
| [02-数据模型](docs/02-数据模型.md) | 会话三原语、划词引用、IndexedDB 表、自定义模型 |
| [03-阅读器设计](docs/03-阅读器设计.md) | **主功能**：渲染管线、学习要素标注、排版、性能 |
| [04-学习交互设计](docs/04-学习交互设计.md) | 划词引用、上下文组装与缓存、学习技能 |
| [05-构建环境与工具链](docs/05-构建环境与工具链.md) | **动手前必读**：本机缺什么、怎么装、踩过哪些坑 |

## 构建前必须准备（一次性）

**本机目前没有 C/C++ 工具链，而 Tauri 必须编译 Rust。** 在**管理员**终端执行：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

细节与已否掉的替代路线见 [docs/05](docs/05-构建环境与工具链.md)。

## 常用命令

```bash
pnpm install                 # 装依赖（工作区用 node-linker=hoisted，见 .npmrc）

pnpm dev                     # 只起前端（浏览器里调 UI，最快）
pnpm stream-server           # 本地 SSE 夹具，供流式验证用

cd apps/desktop
pnpm tauri dev               # 起桌面应用（需要 MSVC）

# M0 的流式验收：窗口会自动跑一次并把结论回传，在 stream-server 的终端里看 [REPORT PASS]
VITE_AUTOTEST=1 pnpm tauri dev
```

## 目录

```
packages/          核心包（M1 起逐步填入：reader / agent / plugin / ports / app）
plugins/           可拆装的业务模块（study = 学习交互；删掉整个目录项目仍能跑）
apps/desktop/      PC 壳：Tauri 2 + React，含能力端口的实现
github-web/        GitHub 静态阅读站（顶层独立文件夹，含自己的部署工作流）
scripts/           开发期夹具与一次性工具
docs/              设计与决策文档
```

## 一条硬约束

阅读是主功能，AI 是次要功能。**`packages/reader` 不得依赖 agent、插件、端口实现或任何壳**——
静态版就是靠"换掉 2 个端口 + 换 `StorePort` 装配"得到的，阅读功能一行不改。
详见 [docs/00 §4 结构不变量](docs/00-架构总纲.md)。
