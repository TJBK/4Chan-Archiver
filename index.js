const axios = require('axios')
const fs = require('fs')
const path = require('path')
const Bottleneck = require('bottleneck')

const BOARD = '' // Replace with the board you want to scrape, e.g. 'b'
const SEARCH_TERM = '' // Replace term to search
const CHECK_INTERVAL = 15000 // Check for updates every 15 seconds
const SEARCH_THREADS_INTERVAL = 60000 // Search for new threads every 1 minutes

// Base URL for the 4chan API
const BASE_URL = 'https://a.4cdn.org/'
const IMAGE_URL = 'https://i.4cdn.org/'

// Create a rate limiter to avoid getting banned
// I don't know if this is really needed, but it's better to be safe than sorry
const limiter = new Bottleneck({
  minTime: 1000 // Limit to 1 request per second
})

const downloadedImages = new Set()
const watchedThreads = new Map()

function logWithTimestamp (message) {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`)
}

// Search for threads on the board that contain the search term
async function searchThreads (board, searchTerm) {
  try {
    const response = await limiter.schedule(() => axios.get(`${BASE_URL}${board}/catalog.json`))
    if (response.status === 200) {
      const pages = response.data
      const matchingThreads = []
      pages.forEach((page) => {
        page.threads.forEach((thread) => {
          const subject = thread.sub ? thread.sub.toLowerCase() : ''
          const comment = thread.com ? thread.com.toLowerCase() : ''
          if (subject.includes(searchTerm) || comment.includes(searchTerm)) {
            matchingThreads.push(thread.no)
          }
        })
      })
      return matchingThreads
    } else {
      logWithTimestamp(`Error fetching catalog data: Status ${response.status}`)
      return []
    }
  } catch (error) {
    logWithTimestamp(`Error fetching catalog data: ${error}`)
    return []
  }
}

// Generate HTML for a thread
function generateHTML(posts) {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thread</title>
<style>
body {
  font-family: Arial, sans-serif;
  background-color: #f0e0d6;
  color: #34363b;
  font-size: 14px;
  line-height: 1.6;
  margin: 20px;
}

.post {
  border: 1px solid #ccc;
  margin-bottom: 25px;
  padding: 10px;
  background-color: #f0e0d6;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  display: inline-block;
  width: calc(100% - 20px);
}

.post-header {
  font-size: 0.9em;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
}

.post img {
  max-width: 100%;
  display: block;
  margin-top: 8px;
  margin-bottom: 8px;
}

a {
  color: #34363b;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.subject {
  font-weight: bold;
  color: #cc1105;
}

.file-info {
  color: #789922;
  font-size: 0.8em;
  margin-bottom: 5px;
}

</style>
</head>
<body>
`;

  posts.forEach((post) => {
    const postId = post.no;
    const subject = post.sub ? `<span class="subject">${post.sub}</span>` : '';
    const comment = post.com ? post.com : '';
    const datetime = new Date(post.time * 1000).toLocaleString();
    const fileInfo = post.filename ? `File: <a href="${IMAGE_URL}${BOARD}/${post.tim}${post.ext}" target="_blank">${post.filename}${post.ext}</a> (${post.fsize} KB, ${post.w}x${post.h})` : '';

    html += `
<div class="post">
  <div class="post-header">
    <div>${subject} (No. ${postId})</div>
    <div>${datetime}</div>
  </div>
  <div class="file-info">${fileInfo}</div>
  ${post.tim ? `<img src="${IMAGE_URL}${BOARD}/${post.tim}${post.ext}" alt="Image ${postId}">` : ''}
  <div>${comment}</div>
</div>
`;
  });

  html += `
</body>
</html>
`;

  return html;
}

async function downloadThreadHTML (board, threadId, posts) {
  const threadFolder = `${board}_${threadId}`
  const threadHTMLPath = path.join(threadFolder, 'thread.html')

  const htmlContent = generateHTML(posts)

  fs.writeFile(threadHTMLPath, htmlContent, (err) => {
    if (err) {
      logWithTimestamp(`Error saving thread HTML for ${threadId}: ${err}`)
    } else {
      logWithTimestamp(`Thread HTML saved for ${threadId}`)
    }
  })
}

async function downloadThreadContent (board, threadId, posts) {
  const threadFolder = `${board}_${threadId}`
  const threadContentPath = path.join(threadFolder, 'thread_content.json')

  fs.writeFile(threadContentPath, JSON.stringify(posts, null, 2), (err) => {
    if (err) {
      logWithTimestamp(`Error saving thread content for ${threadId}: ${err}`)
    } else {
      logWithTimestamp(`Thread content saved for ${threadId}`)
    }
  })
}

async function downloadImages (board, threadId) {
  try {
    const response = await limiter.schedule(() => axios.get(`${BASE_URL}${board}/thread/${threadId}.json`))

    if (response.status === 200) {
      const posts = response.data.posts

      if (!fs.existsSync(`${board}_${threadId}`)) {
        fs.mkdirSync(`${board}_${threadId}`)
      }

      posts.forEach(async (post) => {
        if (post.tim && !downloadedImages.has(post.tim)) {
          downloadedImages.add(post.tim)
          const imageURL = `${IMAGE_URL}${board}/${post.tim}${post.ext}`
          const imagePath = path.join(`${board}_${threadId}`, `${post.tim}${post.ext}`)
          const writer = fs.createWriteStream(imagePath)
          const imageResponse = await axios.get(imageURL, { responseType: 'stream' })
          imageResponse.data.pipe(writer)

          writer.on('finish', () => {
            logWithTimestamp(`Image ${post.tim}${post.ext} downloaded`)
          })

          writer.on('error', (err) => {
            logWithTimestamp(`Error downloading image ${post.tim}${post.ext}: ${err}`)
          })
        }
      })
    } else {
      logWithTimestamp(`Error fetching thread data: Status ${response.status}`)
    }
  } catch (error) {
    logWithTimestamp(`Error fetching thread data: ${error}`)
  }
}

// Watch a thread for new posts
async function watchThread (board, threadId) {
  if (!watchedThreads.has(threadId)) {
    watchedThreads.set(threadId, null) // Set initial value to null
    logWithTimestamp(`Now watching thread: ${threadId}`)

    const response = await limiter.schedule(() =>
      axios.get(`${BASE_URL}${board}/thread/${threadId}.json`, {
        headers: {
          'If-Modified-Since': watchedThreads.get(threadId)
        },
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304
      })
    )

    if (response.status === 200) {
      const posts = response.data.posts
      if (!fs.existsSync(`${board}_${threadId}`)) {
        fs.mkdirSync(`${board}_${threadId}`)
      }

      downloadThreadContent(board, threadId, posts)
      downloadThreadHTML(board, threadId, posts)
      downloadImages(board, threadId, posts)
      // Update the If-Modified-Since value to the current date and time after the first successful request

      watchedThreads.set(threadId, new Date().toUTCString())
      let dynamicCheckInterval = CHECK_INTERVAL

      const updateThread = async () => {
        const response = await limiter.schedule(() =>
          axios.get(`${BASE_URL}${board}/thread/${threadId}.json`, {
            headers: {
              'If-Modified-Since': watchedThreads.get(threadId)
            },
            validateStatus: (status) => (status >= 200 && status < 300) || status === 304
          })
        )
        if (response.status === 200) {
          watchedThreads.set(threadId, new Date().toUTCString())
          const posts = response.data.posts
          downloadThreadContent(board, threadId, posts)
          downloadThreadHTML(board, threadId, posts)
          downloadImages(board, threadId, posts)
          // Reset dynamicCheckInterval to the minimum interval when a new post is found
          dynamicCheckInterval = CHECK_INTERVAL
        } else if (response.status === 304) {
          dynamicCheckInterval *= 2
          logWithTimestamp(`Thread ${threadId} not modified. Increasing check interval to ${dynamicCheckInterval}ms`)
        }
        // Schedule the next update using the dynamicCheckInterval
        setTimeout(updateThread, dynamicCheckInterval)
      }
      setTimeout(updateThread, dynamicCheckInterval)
    } else {
      logWithTimestamp(`Error fetching thread data: Status ${response.status}`)
    }
  }
}

// Start watching threads
(async () => {
  const threads = await searchThreads(BOARD, SEARCH_TERM)
  logWithTimestamp(`Found ${threads.length} threads containing "${SEARCH_TERM}".`)

  threads.forEach((threadId) => {
    watchThread(BOARD, threadId)
  })

  setInterval(async () => {
    logWithTimestamp('Searching for new threads...')
    const newThreads = await searchThreads(BOARD, SEARCH_TERM)
    newThreads.forEach((threadId) => {
      if (!watchedThreads.has(threadId)) {
        watchThread(BOARD, threadId)
      }
    })
  }, SEARCH_THREADS_INTERVAL)
})()
