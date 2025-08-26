// server.js - Node.js Backend for X News Agent
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Environment variables
const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const USER_EMAIL = process.env.USER_EMAIL;

// OAuth 1.0a setup for X API
const oauth = OAuth({
  consumer: { key: X_API_KEY, secret: X_API_SECRET },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto
      .createHmac('sha1', key)
      .update(base_string)
      .digest('base64');
  },
});

// Email transporter setup
const emailTransporter = nodemailer.createTransporter({
  host: EMAIL_HOST,
  port: 587,
  secure: false,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// Agent state
let agentState = {
  isRunning: false,
  lastRun: null,
  stats: {
    totalRuns: 0,
    emailsSent: 0,
    postsProcessed: 0
  },
  logs: []
};

// Logging function
function addLog(message, type = 'info') {
  const log = {
    timestamp: new Date(),
    message,
    type
  };
  agentState.logs.unshift(log);
  agentState.logs = agentState.logs.slice(0, 100); // Keep last 100 logs
  console.log(`[${log.timestamp.toISOString()}] ${type.toUpperCase()}: ${message}`);
}

// Fetch X Timeline
async function fetchXTimeline() {
  try {
    addLog('📱 Fetching X timeline...', 'info');
    
    const requestData = {
      url: 'https://api.twitter.com/2/users/me/timelines/reverse_chronological',
      method: 'GET',
    };
    
    // Add OAuth signature
    const token = { key: X_ACCESS_TOKEN, secret: X_ACCESS_TOKEN_SECRET };
    const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
    
    const response = await fetch(requestData.url + '?max_results=50&tweet.fields=created_at,author_id,public_metrics&user.fields=username,verified&expansions=author_id&exclude=replies,retweets', {
      method: 'GET',
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      throw new Error(`X API Error: ${response.status} - ${response.statusText}`);
    }
    
    const data = await response.json();
    const posts = data.data || [];
    const users = data.includes?.users || [];
    
    // Map user data to posts
    const postsWithUserData = posts.map(post => {
      const author = users.find(user => user.id === post.author_id);
      return {
        ...post,
        author_username: author?.username || 'unknown',
        author_verified: author?.verified || false
      };
    });
    
    addLog(`✅ Retrieved ${postsWithUserData.length} timeline posts`, 'success');
    return postsWithUserData;
    
  } catch (error) {
    addLog(`❌ X API Error: ${error.message}`, 'error');
    throw error;
  }
}

// Analyze posts with Claude AI
async function analyzePostsWithAI(posts, minNewsRelevance = 0.7) {
  try {
    addLog('🤖 Starting AI analysis of posts...', 'info');
    
    const newsItems = [];
    
    for (const post of posts) {
      const prompt = `
        Analyze this X post for newsworthiness. Rate from 0-1 where 1 is breaking news.
        Consider: breaking news, market updates, tech developments, health research, political developments.
        
        Post: "${post.text}"
        Author: @${post.author_username}
        Verified: ${post.author_verified}
        
        Respond with JSON only:
        {
          "newsScore": number,
          "category": "Technology|Finance|Health|Politics|Sports|Entertainment|Science|Other",
          "isNews": boolean,
          "headline": "brief headline if newsworthy",
          "summary": "2-sentence summary if newsworthy"
        }
        
        DO NOT OUTPUT ANYTHING OTHER THAN VALID JSON.
      `;
      
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAUDE_API_KEY,
        },
        body: JSON.stringify({
          model: "claude-3-sonnet-20240229",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }]
        })
      });
      
      if (!response.ok) {
        addLog(`⚠️ Claude API error for post ${post.id}`, 'error');
        continue;
      }
      
      const data = await response.json();
      let responseText = data.content[0].text;
      
      // Clean response (remove markdown if present)
      responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      
      try {
        const analysis = JSON.parse(responseText);
        
        addLog(`📊 @${post.author_username}: ${post.text.substring(0, 50)}... | Score: ${analysis.newsScore} ${analysis.isNews ? '✓ NEWS' : '✗ Skip'}`, 'info');
        
        if (analysis.isNews && analysis.newsScore >= minNewsRelevance) {
          newsItems.push({
            ...analysis,
            originalPost: post,
            timestamp: post.created_at
          });
        }
      } catch (parseError) {
        addLog(`⚠️ Failed to parse AI response for post ${post.id}`, 'error');
      }
      
      // Rate limiting - wait between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    addLog(`✅ AI analysis complete. Found ${newsItems.length} newsworthy items.`, 'success');
    return newsItems;
    
  } catch (error) {
    addLog(`❌ AI Analysis Error: ${error.message}`, 'error');
    throw error;
  }
}

// Send news email
async function sendNewsEmail(newsItems) {
  try {
    addLog('📧 Generating email digest...', 'info');
    
    // Group news by category
    const categories = {};
    newsItems.forEach(item => {
      if (!categories[item.category]) categories[item.category] = [];
      categories[item.category].push(item);
    });
    
    // Generate email content
    const emailBody = `
Your X Timeline News Digest - ${new Date().toLocaleDateString()}

${Object.entries(categories).map(([category, items]) => `
${category.toUpperCase()} (${items.length} ${items.length === 1 ? 'story' : 'stories'})
${'-'.repeat(category.length + 10)}

${items.map(item => `• ${item.headline}
  ${item.summary}
  Source: @${item.originalPost.author_username}
`).join('\n')}
`).join('\n')}

---
Generated by your X News Agent
Total items analyzed: ${agentState.stats.postsProcessed}
News items found: ${newsItems.length}
Generated at: ${new Date().toLocaleString()}
    `;
    
    const mailOptions = {
      from: EMAIL_USER,
      to: USER_EMAIL,
      subject: `Your X News Digest - ${newsItems.length} stories`,
      text: emailBody,
    };
    
    await emailTransporter.sendMail(mailOptions);
    addLog(`✅ Email sent to ${USER_EMAIL}`, 'success');
    
  } catch (error) {
    addLog(`❌ Email Error: ${error.message}`, 'error');
    throw error;
  }
}

// Main agent cycle
async function runAgentCycle() {
  try {
    addLog('🔄 Starting new agent cycle...', 'info');
    
    // Step 1: Fetch X Timeline
    const posts = await fetchXTimeline();
    
    // Step 2: AI Analysis
    const newsItems = await analyzePostsWithAI(posts, 0.7);
    
    // Step 3: Send Email (if news found)
    if (newsItems.length > 0) {
      await sendNewsEmail(newsItems);
      agentState.stats.emailsSent++;
    } else {
      addLog('ℹ️ No significant news found this cycle. No email sent.', 'info');
    }
    
    // Update stats
    agentState.stats.totalRuns++;
    agentState.stats.postsProcessed += posts.length;
    agentState.lastRun = new Date();
    
    addLog(`⏱️ Next check scheduled in 4 hours.`, 'info');
    
  } catch (error) {
    addLog(`❌ Agent cycle failed: ${error.message}`, 'error');
  }
}

// API Routes
app.get('/api/status', (req, res) => {
  res.json(agentState);
});

app.post('/api/start', async (req, res) => {
  if (agentState.isRunning) {
    return res.json({ success: false, message: 'Agent already running' });
  }
  
  agentState.isRunning = true;
  addLog('🚀 Agent started via API', 'success');
  
  // Run first cycle immediately
  runAgentCycle();
  
  res.json({ success: true, message: 'Agent started successfully' });
});

app.post('/api/stop', (req, res) => {
  agentState.isRunning = false;
  addLog('⏹️ Agent stopped via API', 'info');
  res.json({ success: true, message: 'Agent stopped' });
});

app.get('/api/logs', (req, res) => {
  res.json(agentState.logs);
});

// Schedule agent to run every 4 hours
cron.schedule('0 */4 * * *', () => {
  if (agentState.isRunning) {
    addLog('⏰ Scheduled cycle triggered (every 4 hours)', 'info');
    runAgentCycle();
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`X News Agent Server running on port ${PORT}`);
  addLog(`🌐 Server started on port ${PORT}`, 'success');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  addLog('🔄 Server shutting down...', 'info');
  process.exit(0);
});