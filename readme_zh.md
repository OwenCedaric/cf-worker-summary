# AI 网页文章摘要 Cloudflare Worker

这个 Cloudflare Worker 提供了一个 API 端点，用于使用各种 AI 提供商来summarize网络文章。它支持 OpenAI、Anthropic、Google 和 Cloudflare 的 AI 服务。该 worker 可以生成多语言摘要，并包括缓存和速率限制等功能。

## 功能

- 支持允许域名的网络文章摘要化
- 多模型支持：OpenAI、Anthropic、Google、Cloudflare AI
- **工程化架构**：基于 [Hono](https://hono.dev/) 框架，提供标准的路由与中间件支持
- **结构化输出**：自动生成 TL;DR、关键要点 (Key Takeaways) 和背景总结
- **高性能缓存**：采用 Stale-While-Revalidate 机制，后台异步更新
- 多语言自动检测与生成
- 自动截断长文本，支持自定义提示模板

## 设置

1. 克隆此仓库或将 worker 脚本复制到您的 Cloudflare Workers 项目中。
2. 设置所需的环境变量（见下文）。
3. 配置必要的 Cloudflare Worker 绑定（见下文）。
4. 将 worker 部署到您的 Cloudflare 账户。

## 环境变量

需要设置以下环境变量：

### 必填参数
- `ALLOWED_DOMAINS`：允许的文章 URL 域名列表，用逗号分隔（如 `*.example.com`）。

### 选填参数 (AI 配置)
- `AI_PROVIDER`：AI 服务提供商（`openai`, `anthropic`, `google` 或 `cloudflare`）。未指定时默认为 `cloudflare`。
- `AI_MODEL`：特定 AI 模型。未指定时默认为 `@cf/meta/llama-4-scout-17b-16e-instruct`。
- `AI_API_KEY`：AI 提供商的 API 密钥。如果模型提供商是 `cloudflare` 且已绑定 AI 资源，则无需此项。
- `AI_ENDPOINT`：AI API 的自定义端点 URL。
- `PROMPT_TEMPLATE`：AI 请求的自定义提示模板。

### 其他选填参数
- `CACHE_TTL`：缓存生存时间（以秒为单位，默认 604800，即 7 天）。
- `MAX_CONTENT_LENGTH`：允许处理的文章内容最大长度（默认 10000）。
- `SUMMARY_MIN_LENGTH`：生成摘要的最小字数需求（默认 200）。

### PROMPT_TEMPLATE

`PROMPT_TEMPLATE` 环境变量允许您自定义发送给 AI 的摘要指令。默认情况下，Worker 使用一个高度优化的**简体中文指令**，要求模型：
- **纯文本输出**：直接输出一段高质量的摘要，不使用任何 Markdown 语法。
- **深度总结**：包含 2-3 个核心要点，整理成一个连贯、专业的段落。
- **高稳定性**：这种模式在各种现代大模型上都能保证极高的输出一致性。

- **多语言支持**：如果自定义模板，建议保留 `${language}` 占位符以支持多语言。

## Cloudflare Worker 绑定

这个 Worker 需要特定的 Cloudflare Worker 绑定才能正常运行：

### AI 绑定

用于直接调用 Cloudflare 免费/付费的 AI 模型。
1. 在 Worker 设置中，添加 `AI` 绑定。

### D1 数据库绑定

用于缓存生成的摘要。

1. 在 Cloudflare D1 控制台中创建一个新的 D1 数据库。
2. 使用以下 SQL 语句创建所需的表：

   ```sql
   CREATE TABLE IF NOT EXISTS summaries (
     article_url TEXT NOT NULL,
     summary TEXT NOT NULL,
     model TEXT NOT NULL,
     language TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (article_url, language)
   );
   ```

3. 在您的 Worker 设置中，添加一个 D1 数据库绑定。
4. 将绑定命名为 `DB`。

### AI Worker 绑定（必须，仅适用于 Cloudflare AI）

您需要设置一个 AI Worker 绑定。

1. 确保您的 Cloudflare 账户已启用 AI 功能。
2. 在您的 Worker 设置中，添加一个 AI 绑定。
3. 将绑定命名为 `AI`。

## 部署

设置好所有必要的环境变量和绑定后，您可以部署您的 Worker：

1. 使用 Wrangler CLI：
   ```
   wrangler deploy
   ```
2. 或通过 Cloudflare 控制台上传您的 Worker 代码。

在部署之前，请确保您已正确配置了所有必要的绑定和环境变量。

## 使用方法

要使用 API，请向 worker 的 URL 发送 GET 请求，并包含以下查询参数：

- `url`：要摘要的文章 URL
- `lang`：（可选）摘要的语言。如果未提供，将根据 Accept-Language 头部确定，或默认为英语。

示例：

```
https://your-worker-url.workers.dev/summary?url=https://example.com/article&lang=zh
```

API 将返回一个 JSON 响应，结构如下：

```json
{
  "summary": "生成的文章摘要",
  "model": "用于摘要的 AI 模型"
}
```

## 多语言支持

Worker 支持生成多种语言的摘要。它会根据用户的请求参数或 `Accept-Language` 头部自动提取 BCP-47 语言代码（如 `zh-CN`, `en-US`），并将其直接传递给 AI 模型。现代大模型能够原生理解这些代码并输出对应语言的内容。

## 错误处理

API 将针对各种错误情况返回适当的错误消息和状态码，例如：

- 无效或缺失的文章 URL
- 来自非允许域名的文章
- 超过速率限制
- 内容过长
- AI API 错误

## 核心特性详解

### 基于 Hono 框架

本项目现使用 [Hono](https://hono.dev/) 框架重构。这为 Worker 带来了以下优势：
- **语义化路由**：使用 `app.get('/summary', ...)` 清晰定义 API 结构。
- **标准化 CORS**：内置中间件处理跨域请求，更符合安全规范。
- **上下文管理**：统一处理环境变量 (`c.env`) 和请求上下文。

### 缓存策略 (SWR)

摘要会被持久化存储在 D1 数据库中。
- **Stale-While-Revalidate**：如果缓存已过期（超过 `CACHE_TTL`），Worker 会先行返回旧的摘要给用户，并立即在后台异步触发新摘要的生成。
- 这种机制确保了用户始终能获得秒级的极速响应，同时也保证了内容的最终一致性。

## 内容获取

Worker 默认使用 [Jina Reader](https://r.jina.ai) 服务获取文章内容。如果失败，它会退回到直接获取 HTML 并提取内容。

## 安全考虑

- 确保正确设置 `ALLOWED_DOMAINS` 环境变量，以防止summarize未授权的网站。
- 保护您的 AI API 密钥安全，不要在代码或公共仓库中暴露它们。
- worker 实现了 CORS 头部。如果需要限制对特定来源的访问，请调整这些设置。

## 限制

- worker 只能summarize `ALLOWED_DOMAINS` 环境变量中指定的允许域名的文章。
- 可以处理的最大内容长度受 `MAX_CONTENT_LENGTH` 环境变量限制。
- 摘要的质量和准确性取决于所选择的 AI 提供商和模型。
- 所有提示模板无法在运行时动态修改。它们必须在部署 worker 之前设置为环境变量。

## 贡献

欢迎对改进 worker 的贡献。请在项目的仓库中提交问题和拉取请求。

## 许可协议

本项目根据 GNU Affero 通用公共许可证 v3.0（AGPLv3）授权。您可以根据 AGPLv3 的条款使用、修改和分发此软件。

完整的许可证文本可以在 `LICENSE` 文件中找到，或在以下链接查看：
[https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html)

### 主要许可条款

1. 您有运行、研究和修改程序的自由。
2. 您可以重新分发原始或修改版本的程序副本，前提是您遵守相同的许可证。
3. 如果您修改此软件以通过网络提供服务，您必须向服务接收者提供您修改的完整源代码。

有关您的权利和义务的更多信息，请参阅完整的 AGPLv3 许可证文本。
