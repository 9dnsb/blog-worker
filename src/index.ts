import express from 'express'
import { MongoClient, ObjectId } from 'mongodb'
import OpenAI from 'openai'

const app = express()
app.use(express.json())

// Environment variables
const PORT = Number(process.env.PORT) || 3001
const MONGODB_URI = process.env.DATABASE_URI!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const WORKER_SECRET = process.env.WORKER_SECRET! // Shared secret for auth

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// MongoDB connection
let mongoClient: MongoClient | null = null

async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI)
    await mongoClient.connect()
    console.log('[WORKER] Connected to MongoDB')
  }
  return mongoClient.db()
}

/**
 * System prompt for blog generation
 */
const BLOG_SYSTEM_PROMPT = `You are a health and wellness blog writer. Your task is to transform academic research papers into engaging, accessible blog posts.

## CRITICAL FORMATTING RULES (MUST FOLLOW)

### Section Headers — ALWAYS include descriptive subtitles
Every section header MUST have a colon followed by a brief, engaging subtitle. Never use generic headers.

❌ WRONG: "## 🔬 The Problem"
✅ RIGHT: "## 🔬 The Problem: Parents Are Confused About Starting Solids"

❌ WRONG: "## 📈 The Results"
✅ RIGHT: "## 📈 The Results: Both Methods Are Equally Safe"

### Results Section — MANDATORY FORMAT

Group findings into logical categories with bold subheadings. Keep it scannable and accessible.

**Structure:**
1. Start with "The [intervention] delivered across the board" or similar engaging opener
2. Group related findings under bold subheadings like:
   - **The big wins:** (most impressive findings)
   - **Cholesterol:** or **Pain:** or other relevant category
   - **Other improvements:**
   - **What stayed the same:** (neutral findings)
   - **What didn't work:** (if applicable)

3. Use bullet points with this format:
   - **[Metric name]** dropped/improved/fell X% — [brief context if helpful]

4. Add relatable comparisons when possible:
   - "roughly what you'd expect from a low-dose statin"
   - "a big move for diet alone"
   - "similar to what exercise typically achieves"

5. End with a separate "**One important nuance**" or "**The real-world catch**" mini-section if there's adherence/compliance data worth highlighting.

NEVER use these in Results:
- Statistical notation: ±, P < .001, P > .05, confidence intervals
- Raw scale numbers without context (e.g., "0.73 lower on the LDL scale")
- Units inline: g/dL, mg/day, kg
- Study author names: "(Smith et al.)"
- Dense paragraphs — use bullet points

---

## Writing Style Guidelines

1. **Title Format**: Start with an emoji, then a catchy question format
   - Example: "🏃 Want to Run Faster? Try This Surprising Pre-Workout Snack"
   - Example: "💪 Struggling with Muscle Soreness? Science Has a Sweet Solution"

2. **Structure**: IMPORTANT - Follow this exact structure:

   a) **Citation Block** (REQUIRED - comes right after the title):
      Start with "Based on the [YEAR] study" followed by the paper title in quotes, authors (use "& others" if more than 3), journal name in italics, and DOI as a markdown hyperlink.

      Example: Based on the 2018 study "Portfolio Dietary Pattern and Cardiovascular Disease" by Jenkins, Kendall, & others in *Progress in Cardiovascular Diseases*. [Read the full paper](https://doi.org/10.1016/j.pcad.2018.05.004)

   b) **Hook paragraph**: 1-2 engaging sentences that capture why this matters

   c) **Section headers with emojis and subtitles**:
      - ## 🔬 The Problem: [Subtitle]
      - ## 📊 The Study: [Subtitle]
      - ## 📈 The Results: [Subtitle]
      - ## 🧠 How It Works: [Subtitle]
      - ## 🎯 What This Means for You: [Subtitle]
      - ## ⚠️ Caveats
      - ## 💡 The Bottom Line

3. **Tone**: Conversational, accessible, use "you" directly, avoid jargon

4. **Formatting**:
   - Use **bold** for key findings
   - Use horizontal rules (---) between sections
   - Keep paragraphs short (2-4 sentences)

5. **Length**: 500-600 words max

<uncertainty_and_ambiguity>
- If information is not clearly stated in the paper, acknowledge this limitation.
- Never fabricate statistics, percentages, or study details not found in the source material.
- When uncertain about specific numbers, use qualifiers like "approximately" or "the study suggests".
</uncertainty_and_ambiguity>

## Output Format
Return ONLY the markdown content. Start directly with the emoji title (e.g., "# 🏃 Want to Run Faster?..."), then immediately follow with the citation block.`

/**
 * Generate a URL-friendly slug from a title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
}

/**
 * Extract a meaningful excerpt from markdown content
 */
function extractExcerpt(markdown: string, maxLength: number = 500): string {
  const lines = markdown.split('\n')
  const paragraphs: string[] = []
  let currentParagraph = ''

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed) {
      if (currentParagraph) {
        paragraphs.push(currentParagraph)
        currentParagraph = ''
      }
      continue
    }

    if (trimmed.startsWith('#')) continue
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') continue
    if (trimmed.startsWith('>')) continue

    let cleaned = trimmed
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    if (cleaned.startsWith('- ') || cleaned.startsWith('* ') || /^\d+\.\s/.test(cleaned)) {
      cleaned = cleaned.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '')
    }

    currentParagraph += (currentParagraph ? ' ' : '') + cleaned
  }

  if (currentParagraph) {
    paragraphs.push(currentParagraph)
  }

  let excerpt = ''
  for (const para of paragraphs) {
    if (!para.trim()) continue

    if (excerpt.length + para.length + 1 > maxLength) {
      if (excerpt.length > 100) break
      const remaining = maxLength - excerpt.length - 1
      excerpt += (excerpt ? ' ' : '') + para.slice(0, remaining).trim()
      break
    }
    excerpt += (excerpt ? ' ' : '') + para
  }

  excerpt = excerpt.trim()
  if (excerpt.length >= maxLength - 10) {
    const lastPeriod = excerpt.lastIndexOf('. ')
    if (lastPeriod > excerpt.length * 0.6) {
      excerpt = excerpt.slice(0, lastPeriod + 1)
    } else {
      excerpt = excerpt.slice(0, maxLength - 3).trim() + '...'
    }
  }

  return excerpt
}

/**
 * Convert markdown to Lexical JSON format
 * Simplified version - creates basic paragraph/heading structure
 */
function markdownToLexical(markdown: string): object {
  const lines = markdown.split('\n')
  const children: object[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Skip empty lines
    if (!trimmed) {
      i++
      continue
    }

    // Horizontal rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      children.push({
        type: 'horizontalrule',
        version: 1,
      })
      i++
      continue
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const text = headingMatch[2]
      children.push({
        type: 'heading',
        tag: `h${level}`,
        version: 1,
        indent: 0,
        children: [{ type: 'text', text, version: 1 }],
      })
      i++
      continue
    }

    // List items
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
      const listItems: object[] = []
      const isOrdered = /^\d+\.\s/.test(trimmed)

      while (i < lines.length) {
        const listLine = lines[i].trim()
        const match = isOrdered
          ? listLine.match(/^\d+\.\s+(.+)$/)
          : listLine.match(/^[-*]\s+(.+)$/)

        if (!match) break

        listItems.push({
          type: 'listitem',
          version: 1,
          indent: 0,
          children: [
            {
              type: 'paragraph',
              version: 1,
              indent: 0,
              children: parseInlineFormatting(match[1]),
            },
          ],
        })
        i++
      }

      if (listItems.length > 0) {
        children.push({
          type: 'list',
          listType: isOrdered ? 'number' : 'bullet',
          tag: isOrdered ? 'ol' : 'ul',
          version: 1,
          children: listItems,
        })
      }
      continue
    }

    // Regular paragraph
    children.push({
      type: 'paragraph',
      version: 1,
      indent: 0,
      children: parseInlineFormatting(trimmed),
    })
    i++
  }

  return {
    root: {
      type: 'root',
      version: 1,
      children,
    },
  }
}

/**
 * Parse inline formatting (bold, italic, links)
 */
function parseInlineFormatting(text: string): object[] {
  const nodes: object[] = []
  let remaining = text

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/)
    if (boldMatch) {
      nodes.push({ type: 'text', text: boldMatch[1], format: 1, detail: 0, mode: 'normal', style: '', version: 1 })
      remaining = remaining.slice(boldMatch[0].length)
      continue
    }

    // Italic
    const italicMatch = remaining.match(/^\*([^*]+)\*/)
    if (italicMatch) {
      nodes.push({ type: 'text', text: italicMatch[1], format: 2, detail: 0, mode: 'normal', style: '', version: 1 })
      remaining = remaining.slice(italicMatch[0].length)
      continue
    }

    // Link
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (linkMatch) {
      nodes.push({
        type: 'link',
        version: 3,
        direction: 'ltr',
        format: '',
        indent: 0,
        fields: {
          url: linkMatch[2],
          newTab: false,
          linkType: 'custom',
        },
        children: [{ type: 'text', text: linkMatch[1], format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
      })
      remaining = remaining.slice(linkMatch[0].length)
      continue
    }

    // Plain text up to next special char
    const nextSpecial = remaining.search(/[\*\[]/)
    if (nextSpecial === -1) {
      nodes.push({ type: 'text', text: remaining, format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
      break
    } else if (nextSpecial === 0) {
      // Special char not part of formatting, treat as text
      nodes.push({ type: 'text', text: remaining[0], format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
      remaining = remaining.slice(1)
    } else {
      nodes.push({ type: 'text', text: remaining.slice(0, nextSpecial), format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
      remaining = remaining.slice(nextSpecial)
    }
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text: '', format: 0, detail: 0, mode: 'normal', style: '', version: 1 }]
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Blog generation endpoint
app.post('/generate-blog', async (req, res) => {
  const startTime = Date.now()

  // Verify authorization
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${WORKER_SECRET}`) {
    console.log('[WORKER] Unauthorized request')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { paperId, paperTitle, vectorStoreId } = req.body

  if (!paperId || !paperTitle || !vectorStoreId) {
    return res.status(400).json({ error: 'Missing required fields: paperId, paperTitle, vectorStoreId' })
  }

  console.log(`[WORKER] Starting blog generation for paper: ${paperId}`)

  try {
    const db = await getDb()
    const papersCollection = db.collection('papers')
    const blogPostsCollection = db.collection('blog-posts')
    const usersCollection = db.collection('users')

    // Helper to update progress in MongoDB (for SSE to pick up)
    const updateProgress = async (message: string) => {
      await papersCollection.updateOne(
        { _id: new ObjectId(paperId) },
        { $set: { blogGenerationProgress: message } }
      )
    }

    // Update paper status to generating
    await papersCollection.updateOne(
      { _id: new ObjectId(paperId) },
      { $set: { blogGenerationStatus: 'generating', blogGenerationError: null, blogGenerationProgress: 'Starting blog generation...' } }
    )

    // Wait for vector store to be ready (files indexed)
    console.log('[WORKER] Checking vector store status...')
    await updateProgress('Checking vector store status...')
    let attempts = 0
    const maxAttempts = 120 // 2 minutes max wait (large PDFs can take a while)
    while (attempts < maxAttempts) {
      const vs = await openai.vectorStores.retrieve(vectorStoreId)
      if (vs.file_counts.in_progress === 0) {
        console.log(`[WORKER] Vector store ready (${vs.file_counts.completed} files indexed)`)
        await updateProgress(`Vector store ready (${vs.file_counts.completed} files indexed)`)
        break
      }
      console.log(`[WORKER] Vector store indexing: ${vs.file_counts.in_progress} files in progress, waiting...`, JSON.stringify(vs.file_counts))
      await updateProgress(`Indexing files... (${vs.file_counts.in_progress} remaining)`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
    }
    if (attempts >= maxAttempts) {
      throw new Error('Vector store indexing timed out after 2 minutes')
    }

    // Generate blog using OpenAI Responses API
    const userMessage = `Please read and analyze the attached academic paper titled "${paperTitle}" using the file_search tool. Then write a blog post about it following the style guidelines in your instructions.

Focus on:
1. The main research question and why it matters
2. The methodology and participants
3. The key findings with specific numbers
4. The practical implications for readers

Remember to use the exact section structure and emoji headers specified in your instructions.`

    console.log('[WORKER] Calling GPT-5.2 Responses API...')
    await updateProgress('Generating blog content with AI...')

    const response = await openai.responses.create({
      model: 'gpt-5.2',
      instructions: BLOG_SYSTEM_PROMPT,
      input: [{ role: 'user', content: userMessage }],
      tools: [
        {
          type: 'file_search',
          vector_store_ids: [vectorStoreId],
        },
      ],
      reasoning: {
        effort: 'low',
      },
      text: {
        verbosity: 'medium',
      },
      max_output_tokens: 4096,
    })

    const apiDuration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[WORKER] GPT-5.2 response in ${apiDuration}s, status: ${response.status}`)

    if (response.status !== 'completed') {
      throw new Error(`Response failed: ${response.status}`)
    }

    const markdownContent = response.output_text

    if (!markdownContent) {
      throw new Error('No text content in response')
    }

    console.log(`[WORKER] Content generated, length: ${markdownContent.length}`)
    await updateProgress('Processing generated content...')

    // Extract title from markdown
    const titleMatch = markdownContent.match(/^#\s+(.+)$/m)
    const blogTitle = titleMatch ? titleMatch[1].trim() : `Summary: ${paperTitle}`

    // Remove the title from content
    const contentWithoutTitle = markdownContent.replace(/^#\s+.+\n*/, '').trim()

    // Generate slug
    const baseSlug = generateSlug(blogTitle)
    const timestamp = Date.now()
    const slug = `${baseSlug}-${timestamp}`

    // Convert to Lexical
    const lexicalContent = markdownToLexical(contentWithoutTitle)

    // Get admin user for author
    const adminUser = await usersCollection.findOne({ role: 'admin' })
    if (!adminUser) {
      throw new Error('No admin user found to set as author')
    }

    // Extract excerpt
    const excerpt = extractExcerpt(contentWithoutTitle)

    // Create blog post
    await updateProgress('Creating blog post in database...')
    const blogPostResult = await blogPostsCollection.insertOne({
      title: blogTitle,
      slug,
      content: lexicalContent,
      excerpt,
      publishedDate: new Date().toISOString(),
      author: adminUser._id,
      sourcePaper: new ObjectId(paperId),
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const blogPostId = blogPostResult.insertedId

    // Update paper with success
    await papersCollection.updateOne(
      { _id: new ObjectId(paperId) },
      {
        $set: {
          generatedBlogPost: blogPostId,
          blogGenerationStatus: 'completed',
        },
      }
    )

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[WORKER] Blog created successfully: ${blogPostId} (${totalDuration}s total)`)

    res.json({
      success: true,
      blogPostId: blogPostId.toString(),
      blogTitle,
      slug,
      duration: `${totalDuration}s`,
    })
  } catch (error) {
    console.error('[WORKER] Error:', error)

    // Try to update paper with error status
    try {
      const db = await getDb()
      await db.collection('papers').updateOne(
        { _id: new ObjectId(paperId) },
        {
          $set: {
            blogGenerationStatus: 'error',
            blogGenerationError: error instanceof Error ? error.message : 'Unknown error',
          },
        }
      )
    } catch {
      // Ignore update errors
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Blog generation failed',
    })
  }
})

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WORKER] Blog worker running on port ${PORT}`)
})
