import { Hono } from 'hono'
import { cors } from 'hono/cors'

/**
 * AI Article Summary Cloudflare Worker
 * Hono Framework version
 */

const app = new Hono()

const CONFIG = {
  DEFAULT_READER_URL: 'https://r.jina.ai',
  DEFAULT_CLOUDFLARE_AI: '@cf/meta/llama-2-7b-chat-fp16',
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
  const content = await fetchContent(articleUrl)
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
  
  const provider = env.AI_PROVIDER?.toLowerCase()
  const model = env.AI_MODEL
  const apiKey = env.AI_API_KEY
  const prompt = (env.PROMPT_TEMPLATE || getDefaultPrompt(env.SUMMARY_MIN_LENGTH)).replace(/\${language}/g, languageCode)

  if (provider === 'cloudflare') {
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
  const required = ['AI_PROVIDER', 'AI_MODEL', 'ALLOWED_DOMAINS', 'AI', 'DB']
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

async function fetchContent(url) {
  try {
    const res = await fetch(`${CONFIG.DEFAULT_READER_URL}/${url}`)
    if (res.ok) return await res.text()
    
    // Direct fallback
    const direct = await fetch(url)
    if (!direct.ok) throw new Error(`Fetch failed: ${direct.status}`)
    const html = await direct.text()
    const title = html.match(/<title>(.*?)<\/title>/)?.[1] || 'No Title'
    const body = html.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1]?.replace(/<[^>]+>/g, '') || 'No content'
    return `# ${title}\n\n${body}`
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
  return `You are a professional content analyst and polyglot expert. Your goal is to provide a high-quality, structured summary of the provided text in the target language specified by code: "\${language}".

### Output Requirements:
1. **Language**: Exclusively use the language corresponding to code: "\${language}" (e.g., if code is "zh-CN", use Simplified Chinese).
2. **Format**: Plain text with a clear, logical structure (use simple headers or bullet points).
3. **Length**: 2-3 concise paragraphs, totaling at least ${minLength} words.
4. **Style**: Objective, professional, and insightful.

### Content Structure:
- **TL;DR**: A 1-2 sentence hook summarizing the "core essence" of the article.
- **Key Takeaways**: Identifies 3-4 critical points, data, or arguments.
- **Context/Conclusion**: Briefly explain the significance or the "so what" of the content.

### Guidelines:
- Keep technical terms, names, and brands in their original language if appropriate.
- Maintain factual accuracy; do not hallucinate details.
- Avoid generic filler; every sentence should add value.
- If the content is an opinion piece, capture the author's primary stance.`;
}

export default app
