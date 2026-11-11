# nativeType-open

从 NativeType 提取的独立 Chrome 扩展项目，版本为 `0.0.5`。

在 X 的发帖、回复、引用和私信输入框中，使用 Chrome 内置 Translator API 翻译当前草稿，展示预览，并在点击 Replace 后替换原文。语言和启用场景可在扩展设置中调整。

## 项目结构

```text
entrypoints/          后台、内容脚本和设置页入口
core/                 翻译会话和控制流程
platforms/            X 输入框适配
translators/          Chrome Translator API
languages/            语言配置与检测
settings/             设置与本地存储
analytics/            可选使用统计
ui/                   翻译浮层
packages/contracts/   扩展使用的本地事件协议包
tests/                测试与浏览器页面夹具
scripts/              商店截图脚本
store-assets/         隐私说明与商店截图
```

扩展源码位于项目根目录，所有本地依赖均包含在此项目中。

## 安装与开发

包管理器配置为 `pnpm 12.15.0`，Node.js 版本范围沿用 `>=20.19`。安装扩展需要桌面 Chrome 138 或更高版本。

```sh
cd /Users/apple/Desktop/Project/nativeType-open
pnpm install
pnpm dev
```

`pnpm install` 会通过原有的 `postinstall` 脚本执行 `wxt prepare`，生成 `.wxt` 中的类型与配置。

## 复测

依次执行类型检查、现有测试和生产构建。

```sh
pnpm typecheck
pnpm test
pnpm build
```

在 Chrome 的 `chrome://extensions` 页面开启开发者模式，选择“加载已解压的扩展程序”，加载本项目的 `dist/chrome-mv3` 目录。

1. 打开 X，输入中文并等待翻译预览。首次使用时按提示启用翻译并等待语言模型下载。
2. 点击 Replace，确认输入框内容替换为译文，并且能够继续编辑和撤销。
3. 在设置中切换语言和启用场景，分别检查发帖、回复、引用和私信输入框。
4. 检查统计开关默认关闭，关闭时翻译和替换仍正常。

`pnpm zip` 生成 `dist/nativetype-0.0.5-chrome.zip`。`pnpm screenshot:store` 使用原有截图流程，会先构建扩展并启动 Chrome。

## 统计配置

生产配置沿用 `.env.production` 中的公开 API 地址 `https://typewith.si/api`，可选统计在用户启用后向该 API 发送事件。

开发环境可将 `.env.development.example` 复制为 `.env.development.local`，配置独立的 HTTPS 测试 API。开发模式缺少有效配置时关闭统计上报。

## 许可证

沿用项目中的 MIT 许可证，见 `LICENSE`。
