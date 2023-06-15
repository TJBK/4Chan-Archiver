# 4chan Thread Downloader

This utility is an automated tool that searches for specific keywords on 4chan boards and optionally downloads all threads. It uses the 4chan API and downloads thread content (including images and videos) to a designated folder.

## Features

- Automated keyword search on all 4chan boards
- Rate-limited requests to prevent API bans
- Option to download all threads from every board
- SQLite3 database for keeping track of downloaded threads and media
- Generates JSON and HTML output files for each thread

## Requirements

- Node.js
- NPM

## Dependencies

- axios
- async-sema
- cheerio
- dotenv
- sqlite3

To install all dependencies, run:

```
npm install
```

## Configuration

Copy the `.env.example` file and create a new `.env` file with your desired configuration:

```
SEARCHTERM=keyword1,keyword2,keyword3
DOWNLOADFOLDER=./downloads
```

Replace the `SEARCHTERM` value with the desired keywords, separated by commas. Modify the `DOWNLOADFOLDER` value if you want to use a different directory for storing the downloaded threads.

To download all threads on 4chan, set the `downloadAll` constant in the code to `true`.

## Usage

Run the script using the following command:

```
npm start
```

The script will search for the specified keywords on all 4chan boards and download the matching threads to the specified folder. Downloaded threads will be named in format `<board>_<thread_no>_<title>` inside the download folder.

## License

MIT License
