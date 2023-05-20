// Imports
require('dotenv').config()
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { Sema } = require('async-sema');
const sqlite3 = require('sqlite3').verbose();
const cheerio = require('cheerio');

// Constants
const rateLimiter = new Sema(1, { capacity: 1 }); // 1 request per second
const searchKeywords = process.env.SEARCHTERM;
const saveDirectory = process.env.DOWNLOADFOLDER;
const API_URL = 'https://a.4cdn.org/';
const searchInterval = 120 * 1000; // 2 minute interval between searches
const downloadAll = false; // Set this to true if you want to download all threads

// Database setup
const db = new sqlite3.Database('downloaded_threads.db');
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board TEXT NOT NULL,
      thread_no INTEGER NOT NULL,
      title TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board TEXT NOT NULL,
      thread_no INTEGER NOT NULL,
      post_no INTEGER NOT NULL,
      filename TEXT NOT NULL,
      ext TEXT NOT NULL,
      UNIQUE(board, thread_no, post_no, filename, ext) ON CONFLICT IGNORE
    )
  `);
});

// Functions

// Utility functions
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '');
}

// Rate-limited request
async function rateLimitedRequest(url, options = {}) {
  await rateLimiter.acquire();
  try {
    const response = await axios.get(url, options);
    // await delay(2000); // Introduce a 2-second delay
    return response;
  } finally {
    rateLimiter.release();
  }
}

// Main loop
async function mainLoop() {
  if (downloadAll) {
    // skip search and proceed to download all threads
    return downloadAllThreads();
  } else {
    for (const searchKeyword of searchKeywords) {
      console.log('Searching for keyword:', searchKeyword);
      await search4chan(searchKeyword);
    }
  }
  console.log('Search completed. Waiting for the next search interval...');
  setTimeout(mainLoop, searchInterval);
}

// Search 4chan
async function search4chan(searchQuery) {
  console.log('Fetching boards...');
  const boards = await getBoards();
  console.log(`Boards fetched: ${boards.join(', ')}`);

  console.log('Searching threads for the keyword...');
  const searchNormalized = normalizeText(searchQuery);

  for (const board of boards) {
    const matchedThread = await findThread(searchNormalized, board);
    if (matchedThread) {
      await downloadThreadContent(matchedThread);
    }
  }
}

// Generate HTML
function generateHTML(posts, board, outputPath) {
  const $ = cheerio.load('<!DOCTYPE html><html><head></head><body></body></html>');
  $('head').append(`<title>${board} - 4chan Thread</title>`);
  $('head').append(`<style>
    body {
      font-family: "Arial", sans-serif;
      font-size: 14px;
      color: #000;
      max-width: 800px;
      margin: 0 auto;
      padding: 16px;
      background-color: #FFFFEE;
    }
    h2 {
      text-align: center;
      margin-bottom: 16px;
    }
    .post {
      margin-bottom: 16px;
      border: 1px solid #D9BFB7;
      padding: 8px;
      background-color: #EED9B9;
    }
    .op.post {
      border: 2px solid #AA0000;
      background-color: #FFD6BF;
    }
    .post-content {
      display: inline-block;
      vertical-align: top;
    }
    .post-header {
      font-weight: bold;
      margin: 0 0 8px;
      color: #AA0000;
    }
    .post-info {
      display: inline-block;
      margin-right: 8px;
    }
    .post-image {
      max-width: 200px;
      display: inline-block;
      margin-right: 8px;
    }
    .quote {
      margin: 0;
      padding-left: 1em;
      color: #789922;
    }
  </style>`);

  const boardTitle = $('<h2></h2>').text(`/ ${board} / - 4chan Thread`);
  $('body').append(boardTitle);

  posts.forEach((post, index) => {
    const postDiv = $(`<div class="post${index === 0 ? ' op' : ''}" id="p${post.no}"></div>`);

    if (post.filename) {
      if (post.ext === '.webm') {
        postDiv.append(`
          <video class="post-image" controls>
            <source src="${post.filename}${post.ext}" type="video/webm">
            Your browser does not support the video tag.
          </video>
        `);
      } else {
        postDiv.append(`<img class="post-image" src="${post.filename}${post.ext}" alt="${post.filename}${post.ext}" />`);
      }
    }

    const postContent = $('<div class="post-content"></div>');
    const postHeader = $('<div class="post-header"></div>');
    if (post.name) postHeader.append(`<span class="post-info">Name: ${post.name}</span>`);
    if (post.sub) postHeader.append(`<span class="post-info">Subject: ${post.sub}</span>`);
    postHeader.append(`<span class="post-info">Date: ${formatDate(post.time)}</span>`);
    postHeader.append(`<span class="post-info">No. ${post.no}</span>`);

    postContent.append(postHeader);

    if (post.com) {
      const comment = $('<div></div>');
      comment.html(post.com);
      postContent.append(comment);
    }
    postDiv.append(postContent);

    $('body').append(postDiv);
  });

  fs.writeFileSync(outputPath, $.html());
}

// Date Format
function formatDate(timestamp) {
  const date = new Date(timestamp * 1000);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

// Get boards
async function getBoards() {
  const response = await rateLimitedRequest(`${API_URL}boards.json`);
  return response.data.boards.map((board) => board.board);
}

// Find thread
async function findThread(searchQuery, board) {
  console.log(`Searching board /${board}/ for keyword "${searchQuery}"...`);
  try {
    const response = await rateLimitedRequest(`${API_URL}${board}/catalog.json`);

    for (const thread of response.data.flatMap((page) => page.threads)) {
      if (
        thread.last_modified &&
        (normalizeText(thread.sub ?? '').includes(searchQuery) ||
          normalizeText(thread.com ?? '').includes(searchQuery))
      ) {
        console.log(
          `Matched thread in board /${board}/: ${JSON.stringify(thread)}`
        );
        // First check if thread is already downloaded
        const threadDownloaded = await isThreadDownloaded(board, thread.no);
        const options = {};
        if (threadDownloaded) {
          // If already downloaded, add If-Modified-Since header
          options.headers = { 'If-Modified-Since': new Date(thread.last_modified * 1000).toUTCString() };
        }
        const threadResponse = await rateLimitedRequest(`${API_URL}${board}/thread/${thread.no}.json`, options);

        // If the status code is 200 or 304 (for already downloaded threads), it is a target thread
        if (threadResponse.status === 200 || threadResponse.status === 304) {
          return { board, thread };
        }
      } else {
        console.log(
          `Thread /${board}/${thread.no} not matching keyword "${searchQuery}"`
        );
      }
    }
  } catch (error) {
    console.error(`Error searching board /${board}/:`, error);
  }

  console.log(`No matching thread found in board /${board}/.`);
  return null;
}

// Add this new function for downloading all threads
async function downloadAllThreads() {
  console.log('Fetching boards...');
  const boards = await getBoards();
  console.log(`Boards fetched: ${boards.join(', ')}`);

  console.log('Downloading all threads...');
  for (const board of boards) {
    const response = await rateLimitedRequest(`${API_URL}${board}/catalog.json`);
    for (const thread of response.data.flatMap((page) => page.threads)) {
      await downloadThreadContent({ board, thread });
    }
  }
}

// Download thread content
async function downloadThreadContent({ board, thread }) {
  console.log(`Downloading content from /${board}/${thread.no}...`);
  const title = thread.sub ? thread.sub.replace(/[^a-zA-Z0-9\-_]/g, '_') : '';
  const folderName = `${board}_${thread.no}_${title}`;
  const outputPath = path.join(saveDirectory, folderName);

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  try {
    const response = await axios.get(`${API_URL}${board}/thread/${thread.no}.json`);
    const posts = response.data.posts;

    fs.writeFileSync(
      path.join(outputPath, `${folderName}.json`),
      JSON.stringify(posts, null, 2)
    );

    generateHTML(posts, board, path.join(outputPath, `${folderName}.html`));

    db.serialize(() => {
      const insertStmt = db.prepare(`INSERT INTO threads (board, thread_no, title) VALUES (?, ?, ?)`);
      insertStmt.run([board, thread.no, title]);
      insertStmt.finalize();
    });

    const mediaPromises = [];
    for (const post of posts) {
      if (post.filename) {
        const url = `https://i.4cdn.org/${board}/${post.tim}${post.ext}`;
        const outputPath = path.join(saveDirectory, folderName, `${post.filename}${post.ext}`);

        // Only download if media is not already downloaded
        mediaPromises.push(
          isMediaDownloaded(board, post.no, post.filename, post.ext).then((downloaded) => {
            if (!downloaded) {
              return downloadMedia(url, outputPath).then(() =>
                rememberDownloadedMedia(board, thread.no, post.no, post.filename, post.ext)
              );
            }
          })
        );
      }
    }

    await Promise.all(mediaPromises);
    console.log(`Thread downloaded: ${folderName}`);
  } catch (error) {
    console.error(`Error downloading thread /${board}/${thread.no}:`, error);
  }
}

// Check if thread is downloaded
async function isThreadDownloaded(board, threadNo) {
  return new Promise((resolve) => {
    db.get(`SELECT id FROM threads WHERE board = ? AND thread_no = ?`, [board, threadNo], (err, row) => {
      if (err) throw err;
      resolve(row !== undefined);
    });
  });
}

// Check if media is downloaded
async function isMediaDownloaded(board, postNo, filename, ext) {
  return new Promise((resolve) => {
    db.get(
      `SELECT id FROM media WHERE board = ? AND post_no = ? AND filename = ? AND ext = ?`,
      [board, postNo, filename, ext],
      (err, row) => {
        if (err) throw err;
        resolve(row !== undefined);
      }
    );
  });
}

// Remember downloaded media
function rememberDownloadedMedia(board, threadNo, postNo, filename, ext) {
  return new Promise((resolve) => {
    db.serialize(() => {
      const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO media (board, thread_no, post_no, filename, ext) VALUES (?, ?, ?, ?, ?)`
      );
      insertStmt.run([board, threadNo, postNo, filename, ext]);
      insertStmt.finalize(resolve);
    });
  });
}

// Download media
async function downloadMedia(url, outputPath) {
  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = fs.createWriteStream(outputPath);

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('close', resolve);
      writer.on('error', (error) => {
        fs.unlink(outputPath, () => reject(error));
      });
    });
  } catch (error) {
    console.error(`Error downloading media from ${url}:`, error);
  }
}

// Run the search loop indefinitely
mainLoop();

process.on('SIGINT', () => {
  console.log('Closing database and exiting...');
  db.close();
  process.exit(0);
});
