import { Hono } from 'hono'
import { cors } from 'hono/cors'

/**
 * AI Article Summary Cloudflare Worker
 * Hono Framework version
 */

const app = new Hono()

const CONFIG = {
    DEFAULT_READER_URL: 'https://r.jina.ai',
    DEFAULT_CLOUDFLARE_AI: '@cf/meta/llama-4-scout-17b-16e-instruct',
}

// 1. Middleware
app.use('*', cors())

// 2. Routes
app.get('/summary', async (c) => {
    const env = c.env
    const articleUrl = c.req.query('url')
    const langCode = c.req.query('lang') || c.req.header('Accept-Language')?.split(',')[0].split(';')[0].trim() || 'en'

    if (!articleUrl) {
        return c.json({ error: 'Article URL is required' }, 400)
    }

    try {
        // Validation
        validateEnv(env)
        validateDomain(articleUrl, env.ALLOWED_DOMAINS)

        // Cache Check
        const cached = await getCache(env.DB, articleUrl, langCode)
        const ttl = parseInt(env.CACHE_TTL || 604800)
        const isStale = cached && (Date.now() - cached.created_at > ttl * 1000)

        if (cached && !isStale) {
            return c.json({ summary: cached.summary, model: cached.model })
        }

        // Generate Summary
        if (cached && isStale) {
            c.executionCtx.waitUntil(generateAndUpdateCache(env, articleUrl, langCode))
            return c.json({ summary: cached.summary, model: cached.model })
        }

        const result = await generateAndUpdateCache(env, articleUrl, langCode)
        return c.json({ summary: result.summary, model: result.model })

    } catch (error) {
        console.error('Worker error:', error)
        return c.json({ error: error.message }, error.status || 500)
    }
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

// --- Logic Modules ---

async function generateAndUpdateCache(env, articleUrl, langCode) {
    const content = await fetchContent(articleUrl, env)
    const aiResult = await generateSummary(env, content, langCode)

    if (!aiResult.summary) {
        throw new Error('AI failed to generate a summary')
    }

    const result = {
        summary: aiResult.summary,
        model: aiResult.model || env.AI_MODEL,
        created_at: Date.now()
    }

    await setCache(env.DB, articleUrl, result.summary, result.model, langCode)
    return result
}

async function generateSummary(env, content, languageCode) {
    const maxLength = parseInt(env.MAX_CONTENT_LENGTH || 10000)
    const truncatedContent = content.slice(0, maxLength)

    const provider = env.AI_PROVIDER?.toLowerCase() || 'cloudflare'
    const model = env.AI_MODEL || CONFIG.DEFAULT_CLOUDFLARE_AI
    const apiKey = env.AI_API_KEY
    const prompt = (env.PROMPT_TEMPLATE || getDefaultPrompt(env.SUMMARY_MIN_LENGTH)).replace(/\${language}/g, languageCode)

    if (provider === 'cloudflare' || (!apiKey && provider !== 'cloudflare')) {
        const res = await env.AI.run(model, {
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: truncatedContent }
            ]
        })
        return { summary: res.response || '', model }
    }

    const providers = {
        openai: {
            url: env.AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions',
            body: { model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: truncatedContent }] },
            extract: (d) => d.choices[0].message.content
        },
        anthropic: {
            url: env.AI_ENDPOINT || 'https://api.anthropic.com/v1/messages',
            headers: { 'anthropic-version': '2023-06-01' },
            body: { model, max_tokens: 1024, messages: [{ role: 'user', content: `System: ${prompt}\n\nUser: ${truncatedContent}` }] },
            extract: (d) => d.content[0].text
        },
        google: {
            url: env.AI_ENDPOINT || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            body: { system_instruction: { parts: { text: prompt } }, contents: { parts: { text: truncatedContent } } },
            extract: (d) => d.candidates[0].content.parts[0].text,
            noAuthHeader: true
        }
    }

    const config = providers[provider]
    if (!config) throw new Error(`Unsupported AI provider: ${provider}`)

    const response = await fetch(config.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(!config.noAuthHeader && { 'Authorization': `Bearer ${apiKey}` }),
            ...config.headers
        },
        body: JSON.stringify(config.body)
    })

    if (!response.ok) {
        const errText = await response.text()
        throw new Error(`AI API Error (${response.status}): ${errText.slice(0, 100)}`)
    }

    return { summary: config.extract(await response.json()), model }
}

// --- Utilities ---

function validateEnv(env) {
    const required = ['ALLOWED_DOMAINS', 'AI', 'DB']
    const missing = required.filter(k => !env[k])
    if (missing.length) throw new Error(`Missing bindings/vars: ${missing.join(', ')}`)
}

function validateDomain(url, allowedDomains) {
    const { hostname } = new URL(url)
    const allowed = allowedDomains.split(',').map(d => d.trim())
    const isAllowed = allowed.some(pattern =>
        pattern.startsWith('*.')
            ? hostname === pattern.slice(2) || hostname.endsWith('.' + pattern.slice(2))
            : hostname === pattern
    )
    if (!isAllowed) throw new Error('Domain not allowed')
}

async function fetchContent(url, env) {
    try {
        const isFile = /\.(pdf|docx|xlsx|pptx|odt|ods|odp|rtf|epub|csv)$/i.test(url)
        
        if (isFile) {
            const fileRes = await fetch(url)
            if (!fileRes.ok) throw new Error(`File fetch failed: ${fileRes.status}`)
            const blob = await fileRes.blob()
            const fileName = new URL(url).pathname.split('/').pop() || 'document'
            const { markdown } = await env.AI.toMarkdown({ 
                blob, 
                name: fileName,
                mimeType: blob.type 
            })
            return markdown
        }

        const res = await fetch(`${CONFIG.DEFAULT_READER_URL}/${url}`)
        if (res.ok) return await res.text()

        // Fallback to direct fetch and Cloudflare toMarkdown
        const direct = await fetch(url, {
            headers: { 'User-Agent': 'Cloudflare-Worker' }
        })
        if (!direct.ok) throw new Error(`Direct fetch failed: ${direct.status}`)
        
        const contentType = direct.headers.get('Content-Type') || ''
        if (contentType.includes('text/html')) {
            const htmlBlob = await direct.blob()
            const { markdown } = await env.AI.toMarkdown({ 
                blob: htmlBlob, 
                name: 'index.html', 
                mimeType: 'text/html' 
            })
            return markdown
        }
        
        return await direct.text()
    } catch (e) {
        throw new Error(`Content fetch error: ${e.message}`)
    }
}

async function getCache(db, url, lang) {
    return await db.prepare('SELECT summary, model, created_at FROM summaries WHERE article_url = ? AND language = ?')
        .bind(url || '', lang || 'en').first()
}

async function setCache(db, url, summary, model, lang) {
    await db.prepare('INSERT OR REPLACE INTO summaries (article_url, summary, model, language, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(url || '', summary || '', model || 'ai', lang || 'en', Date.now()).run()
}

function getDefaultPrompt(minLength = 200) {
    return `你是一位专业的内容分析专家。请你根据提供的文本内容，输出一段高质量、结构严谨的摘要。

### 要求：
1. **语言**：必须使用代码 "\${language}" 对应的语言进行输出。
2. **格式**：直接输出一段纯文本内容。**严禁**使用 Markdown 语法（如标题、列表、加粗等）。
3. **长度**：总结应包含 2-3 个核心要点，整理成一个连贯的段落，长度不少于 ${minLength} 字。
4. **风格**：客观、专业、有深度。

### 指南：
- 准确捕捉文章的核心观点和逻辑。
- 保持事实准确，严禁胡编乱造。
- 术语、品牌名和专有名词可保留原文。
- 避免使用空洞的描述性词汇，确保每一句话都有信息量。`;
}

export default app
