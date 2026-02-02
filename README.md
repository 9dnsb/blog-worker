# Blog Worker

A standalone Express server that handles long-running blog generation using GPT-5.2. Deployed to Render's free tier to avoid Vercel's 10-second timeout.

## How It Works

1. Vercel backend receives blog generation request
2. Vercel fires off a request to this worker (without waiting)
3. Vercel returns immediately to the client
4. Worker runs GPT-5.2 (takes 20-40 seconds)
5. Worker updates MongoDB directly with the generated blog post
6. Client polls Vercel's GET endpoint to check completion status

## Deploy to Render

### 1. Create a new Web Service on Render

1. Go to [render.com](https://render.com) and sign in
2. Click "New" → "Web Service"
3. Connect your GitHub repo (or use "Public Git repository")
4. Configure:
   - **Name**: `blog-worker` (or whatever you want)
   - **Region**: Choose closest to your MongoDB
   - **Branch**: `main`
   - **Root Directory**: `blog-worker`
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Free

### 2. Add Environment Variables

In Render dashboard, go to your service → Environment:

| Variable | Value |
|----------|-------|
| `DATABASE_URI` | Your MongoDB connection string (same as Payload backend) |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `WORKER_SECRET` | Generate with `openssl rand -hex 32` |

### 3. Deploy

Click "Create Web Service". Render will build and deploy.

Note your service URL (e.g., `https://blog-worker-xxxx.onrender.com`)

### 4. Configure Vercel

Add these environment variables to your Vercel project:

| Variable | Value |
|----------|-------|
| `BLOG_WORKER_URL` | Your Render URL (e.g., `https://blog-worker-xxxx.onrender.com`) |
| `BLOG_WORKER_SECRET` | Same secret you used in Render |

Redeploy Vercel.

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your values

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## API Endpoints

### `GET /health`
Health check endpoint. Returns `{ status: "ok" }`.

### `POST /generate-blog`
Triggers blog generation.

**Headers:**
- `Authorization: Bearer <WORKER_SECRET>`
- `Content-Type: application/json`

**Body:**
```json
{
  "paperId": "...",
  "paperTitle": "...",
  "vectorStoreId": "..."
}
```

**Response:**
```json
{
  "success": true,
  "blogPostId": "...",
  "blogTitle": "...",
  "slug": "...",
  "duration": "25.3s"
}
```

## Notes

- Render free tier sleeps after 15 minutes of inactivity
- First request after sleep takes ~1 minute to spin up
- Consider using [UptimeRobot](https://uptimerobot.com) to ping `/health` every 5 minutes to keep it awake
- 512MB RAM is sufficient for this workload
